import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ActionsSection } from './ActionsSection'
import { DeviceSection } from './DeviceSection'
import { GitSection } from './GitSection'
import { LineageSection } from './LineageSection'
import { sideCardFitsThreadWidth, useSideCardVisible } from './sideCardLogic'
import { useSideCardPresence } from './useSideCardPresence'
import './sideCard.css'

interface ThreadSideCardProps {
  /**
   * Called with whether the thread view should leave room for the card on its
   * right. The owner of the thread view applies the padding, so the transcript
   * is never hidden under the card.
   */
  onReservedChange?: (reserved: boolean) => void
}

/**
 * Floating card on the right of the thread view. Render it inside the thread
 * pane: its layer fills that pane and measures it to decide whether there is
 * room. Opening the app panel fades the card out in place instead of letting
 * it jump into the narrower pane.
 */
export function ThreadSideCard({ onReservedChange }: ThreadSideCardProps) {
  const visible = useSideCardVisible()
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const threadId = useAppStore((s) => s.activeThreadId)
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId ?? null)

  const layerRef = useRef<HTMLDivElement>(null)
  // Unmeasured counts as roomy so the first paint does not flash the card away.
  const [threadWidth, setThreadWidth] = useState<number | null>(null)
  // While the app panel is open the thread pane is narrow and says nothing about
  // the full-width layout the card belongs to, so keep the last full-width reading.
  const panelOpenRef = useRef(mainAreaOpen)
  panelOpenRef.current = mainAreaOpen

  useEffect(() => {
    const layer = layerRef.current
    if (!layer || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0
      // Zero means the pane is hidden (Chats, Scheduled, Channels), not narrow.
      if (width > 0 && !panelOpenRef.current) setThreadWidth(width)
    })
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])

  const fits = threadWidth === null || sideCardFitsThreadWidth(threadWidth)
  const { mounted, shown } = useSideCardPresence(visible && fits)
  const reserved = mounted && fits && !mainAreaOpen

  useEffect(() => {
    onReservedChange?.(reserved)
  }, [onReservedChange, reserved])

  // Pin the layer to the width it had so the fading card stays where it was.
  const pinned = mainAreaOpen && threadWidth !== null
  return (
    <div
      ref={layerRef}
      className="thread-side-card-layer"
      style={pinned ? { right: 'auto', width: threadWidth } : undefined}
    >
      {mounted && (
        <section className="thread-side-card" aria-label="Thread details" data-shown={shown} inert={!shown}>
          <DeviceSection threadId={threadId} projectId={projectId} />
          <GitSection threadId={threadId} projectId={projectId} />
          <ActionsSection threadId={threadId} projectId={projectId} />
          <LineageSection threadId={threadId} projectId={projectId} />
        </section>
      )}
    </div>
  )
}
