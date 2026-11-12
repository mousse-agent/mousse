import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useShortcutTitle } from '../commands/commandRegistry'
import { focusInitialMenuItem, useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { Check, ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal } from '../lib/icons'
import { showProjectInSidebar } from '../lib/sidebarReveal'
import { selectThread } from '../lib/threadActions'
import {
  canOpenFromHistory,
  goToHistoryIndex,
  historyList,
  stepHistory,
  stepTarget,
  useThreadHistoryStore
} from '../lib/threadHistory'
import { hiddenSegmentCount, siblingThreads, threadPath, type PathSegment } from '../lib/threadPath'
import { useThreadPathInTitleBar } from '../lib/threadPathSetting'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import './titleBarNav.css'

const logFailure = (what: string) => (error: unknown) => console.error(`${what} failed`, error)

/** How long ← or → is held before its history list opens. */
export const HISTORY_HOLD_MS = 450

/** Titles up to this many characters fit a menu row whole. */
const MENU_TITLE_FITS = 44

export interface NavMenuRow {
  key: string
  label: string
  /** Quiet text at the row's end: a thread's project, or "Project". */
  meta?: string
  /** The thread the window is on. */
  checked?: boolean
  /** One step in, under the row above (a thread under its project). */
  indent?: boolean
  onSelect: () => void
}

interface NavMenuProps {
  anchorRef: RefObject<HTMLElement | null>
  label?: string
  rows: NavMenuRow[]
  onClose: () => void
}

/** A menu under a title-bar control, on the app's own menu surface and rows. */
export function NavMenu({ anchorRef, label, rows, onClose }: NavMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: menuRef, placement: 'below-start', gap: 7, deps: [rows.length] })
  const onKeyDown = useMenuKeyboard(menuRef, onClose)
  useEffect(() => {
    // After the menu is placed: it is hidden until then, and a hidden row cannot take focus.
    const frame = requestAnimationFrame(() => focusInitialMenuItem(menuRef.current))
    const outside = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    // Escape also closes it while focus is still on the control that opened it.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menuRef.current?.contains(event.target as Node | null)) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', onClose)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', onClose)
    }
  }, [anchorRef, onClose])
  return (
    <FloatingPortal>
      <div ref={menuRef} className="threads-context-menu titlebar-nav-menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
        {label && <div className="threads-context-menu-label" role="presentation">{label}</div>}
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            role={row.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={row.checked}
            className={`threads-context-menu-item${row.indent ? ' titlebar-nav-menu-indent' : ''}`}
            // Only a title the menu may cut short gets a tooltip; others would cover the rows below.
            title={row.label.length > MENU_TITLE_FITS ? row.label : undefined}
            onClick={() => {
              onClose()
              row.onSelect()
            }}
          >
            <span className="titlebar-nav-menu-text">{row.label}</span>
            {row.checked ? (
              <span className="titlebar-nav-menu-meta"><Check size={14} strokeWidth={2} aria-hidden="true" /></span>
            ) : row.meta ? (
              <span className="titlebar-nav-menu-meta">{row.meta}</span>
            ) : null}
          </button>
        ))}
      </div>
    </FloatingPortal>
  )
}

/** The project a thread is in, by name, for the history list. */
function useProjectNames(): (threadId: string) => string | undefined {
  const threads = useAppStore((s) => s.threads)
  const projects = useAppStore((s) => s.projects)
  return useCallback((threadId: string) => {
    const path = threadPath(threadId, threads, projects)
    return path[0]?.kind === 'project' ? path[0].name : undefined
  }, [threads, projects])
}

/** ← and →: one step through the window's thread history. Held or right-clicked, each lists where it goes. */
export function HistoryButtons() {
  const history = useThreadHistoryStore()
  // Read so the buttons update when a thread in the history is archived or deleted.
  const threads = useAppStore((s) => s.threads)
  const projectOf = useProjectNames()
  const canBack = useMemo(() => stepTarget(history, -1, canOpenFromHistory) !== null, [history, threads])
  const canForward = useMemo(() => stepTarget(history, 1, canOpenFromHistory) !== null, [history, threads])
  const backTitle = useShortcutTitle('Back', 'thread.back')
  const forwardTitle = useShortcutTitle('Forward', 'thread.forward')
  const [menu, setMenu] = useState<-1 | 1 | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const forwardRef = useRef<HTMLButtonElement>(null)
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; opened: boolean }>({ timer: null, opened: false })
  const close = useCallback(() => setMenu(null), [])

  const stopHold = () => {
    if (hold.current.timer) clearTimeout(hold.current.timer)
    hold.current.timer = null
  }
  useEffect(() => stopHold, [])

  const button = (direction: -1 | 1) => {
    const enabled = direction === -1 ? canBack : canForward
    const label = direction === -1 ? 'Back' : 'Forward'
    const Icon = direction === -1 ? ChevronLeft : ChevronRight
    return (
      <button
        ref={direction === -1 ? backRef : forwardRef}
        type="button"
        className={`icon-btn icon-btn-titlebar${menu === direction ? ' is-open' : ''}`}
        aria-label={label}
        title={direction === -1 ? backTitle : forwardTitle}
        aria-haspopup="menu"
        aria-expanded={menu === direction}
        disabled={!enabled}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          stopHold()
          hold.current.opened = false
          hold.current.timer = setTimeout(() => {
            hold.current.timer = null
            hold.current.opened = true
            setMenu(direction)
          }, HISTORY_HOLD_MS)
        }}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        onContextMenu={(event) => {
          event.preventDefault()
          stopHold()
          setMenu(direction)
        }}
        onClick={() => {
          // A hold that opened the list is not also a step.
          if (hold.current.opened) {
            hold.current.opened = false
            return
          }
          void stepHistory(direction).catch(logFailure(direction === -1 ? 'Going back' : 'Going forward'))
        }}
      >
        <Icon size={14} strokeWidth={2} />
      </button>
    )
  }

  const rows: NavMenuRow[] = menu === null ? [] : historyList(history, menu, canOpenFromHistory).map(({ index, threadId }) => ({
    key: `${index}`,
    label: threads.find((thread) => thread.id === threadId)?.name.trim() || 'New thread',
    meta: projectOf(threadId),
    onSelect: () => void goToHistoryIndex(index).catch(logFailure('Opening a thread from the history'))
  }))

  return (
    <div className="titlebar-history">
      {button(-1)}
      {button(1)}
      {menu !== null && rows.length > 0 && (
        <NavMenu anchorRef={menu === -1 ? backRef : forwardRef} label={menu === -1 ? 'Back' : 'Forward'} rows={rows} onClose={close} />
      )}
    </div>
  )
}

type OpenMenu = { kind: 'siblings'; threadId: string } | { kind: 'hidden' } | null

interface ThreadPathViewProps {
  segments: PathSegment[]
  /** How many leading segments are behind "…". */
  hidden: number
  /** The current thread alone does not fit: its title is cut short. */
  squeezed?: boolean
  openMenu?: OpenMenu
  onOpenSegment?: (segment: PathSegment) => void
  onToggleMenu?: (menu: OpenMenu, anchor: HTMLElement) => void
  measure?: boolean
}

/**
 * The path's segments: "…" for the hidden ones, the ancestors (dim, each opening its thread or project,
 * its "/" a caret on hover that lists the threads beside it), then the current thread, brightest, whose
 * caret lists the threads beside it.
 */
export function ThreadPathView({ segments, hidden, squeezed = false, openMenu = null, onOpenSegment, onToggleMenu, measure = false }: ThreadPathViewProps) {
  const toggle = (menu: OpenMenu) => (event: { currentTarget: HTMLElement }) => onToggleMenu?.(menu, event.currentTarget.closest<HTMLElement>('.titlebar-path-anchor') ?? event.currentTarget)
  const tab = measure ? -1 : undefined
  return (
    <nav className={`titlebar-path${measure ? ' titlebar-path-measure' : ''}`} aria-label={measure ? undefined : 'Thread path'} aria-hidden={measure || undefined}>
      {(hidden > 0 || measure) && (
        <span className={`titlebar-path-anchor titlebar-path-more${openMenu?.kind === 'hidden' ? ' is-open' : ''}`} data-segment="more">
          <button type="button" tabIndex={tab} className="titlebar-path-seg" aria-label={`Show ${hidden} more`} aria-haspopup="menu" aria-expanded={openMenu?.kind === 'hidden'} onClick={toggle({ kind: 'hidden' })}>
            <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className="titlebar-path-sep" aria-hidden="true"><span className="titlebar-path-slash">/</span></span>
        </span>
      )}
      {segments.map((segment, index) => {
        if (!measure && index < hidden) return null
        if (segment.kind === 'thread' && segment.current) {
          const open = openMenu?.kind === 'siblings' && openMenu.threadId === segment.id
          return (
            <span key={segment.id} className={`titlebar-path-anchor is-current${squeezed ? ' is-squeezed' : ''}${open ? ' is-open' : ''}`} data-segment="current">
              <button type="button" tabIndex={tab} className="titlebar-path-seg" aria-current="page" aria-haspopup="menu" aria-expanded={open} title={segment.name} onClick={toggle({ kind: 'siblings', threadId: segment.id })}>
                <span className="titlebar-path-name">{segment.name}</span>
                <span className="titlebar-path-sep" aria-hidden="true"><ChevronDown size={10} strokeWidth={2.4} /></span>
              </button>
            </span>
          )
        }
        const open = segment.kind === 'thread' && openMenu?.kind === 'siblings' && openMenu.threadId === segment.id
        return (
          <span key={`${segment.kind}:${segment.id}`} className={`titlebar-path-anchor${open ? ' is-open' : ''}`} data-segment={segment.kind}>
            <button
              type="button"
              tabIndex={tab}
              className="titlebar-path-seg"
              title={segment.kind === 'project' ? `Show ${segment.name} in the sidebar` : `Open ${segment.name}`}
              onClick={() => onOpenSegment?.(segment)}
            >
              <span className="titlebar-path-name">{segment.name}</span>
            </button>
            {segment.kind === 'thread' ? (
              <button
                type="button"
                tabIndex={tab}
                className="titlebar-path-sep titlebar-path-sep-button"
                aria-label={`Threads beside ${segment.name}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle({ kind: 'siblings', threadId: segment.id })}
              >
                <span className="titlebar-path-slash" aria-hidden="true">/</span>
                <ChevronDown size={10} strokeWidth={2.4} aria-hidden="true" />
              </button>
            ) : (
              <span className="titlebar-path-sep" aria-hidden="true"><span className="titlebar-path-slash">/</span></span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

/** The open thread's path, dropping its topmost segments into "…" when the title bar is too narrow. */
export function ThreadPath() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const threads = useAppStore((s) => s.threads)
  const projects = useAppStore((s) => s.projects)
  // In Chats and on Automations or Usage the open thread is not what the window shows.
  const shown = useAppStore((s) => s.sidebarMode === 'projects' && !s.scheduledOpen && !s.usageOpen)
  const chats = useChatsStore((s) => s.snapshot.chats)
  const chatThreadIds = useMemo(() => new Set(chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : []))), [chats])
  const segments = useMemo(
    () => (shown && activeThreadId && !chatThreadIds.has(activeThreadId) ? threadPath(activeThreadId, threads, projects) : []),
    [shown, activeThreadId, chatThreadIds, threads, projects]
  )
  const slotRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ hidden: 0, squeezed: false })
  const [menu, setMenu] = useState<OpenMenu>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const segmentsKey = segments.map((segment) => `${segment.kind}:${segment.id}:${segment.name}`).join('\n')

  useEffect(() => setMenu(null), [activeThreadId])

  useLayoutEffect(() => {
    const slot = slotRef.current
    const row = measureRef.current?.firstElementChild
    if (!slot || !row) return
    const update = () => {
      const anchors = [...row.children] as HTMLElement[]
      const more = anchors.find((anchor) => anchor.dataset.segment === 'more')
      const widths = anchors.filter((anchor) => anchor !== more).map((anchor) => anchor.getBoundingClientRect().width)
      const available = slot.clientWidth
      const moreWidth = more?.getBoundingClientRect().width ?? 0
      const hidden = hiddenSegmentCount(widths, moreWidth, available)
      const last = widths.length - 1
      const squeezed = last >= 0 && hidden === last && (hidden > 0 ? moreWidth : 0) + widths[last]! > available
      setFit((previous) => (previous.hidden === hidden && previous.squeezed === squeezed ? previous : { hidden, squeezed }))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(slot)
    observer.observe(row)
    return () => observer.disconnect()
  }, [segmentsKey])

  const openSegment = (segment: PathSegment) => {
    setMenu(null)
    if (segment.kind === 'project') showProjectInSidebar(segment.id)
    else void selectThread(segment.id).catch(logFailure('Opening a thread'))
  }

  const toggleMenu = (next: OpenMenu, anchor: HTMLElement) => {
    const same = menu && next && menu.kind === next.kind && (menu.kind === 'hidden' || (next.kind === 'siblings' && menu.threadId === next.threadId))
    menuAnchor.current = anchor
    setMenu(same ? null : next)
  }

  let label: string | undefined
  let rows: NavMenuRow[] = []
  if (menu?.kind === 'siblings') {
    const siblings = siblingThreads(menu.threadId, threads, projects, chatThreadIds)
    label = siblings?.label
    rows = (siblings?.threads ?? []).map((thread) => ({
      key: thread.id,
      label: thread.name,
      checked: thread.id === menu.threadId,
      onSelect: () => void selectThread(thread.id).catch(logFailure('Opening a thread'))
    }))
  } else if (menu?.kind === 'hidden') {
    const hiddenSegments = segments.slice(0, fit.hidden)
    const projectFirst = hiddenSegments[0]?.kind === 'project'
    rows = hiddenSegments.map((segment) => ({
      key: `${segment.kind}:${segment.id}`,
      label: segment.name,
      meta: segment.kind === 'project' ? 'Project' : undefined,
      indent: segment.kind === 'thread' && projectFirst,
      onSelect: () => openSegment(segment)
    }))
  }

  return (
    <div ref={slotRef} className="titlebar-path-slot">
      {segments.length > 0 && (
        <>
          <ThreadPathView
            segments={segments}
            hidden={Math.min(fit.hidden, segments.length - 1)}
            squeezed={fit.squeezed}
            openMenu={menu}
            onOpenSegment={openSegment}
            onToggleMenu={toggleMenu}
          />
          <div ref={measureRef} className="titlebar-path-measure-box">
            <ThreadPathView segments={segments} hidden={0} measure />
          </div>
        </>
      )}
      {menu && rows.length > 0 && <NavMenu anchorRef={menuAnchor} label={label} rows={rows} onClose={closeMenu} />}
    </div>
  )
}

/**
 * The title bar's thread navigation, after its start buttons: ← → through the window's thread history
 * and the open thread's path. Settings > Appearance > Thread path in title bar turns it off, leaving the
 * title bar as it was; the keys and mouse buttons still walk the history.
 */
export function TitleBarNav() {
  const enabled = useThreadPathInTitleBar()
  if (!enabled) return null
  return (
    <div className="titlebar-nav">
      <HistoryButtons />
      <ThreadPath />
    </div>
  )
}
