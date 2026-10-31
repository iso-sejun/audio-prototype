import Dexie, { type EntityTable } from 'dexie'

export interface Clip {
  id: string
  name: string
  mimeType: string
  duration: number
  size: number
  createdAt: number
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
    el.src = url
  })
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
