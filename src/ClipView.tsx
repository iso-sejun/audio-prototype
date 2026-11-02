import { useEffect, useRef, useState } from 'react'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  addTrigger,
  db,
  deleteTrigger,
  ensureWaveform,
  formatTime,
  shrinkClip,
  updateTrigger,
} from './db'
import Waveform from './Waveform'

const STOP_KEY = 'stopAtNext'

export default function ClipView({ clipId, onBack }: { clipId: string; onBack: () => void }) {
  const clip = useLiveQuery(() => db.clips.get(clipId), [clipId])
  const triggers = useLiveQuery(
    () =>
      db.triggers
        .where('[clipId+time]')
        .between([clipId, Dexie.minKey], [clipId, Dexie.maxKey])
        .toArray(),
    [clipId],
  )
  const audioRef = useRef<HTMLAudioElement>(null)
  const stopAtRef = useRef<number | null>(null)
  const [src, setSrc] = useState<string>()
  const [missing, setMissing] = useState(false)
  const [waveError, setWaveError] = useState<string>()
  const [stopAtNext, setStopAtNext] = useState(() => {
    try {
      return localStorage.getItem(STOP_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let url: string | undefined
    let cancelled = false
    db.audio.get(clipId).then(async (row) => {
      if (!row) return setMissing(true)
      const blob = await shrinkClip(clipId, row.blob)
      if (cancelled) return
      url = URL.createObjectURL(blob)
      setSrc(url)
      ensureWaveform(clipId, blob).catch((e: unknown) =>
        setWaveError(e instanceof Error ? e.message || e.name : String(e)),
      )
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [clipId])

  useEffect(() => {
    try {
      localStorage.setItem(STOP_KEY, stopAtNext ? '1' : '0')
    } catch {
      // not essential
    }
  }, [stopAtNext])

  // timeupdate only fires ~4x/sec, so poll on animation frames while playing
  // to stop close to the next trigger.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    let raf = 0
    const tick = () => {
      const stopAt = stopAtRef.current
      if (stopAt != null) {
        if (el.currentTime >= stopAt && el.currentTime < stopAt + 0.5) {
          el.pause()
          el.currentTime = stopAt
        } else if (el.currentTime >= stopAt) {
          stopAtRef.current = null // user seeked past it
        }
      }
      if (!el.paused) raf = requestAnimationFrame(tick)
    }
    const onPlay = () => (raf = requestAnimationFrame(tick))
    const onPause = () => {
      cancelAnimationFrame(raf)
      stopAtRef.current = null
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
    }
  }, [src])

  // Must stay synchronous: iOS only allows play() directly inside a tap handler.
  function playFrom(index: number) {
    const el = audioRef.current
    if (!el || !triggers) return
    const t = triggers[index].time
    const next = triggers.slice(index + 1).find((n) => n.time > t)
    stopAtRef.current = null
    if (el.readyState >= 1) el.currentTime = t
    else el.addEventListener('loadedmetadata', () => (el.currentTime = t), { once: true })
    el.play()
      .then(() => (stopAtRef.current = stopAtNext && next ? next.time : null))
      .catch(() => {})
  }

  function nudge(id: string, time: number, delta: number) {
    const max = clip?.duration || Infinity
    updateTrigger(id, { time: Math.min(max, Math.max(0, +(time + delta).toFixed(2))) })
  }

  if (missing) {
    return (
      <main>
        <button onClick={onBack}>← Clips</button>
        <p>This clip's audio is no longer stored on this device.</p>
      </main>
    )
  }

  return (
    <main>
      <button onClick={onBack}>← Clips</button>
      <h1>{clip?.name}</h1>
      <Waveform
        audioRef={audioRef}
        src={src}
        peaks={clip?.peaks}
        duration={clip?.duration}
        error={waveError}
        triggers={triggers}
        onMarkerClick={playFrom}
        onMarkerMove={(id, time) => updateTrigger(id, { time })}
      />
      <audio ref={audioRef} src={src} controls preload="auto" />

      <div className="row">
        <button
          className="primary"
          onClick={() => audioRef.current && addTrigger(clipId, audioRef.current.currentTime)}
        >
          + Trigger
        </button>
        <label className="small">
          <input
            type="checkbox"
            checked={stopAtNext}
            onChange={(e) => setStopAtNext(e.target.checked)}
          />{' '}
          Stop at next trigger
        </label>
      </div>

      {triggers?.length === 0 && (
        <p className="muted">Play the clip and tap “+ Trigger” to mark a spot.</p>
      )}
      <ul className="list">
        {triggers?.map((t, i) => (
          <li key={t.id}>
            <button className="primary" onClick={() => playFrom(i)} aria-label="Play from here">
              ▶
            </button>
            <div className="stack">
              <span className="time muted small">{formatTime(t.time)}</span>
              <input
                className="name"
                placeholder={`Trigger ${i + 1}`}
                defaultValue={t.label}
                onChange={(e) => updateTrigger(t.id, { label: e.target.value.trim() || undefined })}
              />
            </div>
            <button onClick={() => nudge(t.id, t.time, -0.1)} aria-label="Earlier">
              −
            </button>
            <button onClick={() => nudge(t.id, t.time, 0.1)} aria-label="Later">
              +
            </button>
            <button onClick={() => deleteTrigger(t.id)} aria-label="Delete trigger">
              ✕
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
