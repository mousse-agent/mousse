import { useEffect, useRef, useState } from 'react'
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
import { ChevronDown } from '../lib/icons'
import { permissionModeIcon } from '../lib/permissionModeIcon'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { MenuCheck } from './ComposerEffortPicker'

/** What each mode does on this agent, in the words the menu shows. */
function modeDescription(mode: PermissionMode, agent: string, sandboxOff: boolean): string {
  switch (mode) {
    case 'ask':
      return `${agent} asks before every command and file edit.`
    case 'accept_edits':
      return `File edits go ahead; ${agent} asks before every command.`
    case 'auto':
      return `File edits go ahead; ${agent}'s auto mode runs commands it judges safe and asks about the rest.`
    case 'full':
      return sandboxOff
        ? `${agent} runs commands and edits without asking, and its sandbox is off.`
        : `${agent} runs commands and edits without asking.`
  }
}

/**
 * The thread's permission mode: what the agent may do without asking, from the next turn. It shows
 * the mode in effect when the agent cannot enforce the chosen one (with the reason), offers only
 * Full access on an agent that approves tools itself, and, for a subagent, never a mode above its
 * lineage's ceiling.
 */
export function ComposerPermissionPicker({ mode, agent, caps, limits, ceiling, ceilingReason, readOnly, onSelect }: {
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
  readOnly?: boolean
  onSelect: (mode: PermissionMode) => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open, anchorRef, contentRef, placement: 'above-start', deps: [mode] })
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node) && !contentRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); anchorRef.current?.focus() } }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])

  // Without a snapshot yet the instance is assumed able: the daemon still refuses what it cannot enforce.
  const supported = supportedPermissionModes(caps ?? { toolControl: 'exact' }, limits)
  const effective = effectivePermissionMode(mode, supported, { agent, ...(limits ? { limits } : {}) })
  const shown = effective.refused ? mode : effective.mode
  const reason = effective.reason
  const approvesItself = supported.length === 1 && supported[0] === 'full'
  // On an agent without an auto mode the Auto row says, for this thread, that it runs as Auto-accept edits.
  const autoFallback = supported.includes('auto') ? undefined : `Works as ${describePermissionMode('accept_edits')}: ${limits?.unavailable?.auto ?? `${agent} has no auto mode`}.`
  // Only Full access is offered on an agent that approves tools itself.
  const offered = approvesItself ? PERMISSION_MODES.filter((entry) => entry === 'full') : PERMISSION_MODES
  const label = describePermissionMode(shown)
  const ShownIcon = permissionModeIcon(shown)
  const title = reason ? `${label}. ${reason}` : label
  return <div className="composer-permission-picker">
    <button ref={anchorRef} type="button" className={`composer-pill-btn${open ? ' open' : ''}${reason ? ' is-limited' : ''}`} disabled={readOnly} title={title} aria-label={`Permission mode: ${title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ShownIcon size={14} aria-hidden="true" /><span>{label}</span><ChevronDown size={12} />
    </button>
    {open && !readOnly && <FloatingPortal><div ref={contentRef} style={style} className="composer-mode-menu composer-mode-menu-floating" role="menu" aria-label="Permission mode">
      <div className="composer-mode-menu-section" role="group" aria-label="Permission mode">
        {approvesItself && <div className="composer-mode-menu-heading">{agent} approves tools itself</div>}
        {offered.map((entry) => {
          const aboveCeiling = ceiling !== undefined && isStricter(ceiling, entry)
          const EntryIcon = permissionModeIcon(entry)
          return <button key={entry} type="button" role="menuitemradio" aria-checked={mode === entry} disabled={aboveCeiling} className={`composer-mode-menu-item${mode === entry ? ' selected' : ''}`} onClick={() => { setOpen(false); anchorRef.current?.focus(); if (entry !== mode) onSelect(entry) }}>
            <MenuCheck on={mode === entry} />
            <EntryIcon size={14} aria-hidden="true" />
            <span className="composer-mode-menu-item-text">
              <span>{describePermissionMode(entry)}</span>
              <span className="composer-mode-menu-item-desc">{aboveCeiling ? ceilingReason ?? 'A thread this subagent belongs to is set lower.' : entry === 'auto' && autoFallback ? autoFallback : modeDescription(entry, agent, limits?.sandboxOffInFull === true)}</span>
            </span>
          </button>
        })}
        {reason && <div className="composer-mode-menu-heading">Now running as {label}: {reason}</div>}
      </div>
    </div></FloatingPortal>}
  </div>
}
