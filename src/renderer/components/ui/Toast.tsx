import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { create } from 'zustand'
import { Check, Copy, X } from '../../lib/icons'
import { FloatingPortal } from '../../lib/floatingLayer'
import '../../styles/toast.css'

/** How long a toast stays on screen. Its timer stops while the stack is hovered or focused, or the window is in the background. */
export const TOAST_MS = 8_000
/** The most toasts kept; a newer one pushes the oldest out. */
export const MAX_TOASTS = 5
/** Gap between toasts when the stack is open. */
const STACK_GAP = 8
/** How far each toast behind the front one peeks out while the stack is closed. */
const PEEK = 9
/** Toasts drawn behind the front one while the stack is closed. */
const PEEK_COUNT = 2
/** A drag this far to the right dismisses a toast. */
const SWIPE_DISMISS_PX = 72
const EXIT_MS = 220
/** Height of the "Clear all" row above the open stack, and its gap to the top toast. */
const HEAD_HEIGHT = 20
const HEAD_GAP = 6
/** The stack's distance from the window's bottom and right edges, and its width at most (toast.css). */
const EDGE = 12
const TOASTER_WIDTH = 328
/** Space between the stack and bottom UI it stays above. */
const OBSTRUCTION_GAP = 8

/** Bottom UI the stack stays above while it is on screen, such as the Changes tab's footer. */
const useToastObstructions = create<{ elements: HTMLElement[] }>(() => ({ elements: [] }))

/**
 * Keeps toasts above `ref`'s element while it is mounted: a pane's footer with actions the stack would cover.
 * Only an element under the stack's column counts, so a footer elsewhere leaves the stack where it is.
 */
export function useToastObstruction(ref: RefObject<HTMLElement | null>): void {
  const registered = useRef<HTMLElement | null>(null)
  // Every render, since the element can come and go without the component unmounting.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === registered.current) return
    const previous = registered.current
    registered.current = element
    useToastObstructions.setState(({ elements }) => ({
      elements: [...elements.filter((item) => item !== previous), ...(element ? [element] : [])]
    }))
  })
  useLayoutEffect(() => () => {
    const element = registered.current
    registered.current = null
    if (element) useToastObstructions.setState(({ elements }) => ({ elements: elements.filter((item) => item !== element) }))
  }, [])
}

/** How far up the stack sits so it clears every registered obstruction under its column; undefined at its usual place. */
function useToastBottom(): number | undefined {
  const elements = useToastObstructions((state) => state.elements)
  const [bottom, setBottom] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const read = () => {
      const width = Math.min(TOASTER_WIDTH, window.innerWidth - 2 * EDGE)
      const right = window.innerWidth - EDGE
      const left = right - width
      let lift = 0
      for (const element of elements) {
        if (!element.isConnected) continue
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= left || rect.left >= right) continue
        lift = Math.max(lift, window.innerHeight - rect.top + OBSTRUCTION_GAP)
      }
      setBottom(lift > EDGE ? Math.round(lift) : undefined)
    }
    read()
    if (elements.length === 0) return
    window.addEventListener('resize', read)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    for (const element of elements) observer?.observe(element)
    return () => {
      window.removeEventListener('resize', read)
      observer?.disconnect()
    }
  }, [elements])
  return bottom
}

/**
 * What a toast is about, shown by a faint wash of the status colour over the toast: finished
 * (success), needs you (attention), stopped (paused), failed (error). Neutral (something done,
 * such as "Archived") is untinted.
 */
export type ToastTone = 'neutral' | 'error' | 'success' | 'attention' | 'paused'

export interface ToastAction {
  label: string
  onClick: () => void
  ariaLabel?: string
  /** For tests and styling hooks: `undo`, `retry`, `dismiss`. */
  dataAction?: string
  disabled?: boolean
}

interface ToastCardProps {
  title?: string
  message: string
  actions?: readonly ToastAction[]
  tone?: ToastTone
  /** Clicking the toast's text opens what it is about. */
  onOpen?: () => void
  openLabel?: string
  /** Shows a close button. */
  onDismiss?: () => void
  /** How long ago it happened ("now", "4m"), where the close button shows once the stack opens. */
  time?: string
  className?: string
  /** A copy fading out after the toast closed: drawn, but not the live toast. */
  ghost?: boolean
}

/** Read before the text by screen readers, since the tint alone says nothing to them. */
const TONE_SPOKEN: Partial<Record<ToastTone, string>> = { error: 'Error:', paused: 'Warning:' }
/** How long "Copied" shows after the error is copied. */
const COPIED_MS = 1_400

/**
 * Whether a toast's text is cut off, and whether it is open to show all of it: while hovered, or
 * after a click (or Enter) until the next click. Reports a clicked-open toast so its timer can wait.
 */
function useToastExpansion(text: HTMLElement | null, content: string, onPinnedChange?: (pinned: boolean) => void) {
  const [overflows, setOverflows] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const expanded = overflows && (hovered || pinned)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  useLayoutEffect(() => {
    if (!text) return
    // Measured only while closed: the open text wraps, so it never looks cut off.
    const check = () => {
      if (expandedRef.current) return
      const lines = text.querySelectorAll<HTMLElement>('.ui-toast-title, .ui-toast-message')
      setOverflows([...lines].some((line) => line.scrollWidth > line.clientWidth + 1))
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(text)
    return () => observer.disconnect()
  }, [text, content])
  const report = useRef(onPinnedChange)
  report.current = onPinnedChange
  const held = pinned && overflows
  useEffect(() => { report.current?.(held) }, [held])
  const toggle = () => {
    if (pinned) {
      setPinned(false)
      setHovered(false)
    } else setPinned(true)
  }
  return { overflows, expanded, setHovered, toggle }
}

/** One toast, tinted by its tone: its line or two of text, up to two text actions and a close button. */
function ToastCard({ title, message, actions = [], tone = 'neutral', onOpen, openLabel, onDismiss, time, className, ghost, onPinnedChange }: ToastCardProps & {
  /** The toast was clicked open (true) or closed again (false). */
  onPinnedChange?: (pinned: boolean) => void
}) {
  const [textElement, setTextElement] = useState<HTMLElement | null>(null)
  const fullText = title ? `${title}\n${message}` : message
  const { overflows, expanded, setHovered, toggle } = useToastExpansion(ghost ? null : textElement, fullText, onPinnedChange)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const expandable = overflows && !onOpen
  const spoken = ghost ? undefined : TONE_SPOKEN[tone]
  const text = (
    <>
      {spoken && <span className="sr-only">{spoken} </span>}
      {title && <span className="ui-toast-title">{title}</span>}
      <span className="ui-toast-message">{message}</span>
    </>
  )
  return (
    <div
      className={`ui-toast-card${ghost ? '' : ' ui-toast'} ui-toast-${tone}${title ? ' ui-toast-two-line' : ''}${onOpen ? ' ui-toast-openable' : ''}${overflows ? ' ui-toast-expandable' : ''}${expanded ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      role={ghost ? undefined : tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onDismiss) {
          event.stopPropagation()
          onDismiss()
        }
      }}
    >
      <span className="ui-toast-body">
        {onOpen ? (
          <button ref={setTextElement} type="button" className="ui-toast-text ui-toast-open" aria-label={openLabel} onClick={onOpen}>{text}</button>
        ) : (
          <span
            ref={setTextElement}
            className="ui-toast-text"
            role={expandable ? 'button' : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? expanded : undefined}
            onClick={expandable ? toggle : undefined}
            onKeyDown={expandable ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              toggle()
            } : undefined}
          >{text}</span>
        )}
        {expanded && (
          <span className="ui-toast-tools">
            <button
              type="button"
              className="ui-toast-copy"
              data-action="copy"
              aria-label={tone === 'error' ? 'Copy error' : 'Copy text'}
              title={tone === 'error' ? 'Copy error' : 'Copy text'}
              onClick={() => void navigator.clipboard?.writeText(fullText).then(() => setCopied(true), () => {})}
            >
              {copied ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <Copy size={12} strokeWidth={2} aria-hidden="true" />}
            </button>
            {copied && <span className="ui-toast-copied" role="status">Copied</span>}
          </span>
        )}
      </span>
      {actions.length > 0 && (
        <span className="ui-toast-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="ui-toast-action"
              data-action={action.dataAction}
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              onClick={action.onClick}
            >{action.label}</button>
          ))}
        </span>
      )}
      {(onDismiss || time) && (
        <span className={`ui-toast-corner${time ? ' has-time' : ''}`}>
          {time && <span className="ui-toast-time">{time}</span>}
          {onDismiss && (
            <button type="button" className="ui-toast-close" data-action="dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * A toast whose lifetime the caller owns, drawn where the stack sits ("Added Mousse to ~/.ssh/config · Undo").
 * Prefer `showToast`, which joins the stack.
 */
export function ToastView({
  onHoldChange,
  ...card
}: Omit<ToastCardProps, 'className' | 'ghost'> & {
  /** The pointer or focus entered (true) or left (false) the toast, so a timer can wait. */
  onHoldChange?: (held: boolean) => void
}) {
  // A clicked-open toast keeps holding after the pointer and focus leave.
  const pinnedRef = useRef(false)
  const setHeld = (held: boolean) => onHoldChange?.(held || pinnedRef.current)
  const bottom = useToastBottom()
  return (
    <FloatingPortal>
      <section
        className="ui-toaster"
        aria-label="Notifications"
        style={bottom === undefined ? undefined : { bottom }}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false) }}
      >
        <ol className="ui-toaster-list">
          <li className="ui-toast-item ui-toast-item-front">
            <ToastCard
              {...card}
              onPinnedChange={(next) => {
                if (next === pinnedRef.current) return
                pinnedRef.current = next
                if (next) onHoldChange?.(true)
              }}
            />
          </li>
        </ol>
      </section>
    </FloatingPortal>
  )
}

export interface ToastInput {
  message: string
  /** A first line in stronger type, such as the thread's name. */
  title?: string
  /** One action, such as Undo or Retry. Running it closes the toast. */
  action?: { label: string; run: () => void }
  tone?: ToastTone
  durationMs?: number
  /** A toast with the same key replaces the earlier one, so one thread never has two toasts. */
  key?: string
  /** Clicking the toast's text opens what it is about, and closes the toast. */
  onOpen?: () => void
  /** The accessible name of the open button, e.g. "Open Fix tests". */
  openLabel?: string
}

interface ToastEntry extends ToastInput { id: number; shownAt: number }

/** Newest first. */
const useToastStore = create<{ toasts: ToastEntry[] }>(() => ({ toasts: [] }))
let nextToastId = 0

/** Shows a toast at the front of the stack and returns its id. A toast with the same `key` is replaced. */
export function showToast(input: ToastInput): number {
  const id = ++nextToastId
  useToastStore.setState(({ toasts }) => ({
    toasts: [{ ...input, id, shownAt: Date.now() }, ...toasts.filter((toast) => input.key === undefined || toast.key !== input.key)].slice(0, MAX_TOASTS)
  }))
  return id
}

/** Closes the toast `id`, or every toast when no id is given. */
export function dismissToast(id?: number): void {
  useToastStore.setState(({ toasts }) => ({ toasts: id === undefined ? [] : toasts.filter((toast) => toast.id !== id) }))
}

/** Closes the toast shown with `key`, if there is one, such as when its thread is opened another way. */
export function dismissToastByKey(key: string): void {
  const { toasts } = useToastStore.getState()
  if (toasts.some((toast) => toast.key === key)) useToastStore.setState({ toasts: toasts.filter((toast) => toast.key !== key) })
}

/** Whether Mousse's window has focus. A toast that arrives while the person is away waits for them. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return focused
}

/** Runs out a toast's time, keeping what is left while `paused`. */
function useToastTimer(id: number, duration: number, paused: boolean): void {
  const remaining = useRef(duration)
  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return
    const started = Date.now()
    const timer = setTimeout(() => dismissToast(id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(400, remaining.current - (Date.now() - started))
    }
  }, [id, paused])
}

/** "now", "4m", "2h": how long ago a toast was shown. */
export function toastAge(shownAt: number, now: number): string {
  const seconds = Math.max(0, (now - shownAt) / 1000)
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** The current time, updated every 30 seconds while `active`, so toast ages stay true. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

interface Ghost { entry: ToastEntry; style: CSSProperties }

/** The window's toast stack, bottom right. Mounted once, at the app root. */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts)
  const windowFocused = useWindowFocused()
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const expanded = (hovered || focusWithin) && toasts.length > 0
  // An empty stack unmounts without a pointer leave or a blur: the next toast starts closed and counting down.
  useEffect(() => {
    if (toasts.length > 0) return
    setHovered(false)
    setFocusWithin(false)
  }, [toasts.length])
  const now = useNow(toasts.length > 0)
  const paused = expanded || !windowFocused
  const bottom = useToastBottom()

  // Each toast's measured height, so the open stack can lay them out as a list.
  const observers = useRef(new Map<number, ResizeObserver>())
  const measure = useCallback((id: number, element: HTMLElement | null) => {
    observers.current.get(id)?.disconnect()
    observers.current.delete(id)
    if (!element) return
    const read = () => {
      const height = element.getBoundingClientRect().height
      setHeights((current) => (current[id] === height ? current : { ...current, [id]: height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(element)
    observers.current.set(id, observer)
  }, [])
  useEffect(() => () => { for (const observer of observers.current.values()) observer.disconnect() }, [])

  const frontHeight = toasts[0] ? heights[toasts[0].id] ?? 0 : 0
  const offsets: number[] = []
  let total = 0
  for (const [index, toast] of toasts.entries()) {
    offsets.push(total)
    total += (heights[toast.id] ?? 0) + (index < toasts.length - 1 ? STACK_GAP : 0)
  }
  const styleFor = (index: number): CSSProperties => {
    if (expanded) {
      return { transform: `translate3d(0, ${-offsets[index]}px, 0)`, zIndex: MAX_TOASTS - index, opacity: 1 }
    }
    const behind = Math.min(index, PEEK_COUNT + 1)
    return {
      transform: `translate3d(0, ${-behind * PEEK}px, 0) scale(${1 - behind * 0.04})`,
      zIndex: MAX_TOASTS - index,
      // Each card further back recedes: smaller and dimmer, so the stack reads as depth, not layers.
      opacity: [1, 0.7, 0.45][index] ?? 0,
      // Toasts behind the front one take its height, so only their edges show.
      ...(index > 0 && frontHeight ? { height: frontHeight } : {})
    }
  }

  // A toast that leaves fades out where it was; the live list has already dropped it.
  const previous = useRef<{ toasts: ToastEntry[]; styles: Map<number, CSSProperties> }>({ toasts: [], styles: new Map() })
  useLayoutEffect(() => {
    const live = new Set(toasts.map((toast) => toast.id))
    const left = previous.current.toasts.filter((toast) => !live.has(toast.id))
    if (left.length > 0) {
      setGhosts((current) => [...current, ...left.map((entry) => ({ entry, style: previous.current.styles.get(entry.id) ?? {} }))])
      const ids = new Set(left.map((entry) => entry.id))
      setTimeout(() => setGhosts((current) => current.filter((ghost) => !ids.has(ghost.entry.id))), EXIT_MS + 40)
      setHeights((current) => {
        const next = { ...current }
        for (const id of ids) delete next[id]
        return next
      })
    }
  })
  const styles = new Map<number, CSSProperties>()
  for (const [index, toast] of toasts.entries()) styles.set(toast.id, styleFor(index))
  useLayoutEffect(() => { previous.current = { toasts, styles } })

  if (toasts.length === 0 && ghosts.length === 0) return null
  const showHead = expanded && toasts.length > 1
  // The section covers the open list and "Clear all", so moving the pointer between them keeps it open.
  const stackHeight = expanded ? total + (showHead ? HEAD_GAP + HEAD_HEIGHT : 0) : frontHeight + Math.min(toasts.length - 1, PEEK_COUNT) * PEEK
  return (
    <FloatingPortal>
      <section
        className={`ui-toaster${expanded ? ' is-expanded' : ''}`}
        aria-label="Notifications"
        style={{ height: Math.max(stackHeight, 0), ...(bottom === undefined ? {} : { bottom }) }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false) }}
      >
        {showHead && (
          <div className="ui-toaster-head" style={{ transform: `translate3d(0, ${-(total + HEAD_GAP)}px, 0)` }}>
            <button type="button" className="ui-toaster-clear" data-action="clear-all" onClick={() => dismissToast()}>Clear all</button>
          </div>
        )}
        <ol className="ui-toaster-list">
          {ghosts.map(({ entry, style }) => (
            <li key={`ghost-${entry.id}`} className="ui-toast-item ui-toast-ghost" style={style} aria-hidden="true" inert>
              <ToastCard title={entry.title} message={entry.message} tone={entry.tone} ghost />
            </li>
          ))}
          {toasts.map((toast, index) => (
            <StackedToast
              key={toast.id}
              toast={toast}
              front={index === 0}
              muted={!expanded && index > 0}
              style={styles.get(toast.id)!}
              paused={paused}
              measure={measure}
              now={now}
              depth={index}
            />
          ))}
        </ol>
      </section>
    </FloatingPortal>
  )
}

function StackedToast({
  toast,
  front,
  muted,
  style,
  paused,
  measure,
  now,
  depth
}: {
  toast: ToastEntry
  front: boolean
  /** 0 for the newest toast, counting back. */
  depth: number
  /** Behind the front toast in the closed stack: only its edge shows. */
  muted: boolean
  style: CSSProperties
  paused: boolean
  measure: (id: number, element: HTMLElement | null) => void
  now: number
}) {
  // A toast clicked open to read its full text waits until it is closed again.
  const [pinned, setPinned] = useState(false)
  useToastTimer(toast.id, toast.durationMs ?? TOAST_MS, paused || pinned)
  const [drag, setDrag] = useState(0)
  const dragStart = useRef<{ x: number; pointer: number } | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => measure(toast.id, element), [measure, toast.id])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.ui-toast-action, .ui-toast-close, .ui-toast-copy')) return
    dragStart.current = { x: event.clientX, pointer: event.pointerId }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current
    if (!start || start.pointer !== event.pointerId) return
    const dx = event.clientX - start.x
    if (Math.abs(dx) > 4 && !event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    // Only to the right, toward the edge it leaves by; a pull to the left resists.
    setDrag(dx > 0 ? dx : dx / 6)
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || dragStart.current.pointer !== event.pointerId) return
    dragStart.current = null
    if (drag > SWIPE_DISMISS_PX) dismissToast(toast.id)
    else setDrag(0)
  }
  const { action } = toast
  const open = toast.onOpen
  return (
    <li
      className={`ui-toast-item${front ? ' ui-toast-item-front' : ''}${muted ? ' is-muted' : ''}`}
      style={style}
      data-toast-id={toast.id}
      data-depth={Math.min(depth, 3)}
    >
      <div
        ref={ref}
        className={`ui-toast-swipe${drag !== 0 ? ' is-dragging' : ''}`}
        style={drag !== 0 ? { transform: `translate3d(${drag}px, 0, 0)`, opacity: Math.max(0.2, 1 - Math.max(drag, 0) / 220) } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <ToastCard
          title={toast.title}
          message={toast.message}
          tone={toast.tone}
          openLabel={toast.openLabel}
          onOpen={open ? () => { dismissToast(toast.id); open() } : undefined}
          actions={action ? [{
            label: action.label,
            dataAction: action.label.toLowerCase(),
            onClick: () => { dismissToast(toast.id); action.run() }
          }] : []}
          onDismiss={() => dismissToast(toast.id)}
          time={toast.title ? toastAge(toast.shownAt, now) : undefined}
          onPinnedChange={setPinned}
        />
      </div>
    </li>
  )
}
