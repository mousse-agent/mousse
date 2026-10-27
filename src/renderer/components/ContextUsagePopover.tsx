import { forwardRef, useEffect, useRef } from 'react'
import { Settings } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { modelDisplayName } from '../lib/providerSnapshots'
import type { ContextUsageSnapshot } from '../../shared/types'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1000) {
    const k = tokens / 1000
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  return String(tokens)
}

interface ContextUsagePopoverProps {
  open: boolean
  onClose: () => void
  usage: ContextUsageSnapshot
  /** The selected provider, to name the measured model as the picker does. */
  providerId: string
  anchorRef: React.RefObject<HTMLElement | null>
}

/**
 * How full the model's context is: the share as a number and a bar against capacity, what fills
 * it, and a link to the compaction settings.
 */
export function ContextUsagePopover({
  open,
  onClose,
  usage,
  providerId,
  anchorRef
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

  const capacityKnown = Number.isFinite(usage.limit) && usage.limit > 0
  const segmentTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0)
  // Against capacity the bar shows how full the context is; without one, only what fills it.
  const barScale = capacityKnown ? Math.max(usage.limit, segmentTotal) : segmentTotal
  const percentLabel = !capacityKnown ? '—' : usage.percent === 0 && usage.used > 0 ? '<1%' : `${usage.percent}%`
  const approximate = usage.source === 'measured' ? '' : '~'
  const openSettings = () => {
    onClose()
    window.location.hash = 'settings-context-compaction'
    useAppStore.getState().setSettingsOpen(true)
    window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: 'context' }))
  }

  return (
    <FloatingPortal>
      <div
        className="context-usage-popover context-usage-popover-floating"
        ref={popoverRef}
        role="dialog"
        aria-label="Context usage"
        style={floatingStyle}
      >
        <div className="context-usage-header">
          <span className="context-usage-title">Context</span>
          {usage.modelName && (
            <span className="context-usage-model" title={usage.modelName}>{modelDisplayName(providerId, usage.modelName)}</span>
          )}
          <button
            type="button"
            className="context-usage-settings"
            aria-label="Context compaction settings"
            title="Context compaction settings"
            onClick={openSettings}
          >
            <Settings size={14} />
          </button>
        </div>

        <div className="context-usage-summary">
          <span className="context-usage-percent">{percentLabel}</span>
          <span className="context-usage-total">
            {approximate}{formatTokenCount(usage.used)}
            {capacityKnown ? ` of ${formatTokenCount(usage.limit)} tokens` : ' tokens · capacity not reported yet'}
          </span>
        </div>

        <div className="context-usage-bar" aria-hidden="true">
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

        <ul className="context-usage-breakdown">
          {usage.categories.map((category) => (
            <li key={category.label} className="context-usage-item">
              <span className="context-usage-swatch" style={{ backgroundColor: category.color }} />
              <span className="context-usage-item-label">{category.label}</span>
              <span className="context-usage-item-value">{formatTokenCount(category.tokens)}</span>
            </li>
          ))}
        </ul>

        <div className="context-usage-notes">
          {usage.processedTokens !== undefined && (
            <p>Last reply read {formatTokenCount(usage.processedTokens)} tokens across model calls.</p>
          )}
          {usage.source === 'legacy-estimated' && (
            <p>Estimate: older tool calls, results and reasoning could not be recovered.</p>
          )}
          <p>Compacts automatically at your threshold, sometimes sooner to leave room for the reply.</p>
        </div>
      </div>
    </FloatingPortal>
  )
}

interface ContextUsageRingProps {
  percent: number
  capacityKnown?: boolean
  onClick: () => void
  active: boolean
}

export const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(
  function ContextUsageRing({ percent, capacityKnown = true, onClick, active }, ref) {
    const radius = 9
    const circumference = 2 * Math.PI * radius
    const strokeOffset = circumference - (percent / 100) * circumference

    return (
      <button
        ref={ref}
        type="button"
        className={`composer-icon-btn context-usage-btn${active ? ' active' : ''}`}
        onClick={onClick}
        title={capacityKnown ? 'Context usage' : 'Context usage: model capacity not reported yet'}
        aria-label={capacityKnown ? `Context usage ${percent}% full` : 'Context usage, model capacity not reported yet'}
        aria-expanded={active}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            stroke="rgba(var(--accent-rgb), 0.2)"
            strokeWidth="2"
          />
          {capacityKnown && (
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              stroke="var(--accent-hover)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeOffset}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      </button>
    )
  }
)
