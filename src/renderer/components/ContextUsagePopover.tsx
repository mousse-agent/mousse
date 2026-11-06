import { forwardRef, useEffect, useRef } from 'react'
import { modelLabel } from '../../shared/modelChoice'
import { resolveModelChoice } from '../lib/modelChoice'
import { CONTEXT_DRAFT_CATEGORY, type ContextUsageSnapshot } from '../../shared/types'
import { contextCompactionPoint, type CompactionSetting } from '../../shared/contextCompaction'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { openSettingsSection } from '../lib/settingsNavigation'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1000) {
    const k = tokens / 1000
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  return String(tokens)
}

/**
 * Whether the snapshot says how full the context is: the model's capacity is reported and the
 * context itself (not the unsent draft) holds tokens. A new chat, a provider that reports no
 * usage, and a snapshot that has not arrived yet are unknown, never "0%".
 */
export function contextUsageKnown(usage: ContextUsageSnapshot): boolean {
  if (!Number.isFinite(usage.limit) || usage.limit <= 0) return false
  return usage.categories.some((category) => category.label !== CONTEXT_DRAFT_CATEGORY && category.tokens > 0)
}

export type ContextUsageLevel = 'normal' | 'warning' | 'danger'

/** Accent below 75%, warning from 75%, danger from 90%. */
export function contextUsageLevel(percent: number): ContextUsageLevel {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warning'
  return 'normal'
}

/** "62% · 124K of 200K", with "~" when the count is estimated rather than measured. */
export function contextUsageSummary(usage: ContextUsageSnapshot): string {
  const percent = usage.percent === 0 && usage.used > 0 ? '<1%' : `${usage.percent}%`
  const approximate = usage.source === 'measured' ? '' : '~'
  return `${percent} · ${approximate}${formatTokenCount(usage.used)} of ${formatTokenCount(usage.limit)}`
}

/** Where this context compacts: at a size, near the window's limit, or never. */
export type ContextCompaction = { kind: 'at'; tokens: number } | { kind: 'near-limit' } | { kind: 'off' }

/**
 * The context's compaction under the Compact context setting, worked out as the daemon does. A
 * runtime that compacts its own context (Pi) only takes the on/off: it compacts near its limit.
 */
export function contextCompaction(setting: CompactionSetting, usage: ContextUsageSnapshot): ContextCompaction {
  if (!setting.compactionEnabled) return { kind: 'off' }
  if (usage.compactedByRuntime) return { kind: 'near-limit' }
  const tokens = contextCompactionPoint(setting, usage.limit > 0 ? usage.limit : undefined)
  return tokens === undefined ? { kind: 'near-limit' } : { kind: 'at', tokens }
}

/** "Compacts at 300K", "Compacts near the limit" or "Compaction off". */
export function contextCompactionText(compaction: ContextCompaction): string {
  if (compaction.kind === 'off') return 'Compaction off'
  if (compaction.kind === 'near-limit') return 'Compacts near the limit'
  return `Compacts at ${formatTokenCount(compaction.tokens)}`
}

/** Where the usage bar marks the compaction point, as a share of the window; none when it is not inside it. */
export function compactionMarkFraction(compaction: ContextCompaction | undefined, usage: ContextUsageSnapshot): number | undefined {
  if (compaction?.kind !== 'at' || !(usage.limit > 0) || compaction.tokens >= usage.limit) return undefined
  return compaction.tokens / usage.limit
}

interface ContextUsagePopoverProps {
  open: boolean
  onClose: () => void
  usage: ContextUsageSnapshot
  /** Where the context compacts; no line before the setting is read. */
  compaction?: ContextCompaction
  /** The selected provider, to name the measured model as the picker does. */
  providerId: string
  anchorRef: React.RefObject<HTMLElement | null>
}

/**
 * What fills the model's context: the share and totals, a bar against capacity, the breakdown, and
 * where it compacts with a way to change that. Only opened for a snapshot where `contextUsageKnown` holds.
 */
export function ContextUsagePopover({
  open,
  onClose,
  usage,
  providerId,
  anchorRef,
  compaction
}: ContextUsagePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const floatingStyle = useFloatingPosition({
    open,
    anchorRef,
    contentRef: popoverRef,
    placement: 'above-end',
    deps: [usage.percent, usage.used, usage.limit, usage.modelName]
  })

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        popoverRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return
      }
      onClose()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  const segmentTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0)
  const barScale = Math.max(usage.limit, segmentTotal)
  const compactionFraction = compactionMarkFraction(compaction, usage)
  // Settings, Agents, focused on the Compact context row.
  const changeCompaction = () => {
    onClose()
    openSettingsSection('context')
  }

  return (
    <FloatingPortal>
      <div
        className="context-usage-popover context-usage-popover-floating"
        ref={popoverRef}
        role="dialog"
        aria-label={`Context usage: ${contextUsageSummary(usage)} tokens`}
        style={floatingStyle}
      >
        <div className="context-usage-header">
          <span className="context-usage-title">Context</span>
          {usage.modelName && (
            <span className="context-usage-model" title={usage.modelName}>{modelLabel(resolveModelChoice({ provider: providerId, model: usage.modelName }))}</span>
          )}
        </div>

        <div className="context-usage-summary">{contextUsageSummary(usage)}</div>

        <div className="context-usage-bar-track" aria-hidden="true">
          <div className="context-usage-bar">
            {usage.categories.map((category) => (
              <div
                key={category.label}
                className="context-usage-bar-segment"
                style={{
                  width: barScale > 0 ? `${(category.tokens / barScale) * 100}%` : 0,
                  backgroundColor: category.color
                }}
              />
            ))}
          </div>
          {/* Outside the clipped bar, so the mark can stand a little proud of it. */}
          {compactionFraction !== undefined && barScale > 0 && (
            <div
              className="context-usage-bar-compaction"
              style={{ left: `${(compactionFraction * usage.limit / barScale) * 100}%` }}
            />
          )}
        </div>

        <ul className="context-usage-breakdown">
          {usage.categories.map((category) => (
            <li key={category.label} className="context-usage-item">
              <span className="context-usage-swatch" style={{ backgroundColor: category.color }} />
              <span className="context-usage-item-label">{category.label}</span>
              <span className="context-usage-item-value">{formatTokenCount(category.tokens)}</span>
            </li>
          ))}
        </ul>

        {compaction && (
          <div className="context-usage-compaction">
            <span className="context-usage-compaction-text">{contextCompactionText(compaction)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm context-usage-compaction-change"
              title="Settings › Agents › Compact context"
              aria-label="Change Compact context"
              onClick={changeCompaction}
            >
              Change
            </button>
          </div>
        )}

        {(usage.processedTokens !== undefined || usage.source === 'legacy-estimated') && (
          <div className="context-usage-notes">
            {usage.processedTokens !== undefined && (
              <p>Last reply read {formatTokenCount(usage.processedTokens)} tokens across model calls.</p>
            )}
            {usage.source === 'legacy-estimated' && (
              <p>Estimate: older tool calls, results and reasoning could not be recovered.</p>
            )}
          </div>
        )}
      </div>
    </FloatingPortal>
  )
}

interface ContextUsageRingProps {
  /** A snapshot where `contextUsageKnown` holds; the caller renders no ring otherwise. */
  usage: ContextUsageSnapshot
  onClick: () => void
  active: boolean
}

export const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(
  function ContextUsageRing({ usage, onClick, active }, ref) {
    const radius = 9
    const circumference = 2 * Math.PI * radius
    const percent = Math.min(100, Math.max(0, usage.percent))
    const strokeOffset = circumference - (percent / 100) * circumference
    const summary = contextUsageSummary(usage)

    return (
      <button
        ref={ref}
        type="button"
        className={`composer-icon-btn context-usage-btn${active ? ' active' : ''}`}
        onClick={onClick}
        title={summary}
        aria-label={`Context usage: ${summary} tokens`}
        aria-expanded={active}
      >
        <svg
          className={`context-usage-ring is-${contextUsageLevel(percent)}`}
          width="20"
          height="20"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <circle className="context-usage-ring-track" cx="10" cy="10" r={radius} fill="none" strokeWidth="2" />
          <circle
            className="context-usage-ring-arc"
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
    )
  }
)
