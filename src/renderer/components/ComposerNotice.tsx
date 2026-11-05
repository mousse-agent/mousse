import { createContext, useCallback, useContext, useId, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown, CircleAlert, Info, X } from '../lib/icons'

/**
 * The dock on the composer's top edge, which shows one thing at a time. Every source (a failed send,
 * Undo, dictation, a paused run, the lost background service) registers its notice with
 * `useComposerNotice`, and the queued-messages strip takes part with `useComposerDockStrip`. The dock
 * shows the highest priority (`ComposerDockPriority`), newest first within one; the others show once it
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
  /** The action the notice is asking for; it gets a tinted fill, the others stay text. */
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
 * (an error with the errors, a warning just under them, info last), so the queue sits under any error.
 */
export type ComposerDockPriority = 'service' | 'paused' | 'approval' | 'error' | 'warning' | 'queue' | 'info'

const PRIORITY_RANK: Record<ComposerDockPriority, number> = { info: 0, queue: 1, warning: 2, error: 3, approval: 4, paused: 5, service: 6 }

/** How long a message queued behind a higher notice shows the queue before the notice comes back. */
export const QUEUE_REVEAL_MS = 2500
/** The dock's fade out; `--composer-dock-fade` in app.css is the same. */
export const DOCK_FADE_MS = 160

function ToneIcon({ tone }: { tone: ComposerNoticeTone }) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? AlertTriangle : Info
  return <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
}

/** One notice: tone icon, one line, its actions, then jump and dismiss icons. */
export function ComposerNotice({ tone, title, shortTitle, detail, tooltip, icon, actions = [], onJump, jumpLabel = 'Show', onDismiss, label }: ComposerNoticeProps) {
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

/** A notice, or a strip that draws itself in the dock (the queue: `notice` is null). */
interface Entry { notice: ComposerNoticeProps | null; rank: number; order: number }

/** What a strip shows: drawn, fading out after a reveal, or hidden behind a higher entry. */
export type ComposerDockStripState = 'shown' | 'leaving' | 'hidden'

/**
 * Everything that wants the dock above one composer, and the one entry it shows: the highest priority,
 * the newest within a priority. A revealed strip (`reveal`) shows over all of them for a moment.
 */
export class ComposerNoticeStore {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private counter = 0
  private currentId: string | null = null
  private current: ComposerNoticeProps | null = null
  private revealed: string | null = null
  private leaving: string | null = null
  private revealTimer: ReturnType<typeof setTimeout> | null = null

  /** Registers, updates (`notice`) or removes (`null`) the notice of one source. */
  set(id: string, notice: ComposerNoticeProps | null): void {
    this.put(id, notice ? { notice, rank: PRIORITY_RANK[notice.priority ?? notice.tone] } : null)
  }

  /** Registers (`present`) or removes a strip that draws itself when it is on top (the queue). */
  setStrip(id: string, present: boolean, priority: ComposerDockPriority = 'queue'): void {
    this.put(id, present ? { notice: null, rank: PRIORITY_RANK[priority] } : null)
  }

  /**
   * Shows the strip `id` over everything for `ms` (a message just queued behind a paused run), then
   * fades it out and gives the dock back. Nothing happens when it is already on top by priority.
   */
  reveal(id: string, ms = QUEUE_REVEAL_MS): void {
    if (!this.entries.has(id) || (this.revealed !== id && this.pickId() === id)) return
    this.clearReveal()
    this.revealed = id
    this.revealTimer = setTimeout(() => {
      this.leaving = id
      this.update()
      this.revealTimer = setTimeout(() => { this.clearReveal(); this.update() }, DOCK_FADE_MS)
    }, ms)
    this.update()
  }

  readonly top = (): ComposerNoticeProps | null => this.current

  /** The row above `top`: the lost service while `top` is a waiting approval, else null. */
  readonly above = (): ComposerNoticeProps | null => this.stacked

  readonly stripState = (id: string): ComposerDockStripState =>
    this.currentId !== id ? 'hidden' : this.leaving === id ? 'leaving' : 'shown'

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private put(id: string, next: Omit<Entry, 'order'> | null): void {
    const entry = this.entries.get(id)
    if (next) this.entries.set(id, { ...next, order: entry?.order ?? ++this.counter })
    else if (entry) {
      this.entries.delete(id)
      if (this.revealed === id) this.clearReveal()
    } else return
    this.update()
  }

  private clearReveal(): void {
    if (this.revealTimer) clearTimeout(this.revealTimer)
    this.revealTimer = null
    this.revealed = null
    this.leaving = null
  }

  private update(): void {
    let id = this.revealed ?? this.pickId()
    let stacked: ComposerNoticeProps | null = null
    // The lost service over a waiting approval: the approval stays, with the service on a row above it.
    if (!this.revealed && id && this.entries.get(id)?.rank === PRIORITY_RANK.service) {
      const under = this.pickId((entry) => entry.rank !== PRIORITY_RANK.service)
      if (under && this.entries.get(under)?.rank === PRIORITY_RANK.approval) {
        stacked = this.entries.get(id)?.notice ?? null
        id = under
      }
    }
    const notice = id ? this.entries.get(id)?.notice ?? null : null
    const leaving = this.leaving
    if (id === this.currentId && notice === this.current && stacked === this.stacked && leaving === this.shownLeaving) return
    this.currentId = id
    this.current = notice
    this.stacked = stacked
    this.shownLeaving = leaving
    for (const listener of this.listeners) listener()
  }

  private stacked: ComposerNoticeProps | null = null
  private shownLeaving: string | null = null

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
const ALWAYS_SHOWN = (): ComposerDockStripState => 'shown'

/**
 * Takes part in the dock as a strip that draws itself (the queue). Returns whether to draw it now, and
 * `reveal`, which shows it over a higher notice for a moment. Without a provider it is always shown.
 */
export function useComposerDockStrip(present: boolean): { state: ComposerDockStripState; reveal: () => void } {
  const store = useContext(ComposerNoticeContext)
  const id = useId()
  useLayoutEffect(() => { store?.setStrip(id, present) }, [store, id, present])
  useLayoutEffect(() => () => { store?.setStrip(id, false) }, [store, id])
  const state = useSyncExternalStore(store?.subscribe ?? NO_STORE.subscribe, store ? () => store.stripState(id) : ALWAYS_SHOWN)
  const reveal = useCallback(() => { store?.reveal(id) }, [store, id])
  return { state, reveal }
}

/**
 * The dock on the composer's top edge: the top notice, or nothing (also when a strip such as the queue
 * is on top; it draws itself in the same place). It sits in the composer stack, joined to the composer.
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
