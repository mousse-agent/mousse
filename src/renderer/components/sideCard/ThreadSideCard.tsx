import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useDialogFocus } from '../ui/Modal'
import { ActionsSection } from './ActionsSection'
import { DeviceSection } from './DeviceSection'
import { GitSection } from './GitSection'
import { LineageSection } from './LineageSection'
import { PermissionSection } from './PermissionSection'
import {
  sideCardFitsThreadWidth,
  sideCardReservedWidth,
  threadsSidebarReservedWidth,
  threadViewWidth,
  useSideCardMode,
  useSideCardVisible
} from './sideCardLogic'
import { useSideCardPresence } from './useSideCardPresence'
import './sideCard.css'

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
      <PermissionSection threadId={threadId} projectId={projectId} />
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
 *
 * Docked, the card writes `--side-card-reserved` (px) on the pane so the
 * conversation column and the composer step aside for it while the scroller
 * keeps the pane's full width. In a thread area too narrow for that the same
 * card is an overlay: it slides in over the conversation with a scrim, takes
 * focus, closes on Escape or a click on the scrim, and reserves nothing.
 */
export function ThreadSideCard() {
  const visible = useSideCardVisible()
  const overlay = useSideCardMode() === 'overlay'
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const setSideCardFits = useAppStore((s) => s.setSideCardFits)
  const threadId = useAppStore((s) => s.activeThreadId)
  const projectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId ?? null)

  const layerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLElement>(null)
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

  // Written on the pane, not passed up: the width follows the window while it is
  // resized, and nothing above the pane needs to render for it.
  const reservedWidth = !overlay && reserved && threadWidth !== null ? sideCardReservedWidth(threadWidth) : 0
  useLayoutEffect(() => {
    layerRef.current?.parentElement?.style.setProperty('--side-card-reserved', `${reservedWidth}px`)
  }, [reservedWidth])
  useLayoutEffect(() => {
    const pane = layerRef.current?.parentElement
    return () => {
      pane?.style.removeProperty('--side-card-reserved')
    }
  }, [])

  const closeOverlay = useCallback(() => useAppStore.getState().setSideCardOverlayOpen(false), [])
  // Focus moves into the overlay once it has faded in and returns to the control that opened it
  // when it starts to fade out. Docked, the card is a plain part of the page.
  useDialogFocus(cardRef, overlay && shown, closeOverlay)
  // The dialog helper lands on the first control, which would draw a focus ring on a row the user
  // did not pick. The card itself takes focus instead; Tab moves on to its first control.
  useEffect(() => {
    if (overlay && shown) cardRef.current?.focus({ preventScroll: true })
  }, [overlay, shown])

  // Pin the layer to the full thread width so the fading card stays where it was.
  // The aside lifts above the incoming app panel while a card is mounted there
  // (see the .sidebar rule in sideCard.css), so the pinned card is not painted under it.
  const pinned = mainAreaOpen && threadWidth !== null
  return (
    <div
      ref={layerRef}
      className={`thread-side-card-layer${overlay ? ' thread-side-card-layer--overlay' : ''}`}
      style={pinned ? { right: 'auto', width: threadWidth } : undefined}
    >
      {mounted && overlay && (
        <div className="thread-side-card-scrim" data-shown={shown} aria-hidden="true" onClick={closeOverlay} />
      )}
      {mounted && (
        <section
          ref={cardRef}
          className="thread-side-card"
          aria-label="Thread details"
          role={overlay ? 'dialog' : undefined}
          tabIndex={overlay ? -1 : undefined}
          data-shown={shown}
          inert={!shown}
        >
          <SideCardSections threadId={threadId} projectId={projectId} />
        </section>
      )}
    </div>
  )
}
