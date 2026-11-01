import { createFile, MP4BoxBuffer, type Sample } from 'mp4box'

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

interface AacConfig {
  objectType: number
  rateIndex: number
  channels: number
}

// Reads the AudioSpecificConfig from the sample entry's esds box. In QuickTime
// files the esds can sit inside a "wave" box, so search the entry's children.
function configFromEntry(entry: unknown): AacConfig | undefined {
  type Desc = { findDescriptor?: (tag: number) => Desc | undefined; data?: Uint8Array }
  type BoxLike = { type?: string; esds?: { esd?: Desc }; boxes?: BoxLike[] }
  const queue: BoxLike[] = [entry as BoxLike]
  while (queue.length) {
    const box = queue.shift()!
    const dsi = box.esds?.esd?.findDescriptor?.(4)?.findDescriptor?.(5)?.data
    if (dsi && dsi.length >= 2) {
      return {
        objectType: dsi[0] >> 3,
        rateIndex: ((dsi[0] & 7) << 1) | (dsi[1] >> 7),
        channels: (dsi[1] >> 3) & 15,
      }
    }
    queue.push(...(box.boxes ?? []))
  }
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

// Pulls the AAC audio track out of an MP4/MOV (e.g. an iPhone video) and rewraps
// it as an ADTS .aac stream. Safari's decodeAudioData rejects video containers it
// will happily play, but decodes ADTS AAC.
export function extractAacAsAdts(data: ArrayBuffer): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const file = createFile()
    const frames: Uint8Array[] = []
    let config: AacConfig | undefined
    let fallback: AacConfig | undefined
    let expected = 0
    let done = false
    const fail = (message: string) => {
      if (!done) reject(new Error(message))
      done = true
    }

    file.onError = (_module, message) => fail(`could not read container: ${message}`)
    file.onReady = (info) => {
      const track = info.audioTracks[0]
      if (!track) return fail('file has no audio track')
      if (!track.codec.startsWith('mp4a')) return fail(`unsupported audio codec ${track.codec}`)
      const rateIndex = SAMPLE_RATES.indexOf(track.audio?.sample_rate ?? 0)
      if (rateIndex >= 0) {
        fallback = { objectType: 2, rateIndex, channels: track.audio?.channel_count || 2 }
      }
      expected = track.nb_samples
      file.setExtractionOptions(track.id, null, { nbSamples: 1000 })
      file.start()
    }
    file.onSamples = (_id, _user, samples: Sample[]) => {
      for (const s of samples) {
        if (!s.data) continue
        config ??= configFromEntry(s.description) ?? fallback
        if (!config) return fail('could not read the audio format')
        frames.push(adtsHeader(config, s.data.length), s.data)
      }
      if (frames.length / 2 >= expected && !done) {
        done = true
        const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
        let offset = 0
        for (const f of frames) {
          out.set(f, offset)
          offset += f.length
        }
        resolve(out.buffer)
      }
    }

    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, 0))
    file.flush()
    if (!done) fail(expected ? 'audio track was incomplete' : 'could not find the audio track')
  })
}
