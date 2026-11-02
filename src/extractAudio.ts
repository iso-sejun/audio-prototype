import { createFile, MP4BoxBuffer, type Sample } from 'mp4box'

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

interface AacConfig {
  objectType: number
  rateIndex: number
  channels: number
}

interface AacTrack {
  frames: { data: Uint8Array; duration: number }[]
  timescale: number
  dsi: Uint8Array // AudioSpecificConfig
  config: AacConfig
  sampleRate: number
  edits: { duration: number; mediaTime: number }[] // in `timescale` units
}

// Reads the AudioSpecificConfig from the sample entry's esds box. In QuickTime
// files the esds can sit inside a "wave" box, so search the entry's children.
function dsiFromEntry(entry: unknown): Uint8Array | undefined {
  type Desc = { findDescriptor?: (tag: number) => Desc | undefined; data?: Uint8Array }
  type BoxLike = { type?: string; esds?: { esd?: Desc }; boxes?: BoxLike[] }
  const queue: BoxLike[] = [entry as BoxLike]
  while (queue.length) {
    const box = queue.shift()!
    const dsi = box.esds?.esd?.findDescriptor?.(4)?.findDescriptor?.(5)?.data
    if (dsi && dsi.length >= 2) return dsi
    queue.push(...(box.boxes ?? []))
  }
}

const parseDsi = (dsi: Uint8Array): AacConfig => ({
  objectType: dsi[0] >> 3,
  rateIndex: ((dsi[0] & 7) << 1) | (dsi[1] >> 7),
  channels: (dsi[1] >> 3) & 15,
})

// Pulls the AAC audio track's frames out of an MP4/MOV (e.g. an iPhone video).
function readAacTrack(data: ArrayBuffer): Promise<AacTrack> {
  return new Promise((resolve, reject) => {
    const file = createFile()
    const frames: AacTrack['frames'] = []
    let track: Omit<AacTrack, 'frames' | 'dsi' | 'config' | 'timescale'> | undefined
    let dsi: Uint8Array | undefined
    let timescale = 0
    let expected = 0
    let done = false
    const fail = (message: string) => {
      if (!done) reject(new Error(message))
      done = true
    }

    file.onError = (_module, message) => fail(`could not read container: ${message}`)
    file.onReady = (info) => {
      const t = info.audioTracks[0]
      if (!t) return fail('file has no audio track')
      if (!t.codec.startsWith('mp4a')) return fail(`unsupported audio codec ${t.codec}`)
      const sampleRate = t.audio?.sample_rate ?? 0
      const rateIndex = SAMPLE_RATES.indexOf(sampleRate)
      if (rateIndex >= 0) {
        // 2-byte AudioSpecificConfig for AAC-LC, in case the file doesn't carry one
        const channels = t.audio?.channel_count || 2
        dsi = new Uint8Array([(2 << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3)])
      }
      // Keep the track's edit list (e.g. encoder priming), converted from the
      // movie's timescale to the track's, so trigger times don't shift.
      const elst = file.getTrackById(t.id)?.edts?.elst?.entries ?? []
      const edits = elst.map((e) => ({
        duration: Math.round((e.segment_duration * t.timescale) / info.timescale),
        mediaTime: e.media_time,
      }))
      track = { sampleRate, edits }
      timescale = t.timescale
      expected = t.nb_samples
      file.setExtractionOptions(t.id, null, { nbSamples: 1000 })
      file.start()
    }
    file.onSamples = (_id, _user, samples: Sample[]) => {
      for (const s of samples) {
        if (!s.data) continue
        if (frames.length === 0) dsi = dsiFromEntry(s.description) ?? dsi
        frames.push({ data: s.data, duration: s.duration })
      }
      if (frames.length >= expected && !done) {
        done = true
        if (!dsi || !track) return reject(new Error('could not read the audio format'))
        resolve({ ...track, frames, timescale, dsi, config: parseDsi(dsi) })
      }
    }

    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, 0))
    file.flush()
    if (!done) fail(expected ? 'audio track was incomplete' : 'could not find the audio track')
  })
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function adtsHeader({ objectType, rateIndex, channels }: AacConfig, payloadLength: number) {
  // ADTS can only signal profiles 1-4; HE-AAC streams decode as LC with implicit SBR.
  const profile = (objectType >= 1 && objectType <= 4 ? objectType : 2) - 1
  const len = payloadLength + 7
  return new Uint8Array([
    0xff,
    0xf1, // MPEG-4, no CRC
    (profile << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | (len >> 11),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ])
}

// Rewraps a video's audio as an ADTS .aac stream. Safari's decodeAudioData
// rejects video containers it will happily play, but decodes ADTS AAC.
export async function extractAacAsAdts(data: ArrayBuffer): Promise<ArrayBuffer> {
  const { frames, config } = await readAacTrack(data)
  return concat(frames.flatMap((f) => [adtsHeader(config, f.data.length), f.data])).buffer
}

// --- minimal .m4a writer ---

const u8 = (n: number) => [n & 0xff]
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32)

function box(type: string, ...body: (number[] | Uint8Array)[]) {
  const content = concat(body.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b))))
  return concat([new Uint8Array([...u32(content.length + 8), ...ascii(type)]), content])
}
const fullBox = (type: string, flags: number, ...body: (number[] | Uint8Array)[]) =>
  box(type, u32(flags), ...body) // version 0

// MPEG-4 descriptor with a single-byte length (all of ours are < 128 bytes)
const descriptor = (tag: number, ...body: number[]) => [tag, body.length, ...body]

function esds(dsi: Uint8Array) {
  const decSpecific = descriptor(5, ...dsi)
  // objectType 0x40 = MPEG-4 audio, streamType 5 = audio
  const decConfig = descriptor(4, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...decSpecific)
  return fullBox('esds', 0, descriptor(3, ...u16(1), 0, ...decConfig, ...descriptor(6, 2)))
}

function moov(t: AacTrack, mdatOffset: number) {
  const mediaDuration = t.frames.reduce((n, f) => n + f.duration, 0)
  const duration = t.edits.length ? t.edits.reduce((n, e) => n + e.duration, 0) : mediaDuration
  const stts: number[][] = [] // run-length [count, delta]
  for (const f of t.frames) {
    const last = stts[stts.length - 1]
    if (last?.[1] === f.duration) last[0]++
    else stts.push([1, f.duration])
  }
  const sampleEntry = box(
    'mp4a',
    [0, 0, 0, 0, 0, 0, ...u16(1)], // reserved, data_reference_index
    [...u32(0), ...u32(0), ...u16(t.config.channels || 2), ...u16(16), ...u16(0), ...u16(0)],
    u32(Math.min(t.sampleRate, 65535) * 65536),
    esds(t.dsi),
  )
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, u32(1), sampleEntry),
    fullBox('stts', 0, u32(stts.length), stts.flat().flatMap(u32)),
    fullBox('stsc', 0, u32(1), u32(1), u32(t.frames.length), u32(1)), // all samples in one chunk
    fullBox('stsz', 0, u32(0), u32(t.frames.length), t.frames.flatMap((f) => u32(f.data.length))),
    fullBox('stco', 0, u32(1), u32(mdatOffset)),
  )
  const minf = box(
    'minf',
    fullBox('smhd', 0, u16(0), u16(0)),
    box('dinf', fullBox('dref', 0, u32(1), fullBox('url ', 1))),
    stbl,
  )
  const mdia = box(
    'mdia',
    fullBox('mdhd', 0, u32(0), u32(0), u32(t.timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
    fullBox('hdlr', 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler'), u8(0)),
    minf,
  )
  const edts = t.edits.length
    ? [
        box(
          'edts',
          fullBox(
            'elst',
            0,
            u32(t.edits.length),
            t.edits.flatMap((e) => [...u32(e.duration), ...u32(e.mediaTime), ...u16(1), ...u16(0)]),
          ),
        ),
      ]
    : []
  const tkhd = fullBox(
    'tkhd',
    3, // enabled, in movie
    [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(duration), ...u32(0), ...u32(0)],
    [...u16(0), ...u16(0), ...u16(0x0100), ...u16(0), ...MATRIX, ...u32(0), ...u32(0)],
  )
  const mvhd = fullBox(
    'mvhd',
    0,
    [...u32(0), ...u32(0), ...u32(t.timescale), ...u32(duration), ...u32(0x10000), ...u16(0x0100)],
    new Uint8Array(10),
    MATRIX,
    new Uint8Array(24),
    u32(2), // next track ID
  )
  return box('moov', mvhd, box('trak', tkhd, ...edts, mdia))
}

// Rewraps a video's audio track as a standalone .m4a (no re-encoding), so a
// video can be stored at a fraction of its size and still seek precisely.
export async function extractAacAsM4a(data: ArrayBuffer): Promise<ArrayBuffer> {
  const track = await readAacTrack(data)
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'))
  // moov's size doesn't depend on the chunk offset, so measure it first
  const mdatOffset = ftyp.length + moov(track, 0).length + 8
  const mdat = box('mdat', ...track.frames.map((f) => f.data))
  return concat([ftyp, moov(track, mdatOffset), mdat]).buffer
}
