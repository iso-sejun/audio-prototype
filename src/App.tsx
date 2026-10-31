import { useEffect, useState } from 'react'
import Library from './Library'
import ClipView from './ClipView'

const OPEN_KEY = 'openClipId'

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY)
  } catch {
    return null
  }
}

export default function App() {
  const [openId, setOpenId] = useState<string | null>(readOpen)

  useEffect(() => {
    try {
      if (openId) localStorage.setItem(OPEN_KEY, openId)
      else localStorage.removeItem(OPEN_KEY)
    } catch {
      // storage unavailable (private mode); not essential
    }
  }, [openId])

  useEffect(() => {
    navigator.storage?.persist?.()
  }, [])

  return openId ? (
    <ClipView clipId={openId} onBack={() => setOpenId(null)} />
  ) : (
    <Library onOpen={setOpenId} />
  )
}
