import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { LlmModelOption } from '../../shared/settings'
import { applyEffortToModelId, findModelFamily, formatEffortLabel, getModelFastToggle, parseModelVariant, parseThinkingSuffixFromModelId, reasoningLevelLabel, resolveModelVariant, resolveReasoning } from '../../shared/modelVariants'
import { Brain, ChevronDown } from '../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { PermissionModeSection, permissionChoice, type PermissionControl } from './ComposerPermissionPicker'
import '../styles/composer-run-controls.css'

type Selection = { providerId: string; modelId: string; models: LlmModelOption[] }

/** The id that runs `modelId` at `level`, keeping its context and speed. */
export function withReasoningLevel({ providerId, modelId, models }: Selection, level: string): string {
  const family = findModelFamily(providerId, models, modelId)
  const baseId = parseThinkingSuffixFromModelId(modelId).baseId
  const current = models.find((model) => model.id === modelId || model.id === baseId)
  const variant = current ? parseModelVariant(current) : undefined
  const resolved = family && resolveModelVariant(family, { context: variant?.context, speed: variant?.speed, effort: level })
  return level === 'off' ? `${parseThinkingSuffixFromModelId(resolved?.id ?? modelId).baseId}:off` : resolved?.id ?? applyEffortToModelId(modelId, level)
}

/**
 * The id picking another model selects, carrying the chosen level: kept when that model offers it;
 * otherwise left out, so the model runs at its default (`dropped` names the level).
 */
export function carryReasoningLevel(target: Selection, level: string | undefined): { modelId: string; dropped?: string } {
  const { levels } = resolveReasoning(target.providerId, target.modelId, target.models)
  if (!level || levels.length === 0) return { modelId: target.modelId }
  if (levels.includes(level)) return { modelId: withReasoningLevel(target, level) }
  const baseId = parseThinkingSuffixFromModelId(target.modelId).baseId
  return { modelId: target.models.some((model) => model.id === baseId) ? baseId : target.modelId, dropped: level }
}

/** The level a selection runs at, when its model has levels. */
export function shownReasoningLevel(selection: Selection): string | undefined {
  const reasoning = resolveReasoning(selection.providerId, selection.modelId, selection.models)
  return reasoning.levels.length > 0 ? reasoning.current : undefined
}

/** The selected model's reasoning levels, speed toggle and how to pick each. */
function useRunOptions({ providerId, modelId, models }: Selection, onSelect: (providerId: string, modelId: string) => void) {
  const reasoning = resolveReasoning(providerId, modelId, models)
  const fast = getModelFastToggle(providerId, modelId, models)
  const effort = reasoning.current
  const pickEffort = (value: string) => onSelect(providerId, withReasoningLevel({ providerId, modelId, models }, value))
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
 * Arrow keys across the run settings: Up and Down move between rows (the permission row is one stop,
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

/** Puts focus on the chosen item of the run settings in `container` (the first item without one). */
function focusRunSettings(container: HTMLElement | null | undefined): boolean {
  const item = container?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? container?.querySelector<HTMLElement>('[role="menuitemradio"]')
  item?.focus({ preventScroll: true })
  return Boolean(item)
}

/**
 * How a turn runs: reasoning level, speed when the model has a fast mode, and the permission mode,
 * each section only when the agent and model offer it. A level the model does not offer (saved, or
 * carried over from the model picked before) runs at the model's default, and a line says so.
 */
function runSections({ selection, onSelect, permission, readOnly, onClose, dropped, current = true }: {
  selection: Selection
  onSelect: (providerId: string, modelId: string) => void
  permission?: PermissionControl
  readOnly: boolean
  onClose: () => void
  /** A level carried over from the model picked before that this one does not offer. */
  dropped?: string
  /** The selection is the thread's: picking the level it already runs at changes nothing. */
  current?: boolean
}, run: ReturnType<typeof useRunOptions>): ReactNode[] {
  const { reasoning, fast, effort, pickEffort, pickSpeed } = run
  const choice = permission ? permissionChoice(permission) : undefined
  const modelName = parseThinkingSuffixFromModelId(selection.modelId).baseId
  const model = selection.models.find((entry) => entry.id === selection.modelId || entry.id === modelName)
  const unsupported = dropped ?? reasoning.unsupported
  const sections: ReactNode[] = []
  if (reasoning.levels.length > 0) sections.push(<div key="reasoning" className="composer-mode-menu-section" role="group" aria-label="Reasoning">
    <div className="composer-mode-menu-heading">Reasoning</div>
    {reasoning.levels.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={effort === value} disabled={readOnly} title={reasoning.descriptions[value]} className={`composer-mode-menu-item${effort === value ? ' selected' : ''}`} onClick={() => { onClose(); if (!current || value !== effort || reasoning.unsupported) pickEffort(value) }}>
      <span>{reasoningLevelLabel(value)}</span>
      {value === reasoning.defaultLevel && <span className="composer-mode-menu-item-meta">Default</span>}
    </button>)}
    {unsupported && <div className="composer-run-menu-note" role="note" aria-live="polite">
      {reasoningLevelLabel(unsupported)} isn't offered for {model ? parseModelVariant(model).familyLabel : 'this model'}; using {reasoning.defaultLevel ? 'its default' : reasoningLevelLabel(effort ?? '')}.
    </div>}
  </div>)
  if (fast) sections.push(<div key="speed" className="composer-mode-menu-section" role="group" aria-label="Speed">
    <div className="composer-mode-menu-heading">Speed</div>
    {[false, true].map((enabled) => <button key={String(enabled)} type="button" role="menuitemradio" aria-checked={fast.active === enabled} disabled={readOnly} className={`composer-mode-menu-item${fast.active === enabled ? ' selected' : ''}`} onClick={() => { onClose(); if (current || fast.active !== enabled) pickSpeed(enabled); else onSelect(selection.providerId, selection.modelId) }}><span>{enabled ? 'Fast' : 'Standard'}</span></button>)}
  </div>)
  if (permission && choice) sections.push(<PermissionModeSection key="permissions" control={permission} choice={choice} onPicked={onClose} />)
  return sections.map((section, index) => index === 0 ? section : <div key={`group-${index}`} className="composer-mode-menu-group">{section}</div>)
}

/**
 * The run settings as their own menu: Settings' reasoning picker, and the composer when the model is
 * assigned (a subagent's), where only the permission mode can change.
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
  const run = useRunOptions(selection, onSelect)
  // The chosen item takes focus, so the arrow keys start from it.
  useLayoutEffect(() => { focusRunSettings(contentRef.current) }, [contentRef])
  const sections = runSections({ selection, onSelect, permission, readOnly, onClose }, run)
  return <FloatingPortal><div ref={contentRef} style={style} className={`composer-mode-menu composer-mode-menu-floating composer-run-menu${permission ? ' has-permissions' : ''}`} role="menu" aria-label="Run options" onKeyDown={moveFocus}>
    {sections}
  </div></FloatingPortal>
}

/** Settings' reasoning picker: a pill beside the model picker, opening the run settings without permissions. */
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

/** The level as the composer shows it after the model name ("High", "High Fast"). */
export function runLevelText(selection: Selection): string {
  const reasoning = resolveReasoning(selection.providerId, selection.modelId, selection.models)
  const fast = getModelFastToggle(selection.providerId, selection.modelId, selection.models)
  const effort = reasoning.levels.length > 0 || fast ? reasoning.current : undefined
  return [effort && reasoningLevelLabel(effort), fast?.active && 'Fast'].filter(Boolean).join(' ')
}

/** The composer's run settings menu for an assigned model: its level shows, only the permission mode changes. */
export function ComposerRunMenu({ selection, permission, anchorRef, contentRef, onClose }: {
  selection: Selection
  permission: PermissionControl
  anchorRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const style = useFloatingPosition({ open: true, anchorRef, contentRef, placement: 'above-start', deps: [selection.modelId, permission.mode] })
  return <RunMenu selection={selection} onSelect={() => {}} permission={permission} readOnly contentRef={contentRef} style={style} onClose={onClose} />
}

/** A model the picker shows run settings for, as `carryReasoningLevel` resolved it. */
export interface RunSettingsTarget extends Selection {
  instanceId?: string
  /** The model is the thread's: its settings show as they are. */
  selected: boolean
  dropped?: string
}

/** How many rows a target's run settings take, to size the picker's column to the largest. */
export function runSettingsRows(target: RunSettingsTarget, permission: boolean): number {
  const reasoning = resolveReasoning(target.providerId, target.modelId, target.models)
  const fast = getModelFastToggle(target.providerId, target.modelId, target.models)
  return (reasoning.levels.length > 0 ? reasoning.levels.length + 1 + (target.dropped || reasoning.unsupported ? 1 : 0) : 0) + (fast ? 3 : 0) + (permission ? 3 : 0)
}

/**
 * The model picker's run settings column for the highlighted model: picking anything in it picks that
 * model too, with the setting. `sizer` draws it hidden, only to hold the column's size.
 */
export function RunSettingsColumn({ target, label, permission, onSelect, onClose, sizer = false }: {
  target: RunSettingsTarget
  /** The model's name, for screen readers. */
  label: string
  permission?: PermissionControl
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
  onClose: () => void
  sizer?: boolean
}) {
  const pick = (providerId: string, modelId: string) => onSelect(providerId, modelId, target.instanceId)
  const run = useRunOptions(target, pick)
  // A permission mode picked for another model picks that model as well.
  const control = permission && !target.selected
    ? { ...permission, onSelect: (mode: Parameters<PermissionControl['onSelect']>[0]) => { pick(target.providerId, target.modelId); permission.onSelect(mode) } }
    : permission
  const sections = runSections({ selection: target, onSelect: pick, permission: control, readOnly: false, onClose, dropped: target.dropped, current: target.selected }, run)
  if (!sections.length) return null
  if (sizer) return <div className="model-picker-run-sizer" aria-hidden="true" inert>{sections}</div>
  return <div className="model-picker-run-settings" role="menu" aria-label={`${label} settings`} onKeyDown={moveFocus}>{sections}</div>
}
