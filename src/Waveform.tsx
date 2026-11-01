import { useEffect, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/plugins/regions'
import type { Trigger } from './db'

interface Props {
  audioRef: RefObject<HTMLAudioElement | null>
  src?: string
  peaks?: number[]
  duration?: number
  error?: string
  triggers?: Trigger[]
  onMarkerClick: (index: number) => void
  onMarkerMove: (id: string, time: number) => void
}

// Draws the clip's waveform on top of the existing <audio> element, so playback,
// seeking and the progress overlay all stay in sync with the native controls.
// The waveform comes from precomputed peaks: passing peaks and duration means
// wavesurfer never fetches or decodes the file itself, and never waits for the
// media element's metadata (which iOS may not load until the user taps play).
export default function Waveform(props: Props) {
  const { audioRef, src, peaks, duration, error, triggers } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create>>(null)
  const [ready, setReady] = useState(false)
  const [renderError, setRenderError] = useState<string>()
  const callbacks = useRef(props)
  useEffect(() => {
    callbacks.current = props
  })

  useEffect(() => {
    const media = audioRef.current
    if (!src || !peaks?.length || !duration || !media || !containerRef.current) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media,
      url: src,
      peaks: [peaks],
      duration,
      height: 96,
      waveColor: '#8888',
      progressColor: '#3b6ef5',
      cursorColor: '#3b6ef5',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      dragToSeek: true,
      plugins: [regions],
    })
    regionsRef.current = regions
    ws.on('decode', () => setReady(true))
    ws.on('error', (e) => setRenderError(e.message || String(e)))
    regions.on('region-clicked', (region, e) => {
      e.stopPropagation() // don't also seek to where the marker label was tapped
      callbacks.current.onMarkerClick(Number(region.id.split(':')[1]))
    })
    regions.on('region-updated', (region) => {
      callbacks.current.onMarkerMove(region.id.split(':')[0], +region.start.toFixed(2))
    })
    return () => {
      setReady(false)
      regionsRef.current = null
      ws.destroy()
    }
  }, [src, peaks, duration, audioRef])

  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    regions.clearRegions()
    triggers?.forEach((t, i) => {
      regions.addRegion({
        id: `${t.id}:${i}`,
        start: t.time,
        content: t.label || String(i + 1),
        color: '#f59e0b',
        drag: true,
        resize: false,
      })
    })
  }, [triggers, ready])

  return (
    <div ref={containerRef} className="waveform">
      {(!peaks?.length || renderError) && (
        <p className="muted small">
          {error || renderError
            ? `Waveform unavailable: ${error || renderError}`
            : 'Loading waveform…'}
        </p>
      )}
    </div>
  )
}
