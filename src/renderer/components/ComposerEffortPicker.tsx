import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { LlmModelOption } from '../../shared/settings'
import { applyEffortToModelId, findModelFamily, formatEffortLabel, getModelSpeedOptions, parseModelVariant, parseThinkingSuffixFromModelId, reasoningLevelLabel, resolveModelVariant, resolveReasoning, speedLabel } from '../../shared/modelVariants'
import { Brain, Check, ChevronDown, Zap } from '../lib/icons'
import { FloatingPortal, useClosestAnchor, useFloatingPosition } from '../lib/floatingLayer'
import { describePermissionMode } from '../../shared/permissionMode'
import { permissionModeIcon } from '../lib/permissionModeIcon'
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

/** The selected model's reasoning levels, speeds and how to pick each. */
function useRunOptions({ providerId, modelId, models }: Selection, onSelect: (providerId: string, modelId: string) => void) {
  const reasoning = resolveReasoning(providerId, modelId, models)
  const speeds = getModelSpeedOptions(providerId, modelId, models)
  const effort = reasoning.current
  const pickEffort = (value: string) => onSelect(providerId, withReasoningLevel({ providerId, modelId, models }, value))
  const pickSpeed = (targetModelId: string) =>
    onSelect(providerId, effort === 'off' ? `${parseThinkingSuffixFromModelId(targetModelId).baseId}:off` : targetModelId)
  return { reasoning, speeds, effort, pickEffort, pickSpeed }
}

/** The speed after the level, when it is not the standard one ("Fast"). */
function speedText(speeds: { current: string } | undefined): string {
  return speeds && speeds.current !== 'standard' ? speedLabel(speeds.current) : ''
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

/** A one-line row of choices (speeds): one stop for Up and Down, Left and Right inside. */
const ROW = '.composer-run-menu-segments'

/**
 * Arrow keys across the run settings: Up and Down move between rows (a one-line row is one stop,
 * entered on its chosen item), Left and Right between the items in the row, Home and End to the ends.
 * Left from a row's first item, and Up or Down past the ends, are left to the caller (the model
 * picker moves to the list or its footer).
 * Enter and Space pick the focused item (they are buttons).
 */
function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  if (!items.length) return
  const active = document.activeElement as HTMLElement | null
  const index = active ? items.indexOf(active) : -1
  const row = active?.closest(ROW)
  const focus = (item: HTMLElement | undefined) => { if (item) { event.preventDefault(); item.focus() } }
  // A stop in a one-line row lands on its chosen item.
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
      if (event.key === 'ArrowLeft' && at === 0) return
      if (event.key === 'ArrowRight' && at === inRow.length - 1) { event.preventDefault(); return }
      focus(inRow[at + (event.key === 'ArrowRight' ? 1 : -1)])
      return
    }
    case 'ArrowDown':
    case 'ArrowUp': {
      const step = event.key === 'ArrowDown' ? 1 : -1
      let next = index
      do next += step
      while (row && next >= 0 && next < items.length && items[next]!.closest(ROW) === row)
      if (next < 0 || next >= items.length) return
      focus(stop(items[next]))
      return
    }
    case 'Home': focus(stop(items[0])); return
    case 'End': focus(stop(items[items.length - 1])); return
  }
}

/** Puts focus on the chosen item of the run settings in `container` (the first item without one). */
function focusRunSettings(container: HTMLElement | null | undefined, focusVisible?: boolean): boolean {
  const item = container?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? container?.querySelector<HTMLElement>('[role="menuitemradio"]')
  // `focusVisible` (Chromium) keeps the focus ring off when a pointer opened the menu.
  item?.focus({ preventScroll: true, ...(focusVisible === undefined ? {} : { focusVisible }) } as FocusOptions)
  return Boolean(item)
}

/** Says a level the model does not offer runs at its default instead. */
function levelNote(unsupported: string, model: LlmModelOption | undefined, reasoning: { defaultLevel?: string }, effort: string | undefined): string {
  return `${reasoningLevelLabel(unsupported)} isn't offered for ${model ? parseModelVariant(model).familyLabel : 'this model'}; using ${reasoning.defaultLevel ? 'its default' : reasoningLevelLabel(effort ?? '')}.`
}

/**
 * How a turn runs: reasoning level, and speed when the model lists more than one, each section only
 * when the model offers it. A level the model does not offer (saved, or carried over from the model
 * picked before) runs at the model's default, and a line says so.
 */
function runSections({ selection, readOnly, onClose, dropped, current = true }: {
  selection: Selection
  readOnly: boolean
  onClose: () => void
  /** A level carried over from the model picked before that this one does not offer. */
  dropped?: string
  /** The selection is the thread's: picking the level already chosen changes nothing. */
  current?: boolean
}, run: ReturnType<typeof useRunOptions>): ReactNode[] {
  const { reasoning, speeds, effort, pickEffort, pickSpeed } = run
  const modelName = parseThinkingSuffixFromModelId(selection.modelId).baseId
  const model = selection.models.find((entry) => entry.id === selection.modelId || entry.id === modelName)
  const unsupported = dropped ?? reasoning.unsupported
  // Picking the level the thread runs at by default saves it as chosen, so it carries to the next model.
  const chosen = parseThinkingSuffixFromModelId(selection.modelId).effort
  const sections: ReactNode[] = []
  if (reasoning.levels.length > 0) sections.push(<div key="reasoning" className="composer-mode-menu-section" role="group" aria-label="Reasoning">
    <div className="composer-mode-menu-heading">Reasoning</div>
    {reasoning.levels.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={effort === value} disabled={readOnly} title={reasoning.descriptions[value]} className={`composer-mode-menu-item${effort === value ? ' selected' : ''}`} onClick={() => { onClose(); if (!current || value !== chosen) pickEffort(value) }}>
      <span>{reasoningLevelLabel(value)}</span>
      {value === reasoning.defaultLevel && <span className="composer-mode-menu-item-meta">Default</span>}
    </button>)}
    {unsupported && <div className="composer-run-menu-note" role="note" aria-live="polite">{levelNote(unsupported, model, reasoning, effort)}</div>}
  </div>)
  // Speed is one line of segments, one per speed the model lists (Standard | Fast, and any faster tier).
  if (speeds) sections.push(<div key="speed" className="composer-mode-menu-section composer-run-menu-speed" role="group" aria-label="Speed">
    <div className="composer-mode-menu-heading">Speed</div>
    <div className="composer-run-menu-segments">
      {speeds.options.map((option) => {
        const on = option.speed === speeds.current
        return <button key={option.speed} type="button" role="menuitemradio" aria-checked={on} disabled={readOnly} className={`composer-run-menu-segment${on ? ' selected' : ''}`} onClick={() => { onClose(); if (!current || !on) pickSpeed(option.modelId) }}>{speedLabel(option.speed)}</button>
      })}
    </div>
  </div>)
  return sections.map((section, index) => index === 0 ? section : <div key={`group-${index}`} className="composer-mode-menu-group">{section}</div>)
}

/** The run settings as their own menu: Settings' reasoning picker. */
function RunMenu({ selection, onSelect, readOnly, contentRef, style, onClose }: {
  selection: Selection
  onSelect: (providerId: string, modelId: string) => void
  readOnly: boolean
  contentRef: RefObject<HTMLDivElement | null>
  style: React.CSSProperties
  onClose: () => void
}) {
  const run = useRunOptions(selection, onSelect)
  // The chosen item takes focus, so the arrow keys start from it.
  useLayoutEffect(() => { focusRunSettings(contentRef.current) }, [contentRef])
  const sections = runSections({ selection, readOnly, onClose }, run)
  return <FloatingPortal><div ref={contentRef} style={style} className="composer-mode-menu composer-mode-menu-floating composer-run-menu" role="menu" aria-label="Run options" onKeyDown={moveFocus}>
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
  const { reasoning, speeds, effort } = useRunOptions({ providerId, modelId, models }, onSelect)
  const style = useFloatingPosition({ open, anchorRef, contentRef, placement: 'above-start', deps: [modelId] })
  useDismiss(open, setOpen, anchorRef, contentRef)
  const close = () => { setOpen(false); anchorRef.current?.focus() }
  const speed = speedText(speeds)
  if (!reasoning.levels.length && !speeds) return null
  return <div className="composer-effort-picker">
    <button ref={anchorRef} type="button" className={`composer-pill-btn${open ? ' open' : ''}`} disabled={readOnly} aria-label="Reasoning effort and speed" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Brain size={14} aria-hidden="true" /><span>{effort ? formatEffortLabel(effort) : 'Effort'}{speed ? ` · ${speed}` : ''}</span><ChevronDown size={12} />
    </button>
    {open && !readOnly && <RunMenu selection={{ providerId, modelId, models }} onSelect={onSelect} readOnly={readOnly} contentRef={contentRef} style={style} onClose={close} />}
  </div>
}

/** The level as the composer shows it after the model name ("High"). */
export function runLevelText(selection: Selection): string {
  const reasoning = resolveReasoning(selection.providerId, selection.modelId, selection.models)
  const speeds = getModelSpeedOptions(selection.providerId, selection.modelId, selection.models)
  const effort = reasoning.levels.length > 0 || speeds ? reasoning.current : undefined
  return effort ? reasoningLevelLabel(effort) : ''
}

/** The chosen speed when it is faster than standard ("Fast", "Ultrafast"); the composer shows it as a lightning icon. */
export function runFasterSpeed(selection: Selection): string {
  const speeds = getModelSpeedOptions(selection.providerId, selection.modelId, selection.models)
  return speeds && speeds.current !== 'standard' && speeds.current !== 'slow' ? speedLabel(speeds.current) : ''
}

/** A model the picker shows run settings for, as `carryReasoningLevel` resolved it. */
export interface RunSettingsTarget extends Selection {
  instanceId?: string
  /** The model is the thread's: its settings show as they are. */
  selected: boolean
  dropped?: string
}

/** Whether a target's model has reasoning levels. */
export function hasReasoningLevels(target: RunSettingsTarget): boolean {
  return resolveReasoning(target.providerId, target.modelId, target.models).levels.length > 0
}

/** The reasoning column's header. The model it is for is the highlighted row, so it is not named again. */
function ReasoningHead() {
  return <div className="model-picker-run-head">
    <span className="model-picker-run-title">Reasoning</span>
  </div>
}

/**
 * The model picker's reasoning column: a header naming the model, then its levels, the chosen one
 * checked and the default labelled. Picking a level picks that model too. With no model highlighted
 * (a search with no results) only the header shows. The column scrolls on its own inside the picker.
 */
export function ReasoningColumn({ target, label, onSelect, onClose }: {
  target?: RunSettingsTarget
  /** The model's name as the column header shows it. */
  label?: string
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
  onClose: () => void
}) {
  if (!target) return <div className="model-picker-run-settings" role="group" aria-label="Reasoning"><ReasoningHead /></div>
  return <ReasoningLevels target={target} label={label ?? ''} onSelect={onSelect} onClose={onClose} />
}

function ReasoningLevels({ target, label, onSelect, onClose }: {
  target: RunSettingsTarget
  label: string
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
  onClose: () => void
}) {
  const pick = (providerId: string, modelId: string) => onSelect(providerId, modelId, target.instanceId)
  const { reasoning, effort, pickEffort } = useRunOptions(target, pick)
  const baseId = parseThinkingSuffixFromModelId(target.modelId).baseId
  const model = target.models.find((entry) => entry.id === target.modelId || entry.id === baseId)
  // Picking the level the thread runs at by default saves it as chosen, so it carries to the next model.
  const chosen = parseThinkingSuffixFromModelId(target.modelId).effort
  const unsupported = target.dropped ?? reasoning.unsupported
  return <div className="model-picker-run-settings" role="menu" aria-label={`Reasoning for ${label}`} onKeyDown={moveFocus}>
    <ReasoningHead />
    {reasoning.levels.length === 0 ? <div className="model-picker-run-empty">None for this model</div> : null}
    {reasoning.levels.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={effort === value} title={reasoning.descriptions[value]} className={`composer-mode-menu-item model-picker-level${effort === value ? ' selected' : ''}`} onClick={() => { onClose(); if (!target.selected || value !== chosen) pickEffort(value) }}>
      <span>{reasoningLevelLabel(value)}</span>
      {value === reasoning.defaultLevel ? <span className="composer-mode-menu-item-meta">Default</span> : null}
      <span className="model-picker-level-check" aria-hidden="true">{effort === value ? <Check size={14} /> : null}</span>
    </button>)}
    {unsupported && reasoning.levels.length > 0 ? <div className="composer-run-menu-note" role="note" aria-live="polite">{levelNote(unsupported, model, reasoning, effort)}</div> : null}
  </div>
}

/**
 * The picker footer's speed toggle for the highlighted model: one small pill of segments (Standard,
 * Fast, and any faster tier the model lists). Arrow keys move between segments; Enter or a click picks.
 * Nothing when the model has one speed.
 */
export function SpeedToggle({ target, onSelect, onClose }: {
  target: RunSettingsTarget
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
  onClose: () => void
}) {
  const { speeds, pickSpeed } = useRunOptions(target, (providerId, modelId) => onSelect(providerId, modelId, target.instanceId))
  if (!speeds) return null
  const move = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
    const next = items[items.indexOf(document.activeElement as HTMLElement) + (event.key === 'ArrowRight' ? 1 : -1)]
    event.preventDefault()
    next?.focus()
  }
  return <div className="model-picker-speed" role="radiogroup" aria-label="Speed" onKeyDown={move}>
    {speeds.options.map((option) => {
      const on = option.speed === speeds.current
      const faster = option.speed !== 'standard' && option.speed !== 'slow'
      return <button key={option.speed} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={`model-picker-speed-option${on ? ' selected' : ''}`} onClick={() => {
        if (target.selected && on) return
        onClose()
        pickSpeed(option.modelId)
      }}>
        {faster ? <Zap size={13} aria-hidden="true" /> : null}
        <span>{speedLabel(option.speed)}</span>
      </button>
    })}
  </div>
}

/**
 * The composer's permission chip: the thread's mode as an icon, left of the model button. One click
 * opens the modes above the composer, one row each with its name and what it does. Only Full access
 * is tinted (amber). The menu keeps focus inside; Escape closes it back to the chip.
 */
export function PermissionChip({ control }: { control: PermissionControl }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const openedByKeyboard = useRef(false)
  const choice = permissionChoice(control)
  const Icon = permissionModeIcon(choice.shown)
  const name = describePermissionMode(choice.shown)
  // Why the mode runs or is capped differently: the agent cannot enforce it, or a limit sits below.
  const limit = choice.reason ?? Object.values(choice.blocked)[0]
  // Above the whole composer (left edges lined up), so it never covers the draft.
  const anchorRef = useClosestAnchor(buttonRef, '.composer')
  const style = useFloatingPosition({ open, anchorRef, contentRef: menuRef, placement: 'above-start', deps: [control.mode] })
  const close = () => { setOpen(false); buttonRef.current?.focus() }
  useEffect(() => {
    if (!open) return
    focusRunSettings(menuRef.current, openedByKeyboard.current)
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
      return
    }
    moveFocus(event)
  }
  const label = `Permissions: ${name}`
  return <>
    <button
      ref={buttonRef}
      type="button"
      className={`composer-icon-btn composer-permission-chip${open ? ' open' : ''}${choice.shown === 'full' ? ' is-full' : ''}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={limit ? `${label}. ${limit}` : label}
      title={limit ? `${label}. ${limit}` : label}
      onClick={(event) => {
        // A click from Enter or Space has no pointer detail.
        openedByKeyboard.current = event.detail === 0
        setOpen(!open)
      }}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
    {open ? <FloatingPortal><div ref={menuRef} style={style} className="composer-mode-menu composer-mode-menu-floating composer-run-menu composer-permission-menu" role="menu" aria-label="Permissions" onKeyDown={keys}>
      <PermissionModeSection control={control} choice={choice} onPicked={close} />
    </div></FloatingPortal> : null}
  </>
}
