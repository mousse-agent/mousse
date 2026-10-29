import { useState } from 'react'
import type { HarnessCaps } from '../../shared/harness/types'
import {
  describePermissionMode,
  effectivePermissionMode,
  isStricter,
  PERMISSION_MODES,
  supportedPermissionModes,
  type PermissionLimits,
  type PermissionMode
} from '../../shared/permissionMode'
import { permissionModeIcon } from '../lib/permissionModeIcon'

/** The thread's permission mode and how to change it, as the composer's run menu gets it. */
export interface PermissionControl {
  /** The mode the thread is set to. */
  mode: PermissionMode
  /** The selected agent's name ("Claude Code"). */
  agent: string
  caps?: Pick<HarnessCaps, 'toolControl' | 'autoPermissionMode'>
  limits?: PermissionLimits
  /** A subagent's lineage ceiling; absent for a thread nobody delegated. */
  ceiling?: PermissionMode
  /** Why nothing above `ceiling` is offered, when it is not a subagent's lineage (a thread of another computer: the device limit). */
  ceilingReason?: string
  onSelect: (mode: PermissionMode) => void
}

/** What each mode does on this agent, in one short line. */
function modeDescription(mode: PermissionMode, agent: string, sandboxOff: boolean): string {
  switch (mode) {
    case 'ask':
      return 'Asks before every command and file edit.'
    case 'accept_edits':
      return 'Edits go ahead; commands ask first.'
    case 'auto':
      return `Edits go ahead; ${agent} runs the commands it judges safe.`
    case 'full':
      return sandboxOff ? 'Runs everything without asking, sandbox off.' : 'Runs everything without asking.'
  }
}

export interface PermissionChoice {
  /** The modes the row offers, strictest first. */
  offered: PermissionMode[]
  /** The mode shown as chosen (a thread set to Auto on an agent without it shows Auto-accept edits). */
  selected: PermissionMode
  /** The mode a turn runs in, when the agent cannot enforce the chosen one. */
  shown: PermissionMode
  /** Why the turn runs in `shown` instead of `selected`. */
  reason?: string
  /** The agent approves tools itself: only Full access is offered. */
  approvesItself: boolean
  /** Why a mode cannot be picked here, by mode. */
  blocked: Partial<Record<PermissionMode, string>>
}

/**
 * The permission row's state. It shows the mode in effect when the agent cannot enforce the chosen
 * one (with the reason), offers only Full access on an agent that approves tools itself, never offers
 * Auto on an agent without an auto mode, and, for a subagent, never a mode above its lineage's ceiling.
 */
export function permissionChoice(control: Omit<PermissionControl, 'onSelect'>): PermissionChoice {
  const { mode, agent, caps, limits, ceiling, ceilingReason } = control
  // Without a snapshot yet the instance is assumed able: the daemon still refuses what it cannot enforce.
  const supported = supportedPermissionModes(caps ?? { toolControl: 'exact' }, limits)
  const autoOffered = supported.includes('auto')
  const selected = mode === 'auto' && !autoOffered ? 'accept_edits' : mode
  const effective = effectivePermissionMode(selected, supported, { agent, ...(limits ? { limits } : {}) })
  const approvesItself = supported.length === 1 && supported[0] === 'full'
  const offered = approvesItself ? PERMISSION_MODES.filter((entry) => entry === 'full') : PERMISSION_MODES.filter((entry) => entry !== 'auto' || autoOffered)
  const blocked: Partial<Record<PermissionMode, string>> = {}
  for (const entry of offered) {
    if (ceiling !== undefined && isStricter(ceiling, entry)) blocked[entry] = ceilingReason ?? 'A thread this subagent belongs to is set lower.'
  }
  return {
    offered,
    selected,
    shown: effective.refused ? selected : effective.mode,
    ...(effective.reason ? { reason: effective.reason } : {}),
    approvesItself,
    blocked
  }
}

/**
 * The run menu's permission section: one icon button per mode in a row, the chosen one highlighted,
 * and one fixed line under the row naming and describing the chosen mode, or the hovered or focused
 * one. A mode that cannot be picked stays in the row, dimmed, and its line says why.
 */
export function PermissionModeSection({ control, choice, onPicked }: {
  control: PermissionControl
  choice: PermissionChoice
  /** Called after a pick, so the menu can close. */
  onPicked: () => void
}) {
  const [preview, setPreview] = useState<PermissionMode | null>(null)
  const { agent, limits } = control
  const { offered, selected, shown, reason, approvesItself, blocked } = choice
  const focus = preview ?? selected
  const line = (() => {
    if (blocked[focus]) return blocked[focus]
    if (focus === selected && reason) return `Running as ${describePermissionMode(shown)}: ${reason}.`
    if (approvesItself) return `${agent} approves tools itself.`
    return modeDescription(focus, agent, limits?.sandboxOffInFull === true)
  })()
  return <div className="composer-mode-menu-section composer-run-menu-permissions" role="group" aria-label="Permissions">
    <div className="composer-mode-menu-heading">Permissions</div>
    <div className="composer-run-menu-permission-row" onMouseLeave={() => setPreview(null)}>
      {offered.map((entry) => {
        const Icon = permissionModeIcon(entry)
        const name = describePermissionMode(entry)
        const why = blocked[entry]
        const on = selected === entry
        return <button
          key={entry}
          type="button"
          role="menuitemradio"
          aria-checked={on}
          aria-disabled={why ? true : undefined}
          aria-label={why ? `${name} (${why})` : name}
          title={why ? `${name}: ${why}` : name}
          className={`composer-run-menu-permission${on ? ' selected' : ''}${why ? ' is-disabled' : ''}`}
          onMouseEnter={() => setPreview(entry)}
          onFocus={() => setPreview(entry)}
          onBlur={() => setPreview(null)}
          onClick={() => {
            if (why) return
            onPicked()
            if (entry !== selected) control.onSelect(entry)
          }}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      })}
    </div>
    <div className="composer-run-menu-permission-line" aria-live="polite">
      <span className="composer-run-menu-permission-name">{describePermissionMode(focus)}</span>
      <span className="composer-run-menu-permission-desc">{line}</span>
    </div>
  </div>
}
