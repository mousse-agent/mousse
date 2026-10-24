import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ActionsSection } from './ActionsSection'
import { DeviceSection } from './DeviceSection'
import { GitSection } from './GitSection'
import { LineageSection } from './LineageSection'
import {
  sideCardFitsThreadWidth,
  threadsSidebarReservedWidth,
  threadViewWidth,
  useSideCardVisible
} from './sideCardLogic'
import { useSideCardPresence } from './useSideCardPresence'
import './sideCard.css'

interface ThreadSideCardProps {
  /**
   * Called with whether the thread view should leave room for the card on its
   * right. The owner of the thread view applies the padding, so the transcript
   * is never hidden under the card. It turns true as the card starts to fade in
   * and false as it starts to fade out; the padding transition follows.
   */
  onReservedChange?: (reserved: boolean) => void
}

interface SideCardSectionsProps {
  threadId: string | null
  projectId: string | null
}

/** The card's sections, in order. */
export function SideCardSections({ threadId, projectId }: SideCardSectionsProps) {
  return (
    <>
      <DeviceSection threadId={threadId} projectId={projectId} />
      <GitSection threadId={threadId} projectId={projectId} />
      <ActionsSection threadId={threadId} projectId={projectId} />
      <LineageSection threadId={threadId} projectId={projectId} />
    </>
  )
}

/**
 * Floating card on the right of the thread view. Render it inside the thread
 * pane, within the workspace: its layer fills that pane, and the workspace is
 * measured to decide whether there is room. Opening the app panel fades the card
 * out in place instead of letting it jump into the narrower pane.
 */
export function ThreadSideCard({ onReservedChange }: ThreadSideCardProps) {
  const visible = useSideCardVisible()
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const setSideCardFits = useAppStore((s) => s.setSideCardFits)
  const threadId = useAppStore((s) => s.activeThreadId)
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId ?? null)

  const layerRef = useRef<HTMLDivElement>(null)
  // The thread view's width with the app panel closed: the whole workspace less
  // the threads sidebar that stays beside it. Opening the panel narrows the aside
  // the card sits in, so the aside says nothing about whether the card fits; the
  // workspace holds still and keeps reporting while the panel is open.
  const threadsReserved = useAppStore((s) => threadsSidebarReservedWidth(s.threadsSidebarOpen, s.threadsSidebarWidth))
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null)
  const threadWidth = workspaceWidth === null ? null : threadViewWidth(workspaceWidth, threadsReserved)

  // The first reading lands before the first paint, so a wide window shows the
  // card at launch without waiting for the observer and a narrow one never flashes it.
  useLayoutEffect(() => {
    const workspace = layerRef.current?.closest<HTMLElement>('.app-workspace')
    if (!workspace) return
    // Zero means the workspace is hidden (Scheduled, Channels), not narrow.
    const measure = (width: number) => {
      if (width > 0) setWorkspaceWidth(width)
    }
    measure(workspace.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      measure(entries[entries.length - 1]?.contentRect.width ?? 0)
    })
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  // Whether the width is enough lives in the store so the title-bar button can share it.
  useLayoutEffect(() => {
    if (threadWidth !== null) setSideCardFits(sideCardFitsThreadWidth(threadWidth))
  }, [threadWidth, setSideCardFits])

  // The launch cascade (measure, then present) happens within the first frame
  // and skips the fade-in; everything after it fades.
  const [launched, setLaunched] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setLaunched(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const { mounted, shown, reserved } = useSideCardPresence(visible, launched)

  useEffect(() => {
    onReservedChange?.(reserved)
  }, [onReservedChange, reserved])

  // Pin the layer to the full thread width so the fading card stays where it was.
  // The aside lifts above the incoming app panel while a card is mounted there
  // (see the .sidebar rule in sideCard.css), so the pinned card is not painted under it.
  const pinned = mainAreaOpen && threadWidth !== null
  return (
    <div
      ref={layerRef}
      className="thread-side-card-layer"
      style={pinned ? { right: 'auto', width: threadWidth } : undefined}
    >
      {mounted && (
        <section className="thread-side-card" aria-label="Thread details" data-shown={shown} inert={!shown}>
          <SideCardSections threadId={threadId} projectId={projectId} />
        </section>
      )}
    </div>
  )
}
