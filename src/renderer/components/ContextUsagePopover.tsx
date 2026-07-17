import { forwardRef, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ContextUsageSnapshot } from '../../shared/types'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  return String(tokens)
}

function formatTotalTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`
  }
  return String(tokens)
}

interface ContextUsagePopoverProps {
  open: boolean
  onClose: () => void
  usage: ContextUsageSnapshot
  anchorRef: React.RefObject<HTMLElement | null>
}

export function ContextUsagePopover({
  open,
  onClose,
  usage,
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

  const segmentTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0)

  return (
    <FloatingPortal>
      <div
        className="context-usage-popover context-usage-popover-floating"
        ref={popoverRef}
        role="dialog"
        aria-label="Context Usage"
        style={floatingStyle}
      >
        <div className="context-usage-header">
          <span className="context-usage-title">Context Usage</span>
          <button type="button" className="context-usage-close" onClick={onClose} aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {usage.modelName && (
          <div className="context-usage-model">{usage.modelName}</div>
        )}

        <div className="context-usage-summary">
          <span className="context-usage-percent">{usage.percent}% Full</span>
          <span className="context-usage-total">
            {usage.source === 'measured' ? '' : '~'}
            {formatTotalTokens(usage.used)} / {formatTokenCount(usage.limit)} Tokens
          </span>
        </div>
        {usage.source === 'legacy-estimated' && (
          <div className="context-usage-model">
            Legacy estimate: older tool calls, results, and reasoning were not recoverable.
          </div>
        )}

        <div className="context-usage-bar" aria-hidden="true">
          {usage.categories.map((category) => (
            <div
              key={category.label}
              className="context-usage-bar-segment"
              style={{
                flex: segmentTotal > 0 ? category.tokens / segmentTotal : 0,
                backgroundColor: category.color
              }}
            />
          ))}
        </div>

        <ul className="context-usage-breakdown">
          {usage.categories.map((category) => (
            <li key={category.label} className="context-usage-item">
              <span className="context-usage-item-label">
                <span className="context-usage-swatch" style={{ backgroundColor: category.color }} />
                {category.label}
              </span>
              <span className="context-usage-item-value">{formatTokenCount(category.tokens)}</span>
            </li>
          ))}
        </ul>
      </div>
    </FloatingPortal>
  )
}

interface ContextUsageRingProps {
  percent: number
  onClick: () => void
  active: boolean
}

export const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(
  function ContextUsageRing({ percent, onClick, active }, ref) {
    const radius = 9
    const circumference = 2 * Math.PI * radius
    const strokeOffset = circumference - (percent / 100) * circumference

    return (
      <button
        ref={ref}
        type="button"
        className={`composer-icon-btn context-usage-btn${active ? ' active' : ''}`}
        onClick={onClick}
        title="Context usage"
        aria-label={`Context usage ${percent}% full`}
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
        </svg>
      </button>
    )
  }
)
