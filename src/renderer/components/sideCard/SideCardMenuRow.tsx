import type { ReactNode } from 'react'
import { Check } from '../../lib/icons'
import { menuRowLabel } from './deviceMenu'

interface SideCardMenuRowProps {
  icon: ReactNode
  label: string
  active: boolean
  disabled?: boolean
  /** Why the row is disabled; heard and shown as a tooltip. */
  reason?: string
  workspaceChoice?: string
  onSelect: () => void
}

/**
 * A radio row of a side card menu. A disabled row stays focusable so keyboard users
 * can reach it and hear why; activating it does nothing.
 */
export function SideCardMenuRow({ icon, label, active, disabled = false, reason, workspaceChoice, onSelect }: SideCardMenuRowProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      tabIndex={-1}
      aria-checked={active}
      aria-disabled={disabled || undefined}
      aria-label={disabled ? menuRowLabel(label, reason) : undefined}
      title={disabled ? reason : undefined}
      className="side-card-device-item"
      data-workspace-choice={workspaceChoice}
      onClick={disabled ? undefined : onSelect}
    >
      {icon}
      <span className="side-card-device-item-label">{label}</span>
      {active && <Check size={13} className="side-card-device-check" aria-hidden="true" />}
    </button>
  )
}
