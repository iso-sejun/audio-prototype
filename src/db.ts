import Dexie, { type EntityTable } from 'dexie'

export interface Clip {
  id: string
  name: string
  mimeType: string
  duration: number
  size: number
  createdAt: number
  peaks?: number[] // precomputed waveform, 0..1 per bucket
}

// Kept in its own table so listing clips never loads audio into memory.
export interface ClipAudio {
  clipId: string
  blob: Blob
}

export interface Trigger {
  id: string
  clipId: string
  time: number
  label?: string
  createdAt: number
}

export const db = new Dexie('audio-triggers') as Dexie & {
  clips: EntityTable<Clip, 'id'>
  audio: EntityTable<ClipAudio, 'clipId'>
  triggers: EntityTable<Trigger, 'id'>
}

db.version(1).stores({
  clips: 'id, createdAt',
  audio: 'clipId',
  triggers: 'id, clipId, [clipId+time]',
})

function readDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const el = new Audio()
    el.preload = 'metadata'
    const done = (d: number) => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(d) ? d : 0)
    }
    el.onloadedmetadata = () => done(el.duration)
    el.onerror = () => done(0)
    // iOS may not load metadata without a user gesture; the decode fills it in later.
    setTimeout(() => done(0), 5000)
    el.src = url
  })
}

type WebkitWindow = typeof window & {
  webkitOfflineAudioContext?: typeof OfflineAudioContext
  webkitAudioContext?: typeof AudioContext
}

// Decodes with the most conservative Web Audio setup: an offline context at 44.1 kHz
// (accepted everywhere, needs no user gesture), falling back to a default-rate
// AudioContext, and the callback form of decodeAudioData (older Safari lacks the
// promise form).
async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer()
  const w = window as WebkitWindow
  const Offline = window.OfflineAudioContext ?? w.webkitOfflineAudioContext
  const Online = window.AudioContext ?? w.webkitAudioContext
  let ctx: BaseAudioContext
  try {
    ctx = new Offline!(1, 1, 44100)
  } catch {
    ctx = new Online!()
  }
  try {
    return await new Promise<AudioBuffer>((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, (e) =>
        reject(e ?? new Error('Could not decode audio')),
      )
      p?.catch?.(reject)
    })
  } finally {
    if (ctx instanceof AudioContext) ctx.close().catch(() => {})
  }
}

// Reduces the decoded audio to `buckets` peak values so the waveform can be drawn
// instantly from IndexedDB, without decoding the file again.
export async function computeWaveform(blob: Blob, buckets = 1000) {
  const buffer = await decodeBlob(blob)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  )
  const size = Math.max(1, Math.floor(buffer.length / buckets))
  const peaks: number[] = []
  let max = 0
  for (let start = 0; start < buffer.length; start += size) {
    let peak = 0
    const end = Math.min(start + size, buffer.length)
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = Math.abs(ch[i])
        if (v > peak) peak = v
      }
    }
    peaks.push(peak)
    if (peak > max) max = peak
  }
  const scale = max > 0 ? 1 / max : 1
  return {
    peaks: peaks.map((p) => Math.round(p * scale * 1000) / 1000),
    duration: buffer.duration,
  }
}

// Fills in the waveform for clips imported before peaks were stored, or whose
// decode failed at import time.
export async function ensureWaveform(clipId: string, blob: Blob) {
  const clip = await db.clips.get(clipId)
  if (!clip || clip.peaks?.length) return
  const { peaks, duration } = await computeWaveform(blob)
  await db.clips.update(clipId, { peaks, duration: clip.duration || duration })
}

export async function importClip(file: File): Promise<string> {
  const id = crypto.randomUUID()
  const duration = await readDuration(file)
  await db.transaction('rw', db.clips, db.audio, async () => {
    await db.clips.add({
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      mimeType: file.type,
      duration,
      size: file.size,
      createdAt: Date.now(),
    })
    await db.audio.add({ clipId: id, blob: file })
  })
  // Not fatal: the clip still plays, and the clip screen retries and reports the error.
  await ensureWaveform(id, file).catch(() => {})
  return id
}

export async function deleteClip(id: string) {
  await db.transaction('rw', db.clips, db.audio, db.triggers, async () => {
    await db.clips.delete(id)
    await db.audio.delete(id)
    await db.triggers.where('clipId').equals(id).delete()
  })
}

export function renameClip(id: string, name: string) {
  return db.clips.update(id, { name })
}

export async function addTrigger(clipId: string, time: number, label?: string) {
  const id = crypto.randomUUID()
  await db.triggers.add({ id, clipId, time, label, createdAt: Date.now() })
  return id
}

export function updateTrigger(id: string, changes: Partial<Pick<Trigger, 'time' | 'label'>>) {
  return db.triggers.update(id, changes)
}

export function deleteTrigger(id: string) {
  return db.triggers.delete(id)
}

export function formatTime(t: number) {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}
