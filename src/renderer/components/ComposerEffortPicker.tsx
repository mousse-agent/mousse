import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { LlmModelOption } from '../../shared/settings'
import { applyEffortToModelId, findModelFamily, formatEffortLabel, getModelFastToggle, parseModelVariant, parseThinkingSuffixFromModelId, reasoningLevelLabel, resolveModelVariant, resolveReasoning } from '../../shared/modelVariants'
import { describePermissionMode } from '../../shared/permissionMode'
import { Brain, Check, ChevronDown } from '../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { permissionModeIcon } from '../lib/permissionModeIcon'
import { PermissionModeSection, permissionChoice, type PermissionControl } from './ComposerPermissionPicker'
import '../styles/composer-run-controls.css'

/** The check column shared by the composer's single-line menus (same as Select). */
export function MenuCheck({ on }: { on: boolean }) {
  return <span className="composer-mode-menu-check" aria-hidden="true">{on && <Check size={14} strokeWidth={2} />}</span>
}

type Selection = { providerId: string; modelId: string; models: LlmModelOption[] }

/** The selected model's reasoning levels, speed toggle and how to pick each. */
function useRunOptions({ providerId, modelId, models }: Selection, onSelect: (providerId: string, modelId: string) => void) {
  const reasoning = resolveReasoning(providerId, modelId, models)
  const fast = getModelFastToggle(providerId, modelId, models)
  const effort = reasoning.current
  const pickEffort = (value: string) => {
    const family = findModelFamily(providerId, models, modelId)
    const baseId = parseThinkingSuffixFromModelId(modelId).baseId
    const current = models.find((model) => model.id === modelId || model.id === baseId)
    const variant = current ? parseModelVariant(current) : undefined
    const resolved = family && resolveModelVariant(family, { context: variant?.context, speed: variant?.speed, effort: value })
    onSelect(providerId, value === 'off' ? `${parseThinkingSuffixFromModelId(resolved?.id ?? modelId).baseId}:off` : resolved?.id ?? applyEffortToModelId(modelId, value))
  }
  const pickSpeed = (enabled: boolean) => {
    if (!fast || fast.active === enabled) return
    onSelect(providerId, effort === 'off' ? `${parseThinkingSuffixFromModelId(fast.targetModelId).baseId}:off` : fast.targetModelId)
  }
  return { reasoning, fast, effort, pickEffort, pickSpeed }
}

/** Closes the menu on a press outside it or Escape (focus back on the trigger). */
function useDismiss(open: boolean, setOpen: (open: boolean) => void, anchorRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node) && !contentRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); anchorRef.current?.focus() } }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open, setOpen, anchorRef, contentRef])
}

const ROW = '.composer-run-menu-permission-row'

/**
 * Arrow keys across the run menu: Up and Down move between rows (the permission row is one stop,
 * entered on its chosen mode), Left and Right between the modes in the row, Home and End to the ends.
 * Enter and Space pick the focused item (they are buttons).
 */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  if (!items.length) return
  const active = document.activeElement as HTMLElement | null
  const index = active ? items.indexOf(active) : -1
  const row = active?.closest(ROW)
  const focus = (item: HTMLElement | undefined) => { if (item) { event.preventDefault(); item.focus() } }
  // A stop in the permission row lands on its chosen mode.
  const stop = (item: HTMLElement | undefined) => {
    const target = item?.closest(ROW)
    return target ? target.querySelector<HTMLElement>('[aria-checked="true"]') ?? item : item
  }
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!row) return
      const inRow = [...row.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      const at = inRow.indexOf(active!)
      focus(inRow[(at + (event.key === 'ArrowRight' ? 1 : -1) + inRow.length) % inRow.length])
      return
    }
    case 'ArrowDown':
    case 'ArrowUp': {
      const step = event.key === 'ArrowDown' ? 1 : -1
      let next = index
      do next = (next + step + items.length) % items.length
      while (row && items[next]!.closest(ROW) === row && next !== index)
      focus(stop(items[next]))
      return
    }
    case 'Home': focus(stop(items[0])); return
    case 'End': focus(stop(items[items.length - 1])); return
  }
}

/**
 * The menu of how the next turn runs: reasoning level, speed when the model has a fast mode, and the
 * permission mode, each section only when the agent and model offer it. A saved level the model does
 * not offer runs at the model's default, and the menu says so.
 */
function RunMenu({ selection, onSelect, permission, readOnly, contentRef, style, onClose }: {
  selection: Selection
  onSelect: (providerId: string, modelId: string) => void
  permission?: PermissionControl
  readOnly: boolean
  contentRef: RefObject<HTMLDivElement | null>
  style: React.CSSProperties
  onClose: () => void
}) {
  const { reasoning, fast, effort, pickEffort, pickSpeed } = useRunOptions(selection, onSelect)
  const choice = permission ? permissionChoice(permission) : undefined
  const modelName = parseThinkingSuffixFromModelId(selection.modelId).baseId
  const model = selection.models.find((entry) => entry.id === selection.modelId || entry.id === modelName)
  // The chosen item takes focus, so the arrow keys start from it.
  useLayoutEffect(() => {
    const menu = contentRef.current
    const first = menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]')
    first?.focus({ preventScroll: true })
  }, [contentRef])
  const sections: ReactNode[] = []
  if (reasoning.levels.length > 0) sections.push(<div key="reasoning" className="composer-mode-menu-section" role="group" aria-label="Reasoning">
    <div className="composer-mode-menu-heading">Reasoning</div>
    {reasoning.levels.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={effort === value} disabled={readOnly} title={reasoning.descriptions[value]} className={`composer-mode-menu-item${effort === value ? ' selected' : ''}`} onClick={() => { onClose(); if (value !== effort || reasoning.unsupported) pickEffort(value) }}>
      <MenuCheck on={effort === value} /><span>{reasoningLevelLabel(value)}</span>
      {value === reasoning.defaultLevel && <span className="composer-mode-menu-item-meta">Default</span>}
    </button>)}
    {reasoning.unsupported && <div className="composer-run-menu-note" role="note">
      {reasoningLevelLabel(reasoning.unsupported)} isn't offered for {model ? parseModelVariant(model).familyLabel : 'this model'}; using {reasoning.defaultLevel ? 'its default' : reasoningLevelLabel(effort ?? '')}.
    </div>}
  </div>)
  if (fast) sections.push(<div key="speed" className="composer-mode-menu-section" role="group" aria-label="Speed">
    <div className="composer-mode-menu-heading">Speed</div>
    {[false, true].map((enabled) => <button key={String(enabled)} type="button" role="menuitemradio" aria-checked={fast.active === enabled} disabled={readOnly} className={`composer-mode-menu-item${fast.active === enabled ? ' selected' : ''}`} onClick={() => { onClose(); pickSpeed(enabled) }}><MenuCheck on={fast.active === enabled} /><span>{enabled ? 'Fast' : 'Standard'}</span></button>)}
  </div>)
  if (permission && choice) sections.push(<PermissionModeSection key="permissions" control={permission} choice={choice} onPicked={onClose} />)
  return <FloatingPortal><div ref={contentRef} style={style} className={`composer-mode-menu composer-mode-menu-floating composer-run-menu${permission ? ' has-permissions' : ''}`} role="menu" aria-label="Run options" onKeyDown={moveFocus}>
    {sections.map((section, index) => index === 0 ? section : <div key={`group-${index}`} className="composer-mode-menu-group">{section}</div>)}
  </div></FloatingPortal>
}

/** The reasoning level as the composer and Settings show it ("High", "High · Fast"). */
function levelText(effort: string | undefined, fast: { active: boolean } | undefined): string {
  return `${effort ? reasoningLevelLabel(effort) : ''}${fast?.active ? `${effort ? ' · ' : ''}Fast` : ''}`
}

/** Settings' reasoning picker: a pill beside the model picker, opening the same menu without permissions. */
export function ComposerEffortPicker({ providerId, modelId, models, readOnly, onSelect }: Selection & {
  readOnly: boolean
  onSelect: (providerId: string, modelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { reasoning, fast, effort } = useRunOptions({ providerId, modelId, models }, onSelect)
  const style = useFloatingPosition({ open, anchorRef, contentRef, placement: 'above-start', deps: [modelId] })
  useDismiss(open, setOpen, anchorRef, contentRef)
  const close = () => { setOpen(false); anchorRef.current?.focus() }
  if (!reasoning.levels.length && !fast) return null
  return <div className="composer-effort-picker">
    <button ref={anchorRef} type="button" className={`composer-pill-btn${open ? ' open' : ''}`} disabled={readOnly} aria-label="Reasoning effort and speed" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Brain size={14} aria-hidden="true" /><span>{effort ? formatEffortLabel(effort) : 'Effort'}{fast?.active ? ' · Fast' : ''}</span><ChevronDown size={12} />
    </button>
    {open && !readOnly && <RunMenu selection={{ providerId, modelId, models }} onSelect={onSelect} readOnly={readOnly} contentRef={contentRef} style={style} onClose={close} />}
  </div>
}

/**
 * The composer's run control, right after the model name: the reasoning level as plain text ("· High")
 * and the permission mode's icon, opening the run menu. Without a reasoning level or speed it is the
 * icon alone; without a permission mode either, nothing.
 */
export function ComposerRunPicker({ providerId, modelId, models, modelReadOnly, permission, onSelect }: Selection & {
  /** The model is assigned (a subagent's): its reasoning and speed show but cannot change. */
  modelReadOnly: boolean
  permission?: PermissionControl
  onSelect: (providerId: string, modelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { reasoning, fast, effort } = useRunOptions({ providerId, modelId, models }, onSelect)
  const style = useFloatingPosition({ open, anchorRef, contentRef, placement: 'above-start', deps: [modelId, permission?.mode] })
  useDismiss(open, setOpen, anchorRef, contentRef)
  const close = () => { setOpen(false); anchorRef.current?.focus() }
  const hasReasoning = reasoning.levels.length > 0 || Boolean(fast)
  if (!hasReasoning && !permission) return null
  const text = hasReasoning ? levelText(effort, fast) : ''
  const choice = permission ? permissionChoice(permission) : undefined
  const ModeIcon = choice ? permissionModeIcon(choice.shown) : undefined
  const modeTitle = choice ? `${describePermissionMode(choice.shown)}${choice.reason ? `. ${choice.reason}` : ''}` : ''
  const label = [text && `Reasoning: ${text}`, choice && `Permission mode: ${modeTitle}`].filter(Boolean).join('. ')
  const disabled = modelReadOnly && !permission
  return <div className="composer-run-picker">
    {text && <span className="composer-run-sep" aria-hidden="true">·</span>}
    <button
      ref={anchorRef}
      type="button"
      className={`composer-run-btn${open ? ' open' : ''}${choice?.reason ? ' is-limited' : ''}`}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {text && <span className="composer-run-btn-level">{text}</span>}
      {ModeIcon && <ModeIcon size={14} aria-hidden="true" className="composer-run-btn-mode" />}
    </button>
    {open && !disabled && <RunMenu selection={{ providerId, modelId, models }} onSelect={onSelect} permission={permission} readOnly={modelReadOnly} contentRef={contentRef} style={style} onClose={close} />}
  </div>
}
