import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Clock } from '../lib/icons'
import { useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { EXPIRY_PRESETS, MAX_EXPIRY_MS, MIN_EXPIRY_MS } from '../../shared/threadExpiry'
import '../styles/private-threads.css'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** The milliseconds a custom expiry of `amount` `unit` means, or undefined when it is out of range. */
export function customExpiryMs(amount: string, unit: 'hours' | 'days'): number | undefined {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const ms = Math.round(value * (unit === 'hours' ? HOUR_MS : DAY_MS))
  return ms >= MIN_EXPIRY_MS && ms <= MAX_EXPIRY_MS ? ms : undefined
}

/**
 * Picks when a thread deletes itself (`Thread.expiresAt`): never, after 1 hour, 24 hours, 7 days, 30 days,
 * or a custom time, and whether a run still going then is stopped. `selectedMs` marks the preset in use for
 * a new chat; an existing thread's menu marks none, since every pick counts from now.
 */
export function ExpiryMenu({ trigger, triggerTitle, triggerClassName, selectedMs, hasExpiry, stopsRun, disabled, onPick }: {
  trigger: ReactNode
  triggerTitle: string
  triggerClassName: string
  selectedMs?: number
  /** An expiry is set: Never then means removing it. */
  hasExpiry: boolean
  stopsRun: boolean
  disabled?: boolean
  /** `ms` from now, or null for never. */
  onPick: (ms: number | null, stopsRun: boolean) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [amount, setAmount] = useState('2')
  const [unit, setUnit] = useState<'hours' | 'days'>('hours')
  const [stop, setStop] = useState(stopsRun)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const open = menuOpen && !disabled
  const menuStyle = useFloatingPosition({ open, anchorRef: triggerRef, contentRef: menuRef, placement: 'below-start', deps: [custom] })
  const closeMenu = () => {
    setMenuOpen(false)
    setCustom(false)
    triggerRef.current?.focus()
  }
  const menuKeyDown = useMenuKeyboard(menuRef, closeMenu)

  useEffect(() => {
    if (!open) return
    if (menuStyle.visibility === 'visible' && !custom) firstItemRef.current?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setMenuOpen(false)
        setCustom(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, menuStyle.visibility, custom])

  const pick = (ms: number | null) => {
    onPick(ms, ms !== null && stop)
    closeMenu()
  }
  const customMs = customExpiryMs(amount, unit)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName}${open ? ' open' : ''}`}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu()
          else {
            setStop(stopsRun)
            setMenuOpen(true)
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={menuRef}
            id={menuId}
            className="composer-workspace-menu expiry-menu scrollbar-ultra-thin"
            role="menu"
            aria-label="Delete this thread"
            style={menuStyle}
            onKeyDown={custom ? undefined : menuKeyDown}
          >
            <div className="composer-workspace-menu-label" aria-hidden="true">Delete this thread for good</div>
            <button
              ref={firstItemRef}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={!hasExpiry && selectedMs === undefined}
              className="composer-workspace-menu-item"
              onClick={() => pick(null)}
            >
              <span>{hasExpiry ? 'Keep it' : 'Never'}</span>
              {!hasExpiry && selectedMs === undefined && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
            </button>
            {EXPIRY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={selectedMs === preset.ms}
                className="composer-workspace-menu-item"
                onClick={() => pick(preset.ms)}
              >
                <span>After {preset.label}</span>
                {selectedMs === preset.ms && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
              </button>
            ))}
            {custom ? (
              <form
                className="expiry-menu-custom"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (customMs !== undefined) pick(customMs)
                }}
              >
                <span>After</span>
                <input
                  autoFocus
                  type="number"
                  min="1"
                  step="1"
                  aria-label="Amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}
                />
                <select aria-label="Unit" value={unit} onChange={(event) => setUnit(event.target.value as 'hours' | 'days')}>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
                <button type="submit" disabled={customMs === undefined}>Set</button>
              </form>
            ) : (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-checked={selectedMs !== undefined && !EXPIRY_PRESETS.some((preset) => preset.ms === selectedMs)}
                className="composer-workspace-menu-item"
                onClick={() => setCustom(true)}
              >
                <span>Custom…</span>
              </button>
            )}
            <div className="composer-workspace-menu-separator" role="separator" />
            <label className="expiry-menu-stop">
              <input type="checkbox" checked={stop} onChange={(event) => setStop(event.target.checked)} />
              <span>Stop a running turn when it expires</span>
            </label>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** The clock icon a trigger shows. */
export function ExpiryIcon() {
  return <Clock size={16} strokeWidth={1.8} aria-hidden="true" />
}
