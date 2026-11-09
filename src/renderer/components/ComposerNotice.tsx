import { createContext, useContext, useId, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, CircleAlert, Info, X } from '../lib/icons'

/**
 * The dock on the composer's top edge, which shows one thing at a time. Every source (a failed send,
 * Undo, dictation, a paused run, the lost background service) registers its notice with
 * `useComposerNotice`. The dock shows the highest priority (`ComposerDockPriority`), newest first
 * within one; the others show once it
 * is dismissed or resolves. One exception: the lost background service over a waiting approval shows as
 * two rows, the service on top, since the approval cannot be answered until it reconnects.
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
  /** The action the notice is asking for; its text is the accent, the others are muted. */
  primary?: boolean
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
  /** Scrolls to what the notice is about (an approval's row in the transcript). */
  onJump?: () => void
  jumpLabel?: string
  /** Hides the notice. A notice without it resolves by itself. */
  onDismiss?: () => void
  /** Accessible name of the notice group, when the title alone does not say what it is. */
  label?: string
  /** Its place in the dock's order, when the tone alone does not say it (the lost service, a paused run). */
  priority?: ComposerDockPriority
}

/**
 * What the dock shows, highest first; one thing at a time. A notice without `priority` ranks by its tone
 * (an error with the errors, a warning just under them, info last).
 */
export type ComposerDockPriority = 'service' | 'paused' | 'approval' | 'error' | 'warning' | 'info'

const PRIORITY_RANK: Record<ComposerDockPriority, number> = { info: 0, warning: 1, error: 2, approval: 3, paused: 4, service: 5 }

function ToneIcon({ tone }: { tone: ComposerNoticeTone }) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? AlertTriangle : Info
  return <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
}

/** One notice: tone icon, one line, its actions, then jump and dismiss icons. */
export function ComposerNotice({ tone, title, shortTitle, detail, tooltip, icon, actions = [], onJump, jumpLabel = 'Show', onDismiss, label, priority }: ComposerNoticeProps) {
  return (
    <div className="composer-notice" data-tone={tone} data-priority={priority} role="group" aria-label={label ?? title}>
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
          className={action.icon ? 'composer-notice-icon-btn' : action.primary ? 'composer-notice-btn composer-notice-btn-primary' : 'composer-notice-btn'}
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

interface Entry { notice: ComposerNoticeProps; rank: number; order: number }

/**
 * Everything that wants the dock above one composer, and the one notice it shows: the highest priority,
 * the newest within a priority.
 */
export class ComposerNoticeStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private counter = 0
  private current: ComposerNoticeProps | null = null
  private stacked: ComposerNoticeProps | null = null

  /** Registers, updates (`notice`) or removes (`null`) the notice of one source. */
  set(id: string, notice: ComposerNoticeProps | null): void {
    const entry = this.entries.get(id)
    if (notice) this.entries.set(id, { notice, rank: PRIORITY_RANK[notice.priority ?? notice.tone], order: entry?.order ?? ++this.counter })
    else if (entry) this.entries.delete(id)
    else return
    this.update()
  }

  readonly top = (): ComposerNoticeProps | null => this.current

  /** The row above `top`: the lost service while `top` is a waiting approval, else null. */
  readonly above = (): ComposerNoticeProps | null => this.stacked

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(): void {
    let id = this.pickId()
    let stacked: ComposerNoticeProps | null = null
    // The lost service over a waiting approval: the approval stays, with the service on a row above it.
    if (id && this.entries.get(id)?.rank === PRIORITY_RANK.service) {
      const under = this.pickId((entry) => entry.rank !== PRIORITY_RANK.service)
      if (under && this.entries.get(under)?.rank === PRIORITY_RANK.approval) {
        stacked = this.entries.get(id)?.notice ?? null
        id = under
      }
    }
    const notice = id ? this.entries.get(id)?.notice ?? null : null
    if (notice === this.current && stacked === this.stacked) return
    this.current = notice
    this.stacked = stacked
    for (const listener of this.listeners) listener()
  }

  private pickId(include: (entry: Entry) => boolean = () => true): string | null {
    let best: [string, Entry] | undefined
    for (const candidate of this.entries) {
      const [, entry] = candidate
      if (!include(entry)) continue
      if (!best) { best = candidate; continue }
      const rank = entry.rank - best[1].rank
      if (rank > 0 || (rank === 0 && entry.order > best[1].order)) best = candidate
    }
    return best?.[0] ?? null
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

const NO_STORE = { subscribe: () => () => undefined, top: () => null, above: () => null }

/**
 * The dock on the composer's top edge: the top notice, or nothing. A quiet line in the composer stack,
 * right above it.
 */
export function ComposerNoticeSlot() {
  const store = useContext(ComposerNoticeContext) ?? NO_STORE
  const notice = useSyncExternalStore(store.subscribe, store.top)
  const above = useSyncExternalStore(store.subscribe, store.above)
  if (!notice) return null
  return (
    <div className="composer-notice-slot">
      {above && <ComposerNotice {...above} />}
      <ComposerNotice {...notice} />
    </div>
  )
}
