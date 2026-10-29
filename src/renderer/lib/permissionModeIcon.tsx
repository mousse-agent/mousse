import type { ReactNode } from 'react'
import { Pencil, ShieldCheck, Zap } from './icons'
import type { PermissionMode } from '../../shared/permissionMode'

type ModeIcon = typeof ShieldCheck

/** One icon per permission mode, so a mode reads the same wherever it is named. A new mode adds one entry. */
const PERMISSION_MODE_ICONS: Record<PermissionMode, ModeIcon> = {
  ask: ShieldCheck,
  accept_edits: Pencil,
  full: Zap
}

export function permissionModeIcon(mode: PermissionMode): ModeIcon {
  return PERMISSION_MODE_ICONS[mode]
}

/** The icon for `mode` followed by `children` (its label), for a menu row or a select value. */
export function PermissionModeLabel({ mode, size = 14, children }: { mode: PermissionMode; size?: number; children: ReactNode }) {
  const Icon = permissionModeIcon(mode)
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon size={size} aria-hidden="true" />{children}</span>
}
