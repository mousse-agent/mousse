import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from '../lib/icons'
import { attentionReason, otherUsageFigure, usageInstanceId } from '../lib/usageSections'
import type { ProviderUsage } from '../../shared/providerAuth'
import { Collapse, COLLAPSE_OPEN_MS, COLLAPSE_STAGGER_ITEMS, COLLAPSE_STAGGER_MS } from './ui/Collapse'
import { UsageBar } from './UsageBar'

/** Whether the list a row joins is open and done opening: only then does a joining row grow in itself. */
const ListSettledContext = createContext(false)

/**
 * Where one provider's row sits in a list, kept across its skeleton and its real row so swapping one
 * for the other changes nothing around it. Both of its motions play once, when they happen, and never
 * again: a provider that joins a list that is already open grows in from no height (rows there when
 * the list opens are carried by the list's own motion), and a row that replaces its skeleton fades in.
 */
export function UsageRowSlot({ children, hidden, loading }: { children: ReactNode; hidden?: boolean; loading?: boolean }) {
  const joined = useRef(useContext(ListSettledContext)).current
  const wasLoading = useRef(!!loading)
  const [filled, setFilled] = useState(false)
  // Before paint, so the row never shows at full strength for a frame before its fade starts.
  useLayoutEffect(() => {
    if (wasLoading.current && !loading) setFilled(true)
    wasLoading.current = !!loading
  }, [loading])
  return <div className={`usage-row-slot${joined ? ' is-new' : ''}${hidden ? ' is-hidden' : ''}`} data-hidden={hidden || undefined}>
    <div className={`usage-row-slot-clip${filled ? ' is-filled' : ''}`}>{children}</div>
  </div>
}

/** A provider's row while its usage is still on the way: its name and a slim placeholder. */
export function UsageRowSkeleton({ provider }: { provider: ProviderUsage }) {
  return <div className="usage-slim-row" data-testid="usage-row-loading" aria-busy="true">
    <span className="usage-slim-name">{provider.label}</span>
    <span className="usage-skeleton usage-skeleton-figure" aria-hidden="true" />
  </div>
}

/** A subscription card's body while its usage is on the way: two slim bars, the size of the real ones. */
export function UsageCardSkeleton() {
  return <div className="usage-windows usage-card-skeleton" data-testid="usage-card-loading" aria-busy="true" aria-label="Loading usage">
    {[0, 1].map((index) => <div key={index} className="usage-window" aria-hidden="true">
      <div className="usage-window-head"><span className="usage-skeleton usage-skeleton-label" /><span className="usage-skeleton usage-skeleton-value" /></div>
      <span className="usage-skeleton usage-skeleton-bar" />
      <span className="usage-skeleton usage-skeleton-reset" />
    </div>)}
  </div>
}

/** One provider in Other usage: its name, and its key figure on the right; a mini bar only against a limit. */
export function OtherUsageRow({ provider, computerName, menu }: { provider: ProviderUsage; computerName?: string; menu?: ReactNode }) {
  const figure = otherUsageFigure(provider)
  const none = figure.text === 'No usage data'
  return <div className="usage-slim-row" data-testid="usage-other-row">
    <span className="usage-slim-name">{provider.label}{computerName && <span className="settings-muted"> · {computerName}</span>}</span>
    <span className="usage-slim-figure">
      {figure.remaining !== undefined && <span className="usage-slim-bar"><UsageBar remaining={figure.remaining} label={provider.label} size="cell" /></span>}
      <span className={none ? 'settings-muted' : undefined}>{figure.text}</span>
      {menu}
    </span>
  </div>
}

/** One provider in Needs attention: its name, why in a few words, and Reconnect where signing in again fixes it. */
export function AttentionRow({ provider, computerName, onReconnect, menu }: { provider: ProviderUsage; computerName?: string; onReconnect?: (instanceId: string) => void; menu?: ReactNode }) {
  const reason = attentionReason(provider)
  return <div className={`usage-slim-row usage-attention-row${reason.rank === 2 ? ' is-faint' : ''}`} data-testid="usage-attention-row" tabIndex={-1}>
    <span className="usage-slim-name">{provider.label}{computerName && <span className="settings-muted"> · {computerName}</span>}</span>
    <span className="usage-slim-figure">
      <span className="settings-muted" title={provider.message}>{reason.text}</span>
      {reason.reconnect && onReconnect && !computerName && <button type="button" className="usage-text-btn" data-testid="usage-reconnect" onClick={() => onReconnect(usageInstanceId(provider.id))}>Reconnect</button>}
      {menu}
    </span>
  </div>
}

/**
 * A compact list under its own header, "Other usage · 1 ⌄": a background, no border; it opens and
 * closes with the app's collapse motion. Needs attention is \`dimmed\`.
 */
export function UsageCollapsibleSection({ id, title, count, open, onToggle, dimmed, children }: {
  id: string
  title: string
  count: number
  open: boolean
  onToggle: () => void
  dimmed?: boolean
  children: ReactNode
}) {
  const bodyId = useId()
  // The list counts as settled once it has been open past its opening motion; opening or closing it
  // starts over, so rows that mount with the list never grow by themselves.
  const [settled, setSettled] = useState(false)
  const [seenOpen, setSeenOpen] = useState(open)
  if (open !== seenOpen) {
    setSeenOpen(open)
    setSettled(false)
  }
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setSettled(true), COLLAPSE_OPEN_MS + COLLAPSE_STAGGER_MS * (COLLAPSE_STAGGER_ITEMS - 1) + 60)
    return () => clearTimeout(timer)
  }, [open])
  return <section id={id} className={`usage-section usage-enter${dimmed ? ' is-dimmed' : ''}`} data-testid={`usage-section-${id}`} data-open={open}>
    <button type="button" className="usage-section-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
      <span>{title}</span>
      <span className="settings-muted">· {count}</span>
      <ChevronDown size={14} aria-hidden="true" className="usage-section-chevron" />
    </button>
    <Collapse open={open} id={bodyId} className="usage-section-body" itemCount={count}>
      <ListSettledContext.Provider value={settled}>{children}</ListSettledContext.Provider>
    </Collapse>
  </section>
}
