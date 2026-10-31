import { useEffect, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/plugins/regions'
import type { Trigger } from './db'

interface Props {
  audioRef: RefObject<HTMLAudioElement | null>
  src?: string
  triggers?: Trigger[]
  onMarkerClick: (index: number) => void
  onMarkerMove: (id: string, time: number) => void
}

// Draws the clip's waveform on top of the existing <audio> element, so playback,
// seeking and the progress overlay all stay in sync with the native controls.
export default function Waveform({ audioRef, src, triggers, onMarkerClick, onMarkerMove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create>>(null)
  const [ready, setReady] = useState(false)
  const callbacks = useRef({ onMarkerClick, onMarkerMove })
  useEffect(() => {
    callbacks.current = { onMarkerClick, onMarkerMove }
  })

  useEffect(() => {
    const media = audioRef.current
    if (!src || !media || !containerRef.current) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media,
      url: src,
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
  }, [src, audioRef])

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

  return <div ref={containerRef} className="waveform" />
}
