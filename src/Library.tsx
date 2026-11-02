import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteClip, formatTime, importClip, renameClip } from './db'

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const clips = useLiveQuery(() => db.clips.orderBy('createdAt').reverse().toArray())
  const counts = useLiveQuery(async () => {
    const map: Record<string, number> = {}
    await db.triggers.each((t) => (map[t.clipId] = (map[t.clipId] ?? 0) + 1))
    return map
  })
  const [usage, setUsage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
      setUsage(`${(usage / 1e6).toFixed(1)} MB used of ${(quota / 1e6).toFixed(0)} MB`)
    })
  }, [clips])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    const probe = document.createElement('audio')
    for (const file of Array.from(files)) {
      if (file.type.startsWith('audio/') && !probe.canPlayType(file.type)) {
        alert(`"${file.name}" (${file.type}) may not play in this browser.`)
      }
      await importClip(file)
    }
    setBusy(false)
  }

  return (
    <main>
      <h1>Clips</h1>
      <label className="button">
        {busy ? 'Importing…' : '+ Upload audio'}
        <input
          type="file"
          accept="audio/*,video/*"
          multiple
          hidden
          disabled={busy}
          onChange={(e) => {
            onFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </label>

      {clips?.length === 0 && <p className="muted">No clips yet.</p>}
      <ul className="list">
        {clips?.map((c) => (
          <li key={c.id}>
            <input
              className="name"
              defaultValue={c.name}
              onChange={(e) => e.target.value.trim() && renameClip(c.id, e.target.value.trim())}
            />
            <span className="muted">
              {formatTime(c.duration)} · {counts?.[c.id] ?? 0} triggers
            </span>
            <button onClick={() => onOpen(c.id)}>Open</button>
            <button
              onClick={() => confirm(`Delete "${c.name}"?`) && deleteClip(c.id)}
              aria-label="Delete clip"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {usage && <p className="muted small">{usage}</p>}
    </main>
  )
}
