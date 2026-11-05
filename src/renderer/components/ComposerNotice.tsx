import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, CircleAlert, Info, MoreHorizontal, X } from '../lib/icons'
import { focusInitialMenuItem, useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { IconButton } from './ui/IconButton'

/**
 * The one notice line above the composer. Every source (a failed send, Undo, the queue, dictation,
 * a paused run, a waiting approval) registers its notice with `useComposerNotice`; the slot shows only
 * the most severe one, newest first within a tone. The others show once it is dismissed or resolves.
 */

export type ComposerNoticeTone = 'info' | 'warning' | 'error'

export interface ComposerNoticeAction {
  /** The button text, or the tooltip and accessible name when `icon` is set. */
  label: string
  onClick: () => void
  /** Makes the button icon-only. Use it for common actions (retry, stop); uncommon ones stay text. */
  icon?: ReactNode
  /** Tooltip for a text button. */
  title?: string
  disabled?: boolean
  /** Presses are ignored, but the button keeps focus (`aria-disabled`), e.g. while another press settles. */
  blocked?: boolean
  /** This button's press is in flight. */
  busy?: boolean
}

/** A rarer action, in the notice's "…" menu. */
export interface ComposerNoticeMenuItem {
  label: string
  onSelect: () => void
  /** Presses are ignored, but the item stays reachable (`aria-disabled`). */
  blocked?: boolean
}

export interface ComposerNoticeProps {
  tone: ComposerNoticeTone
  /** One short line. Longer wording goes in `tooltip`. */
  title: string
  /** Replaces `title` when the line is narrow. */
  shortTitle?: string
  /** Quieter text after the title on the same line, cut to fit (the steered text, an approval's command). */
  detail?: string
  /** The full wording, shown on hover. */
  tooltip?: string
  /** Replaces the tone icon (a paused run shows a pause glyph). */
  icon?: ReactNode
  /** Usually at most one; an approval shows two (Deny, Approve). */
  actions?: ComposerNoticeAction[]
  /** Rarer actions, behind a "…" button after `actions`. */
  menu?: ComposerNoticeMenuItem[]
  /** Scrolls to what the notice is about (an approval's row in the transcript). */
  onJump?: () => void
  jumpLabel?: string
  /** Hides the notice. A notice without it resolves by itself. */
  onDismiss?: () => void
  /** Accessible name of the notice group, when the title alone does not say what it is. */
  label?: string
}

const TONE_RANK: Record<ComposerNoticeTone, number> = { info: 0, warning: 1, error: 2 }

function ToneIcon({ tone }: { tone: ComposerNoticeTone }) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? AlertTriangle : Info
  return <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
}

/** The notice's "…" button and its menu. Arrows, Home and End move; Escape and Tab close it. */
function ComposerNoticeMenu({ items }: { items: ComposerNoticeMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const style = useFloatingPosition({ open, anchorRef: triggerRef, contentRef: menuRef, placement: 'above-end', gap: 4 })
  const close = useCallback(() => setOpen(false), [])
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])
  const dismissRefs = useMemo(() => [triggerRef, menuRef], [])
  useOutsideDismiss(open, dismissRefs, close)
  useEffect(() => {
    if (open && style.visibility === 'visible') focusInitialMenuItem(menuRef.current)
  }, [open, style.visibility])
  const menuKeyDown = useMenuKeyboard(menuRef, closeAndFocus)
  return (
    <>
      <IconButton
        ref={triggerRef}
        icon={MoreHorizontal}
        label="More"
        size={14}
        className="composer-notice-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
      />
      {open && (
        <FloatingPortal>
          <div ref={menuRef} id={menuId} className="composer-mode-menu composer-mode-menu-floating" role="menu" aria-label="More" style={style} onKeyDown={menuKeyDown}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="composer-mode-menu-item"
                aria-disabled={item.blocked || undefined}
                onClick={() => {
                  if (item.blocked) return
                  closeAndFocus()
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** One notice: tone icon, one line, its actions and "…" menu, then jump and dismiss icons. */
export function ComposerNotice({ tone, title, shortTitle, detail, tooltip, icon, actions = [], menu, onJump, jumpLabel = 'Show', onDismiss, label }: ComposerNoticeProps) {
  return (
    <div className="composer-notice" data-tone={tone} role="group" aria-label={label ?? title}>
      <span className="composer-notice-icon">{icon ?? <ToneIcon tone={tone} />}</span>
      <span className="composer-notice-text" role={tone === 'error' ? 'alert' : 'status'} title={tooltip ?? (detail ? `${title}: ${detail}` : title)}>
        <span className="composer-notice-title">
          {shortTitle
            ? <><span className="composer-notice-title-full">{title}</span><span className="composer-notice-title-short">{shortTitle}</span></>
            : title}
        </span>
        {detail && <span className="composer-notice-detail">{detail}</span>}
      </span>
      {actions.map((action, index) => (
        <button
          // By position: a label that changes while busy ("Resuming…") must not remount the focused button.
          key={index}
          type="button"
          className={action.icon ? 'composer-notice-icon-btn' : 'composer-notice-btn'}
          title={action.icon ? action.label : action.title}
          aria-label={action.icon ? action.label : undefined}
          disabled={action.disabled}
          aria-disabled={action.blocked || undefined}
          aria-busy={action.busy || undefined}
          onClick={() => { if (!action.blocked) action.onClick() }}
        >
          {action.icon ?? action.label}
        </button>
      ))}
      {menu && menu.length > 0 && <ComposerNoticeMenu items={menu} />}
      {onJump && (
        <button type="button" className="composer-notice-icon-btn" title={jumpLabel} aria-label={jumpLabel} onClick={onJump}>
          <ArrowDown size={14} strokeWidth={1.8} />
        </button>
      )}
      {onDismiss && (
        <button type="button" className="composer-notice-icon-btn" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
}

interface Entry { notice: ComposerNoticeProps; order: number }

/** The notices registered under one composer, and the one on top. */
export class ComposerNoticeStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private counter = 0
  private current: ComposerNoticeProps | null = null

  /** Registers, updates (`notice`) or removes (`null`) the notice of one source. */
  set(id: string, notice: ComposerNoticeProps | null): void {
    const entry = this.entries.get(id)
    if (notice) this.entries.set(id, { notice, order: entry?.order ?? ++this.counter })
    else if (entry) this.entries.delete(id)
    else return
    const next = this.pick()
    if (next === this.current) return
    this.current = next
    for (const listener of this.listeners) listener()
  }

  readonly top = (): ComposerNoticeProps | null => this.current

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private pick(): ComposerNoticeProps | null {
    let best: Entry | undefined
    for (const entry of this.entries.values()) {
      if (!best) { best = entry; continue }
      const rank = TONE_RANK[entry.notice.tone] - TONE_RANK[best.notice.tone]
      if (rank > 0 || (rank === 0 && entry.order > best.order)) best = entry
    }
    return best?.notice ?? null
  }
}

const ComposerNoticeContext = createContext<ComposerNoticeStore | null>(null)

/** Collects the notices of everything rendered inside it. Put one `ComposerNoticeSlot` inside it. */
export function ComposerNoticeProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ComposerNoticeStore())
  return <ComposerNoticeContext.Provider value={store}>{children}</ComposerNoticeContext.Provider>
}

/**
 * Shows `notice` in the composer's notice slot while it is not null. Call it on every render with the
 * current notice; the slot always has the latest text and handlers. Without a provider it does nothing.
 */
export function useComposerNotice(notice: ComposerNoticeProps | null): void {
  const store = useContext(ComposerNoticeContext)
  const id = useId()
  useLayoutEffect(() => { store?.set(id, notice) })
  useLayoutEffect(() => () => { store?.set(id, null) }, [store, id])
}

/** A notice from a component that has no other output (state held by the composer's parent). */
export function ComposerNoticeSource({ notice }: { notice: ComposerNoticeProps | null }) {
  useComposerNotice(notice)
  return null
}

const NO_STORE = { subscribe: () => () => undefined, top: () => null }

/** The line above the composer: the top notice, or nothing. It floats, so the composer never moves. */
export function ComposerNoticeSlot() {
  const store = useContext(ComposerNoticeContext) ?? NO_STORE
  const notice = useSyncExternalStore(store.subscribe, store.top)
  if (!notice) return null
  return <div className="composer-notice-slot"><ComposerNotice {...notice} /></div>
}
