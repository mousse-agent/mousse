import { useEffect, useId, useState } from 'react'
import type { BotModelPick, BotModelSlotKey, BotModelSlots } from '../../../shared/bots/personal/definition'
import type { BotComputerChoice, BotModelOption, BotRunsOnChoices } from '../../../shared/bots/personal/methods'
import { slotsWith, workRowsDiffer } from '../../../shared/bots/personal/modelSlots'
import { reasoningLevelLabel } from '../../../shared/modelVariants'
import { Switch } from '../settings/SettingsRow'
import { Select, type SelectOption } from '../ui/Select'

/**
 * What a bot runs on, by hand (#673): the model and computer pickers About → Runs on and New bot share. A bot's models
 * are rows: Talk and Work, or with Advanced, Light, Medium and Hard work. Each row is Automatic (the default) or an
 * entry's model at a reasoning level; the computer is this one, with the person's other computers listed but greyed.
 * These pickers are the only bot screens that name models.
 */

/** Said on the model control of a single picker (an older service, before rows). */
export const BY_USAGE_TITLE = 'By usage picks a ready model each run'
/** Said on each row's model control. */
export const AUTOMATIC_TITLE = 'Automatic picks a ready model each time'

/**
 * The Computer picker's options for a bot: this computer, then the person's other computers, which a bot cannot be
 * picked onto (it runs on the computer that holds it) and are greyed with the reason; an offline one says it is offline.
 */
export function botComputerOptions(computers: readonly BotComputerChoice[]): SelectOption[] {
  return computers.map((computer) => ({
    value: computer.id,
    label: computer.offline ? `${computer.name} · offline` : computer.name,
    ...(computer.unavailable ? { disabled: true, description: computer.unavailable } : {})
  }))
}

/** By usage (value ''), then the choices; a picked model that is no longer among them stays, marked as not available now. */
export function botModelOptions(models: BotRunsOnChoices['models'], picked: string | null): SelectOption[] {
  const options: SelectOption[] = [{ value: '', label: 'By usage' }, ...models.map((choice) => ({ value: choice.model, label: choice.label }))]
  if (picked && !models.some((choice) => choice.model === picked)) options.push({ value: picked, label: `${picked} (not available now)` })
  return options
}

/** The single model picker of an older service (before rows): '' is By usage, passed on as null. */
export function BotModelSelect({ ariaLabel, models, value, onChange }: { ariaLabel: string; models: BotRunsOnChoices['models']; value: string | null; onChange: (model: string | null) => void }) {
  return <Select ariaLabel={ariaLabel} size="small" value={value ?? ''} options={botModelOptions(models, value)} title={BY_USAGE_TITLE} onChange={(model) => onChange(model || null)} />
}

/** The computer picker, shown once there are two or more computers: only the one that holds the bot can be picked. */
export function BotComputerSelect({ ariaLabel, title, choices }: { ariaLabel: string; title: string; choices: Pick<BotRunsOnChoices, 'computer' | 'computers'> }) {
  return <Select ariaLabel={ariaLabel} size="small" value={choices.computer} options={botComputerOptions(choices.computers)} title={title} onChange={() => undefined} />
}

// -- Rows (#673) ------------------------------------------------------------------------------------------------------

/** A pick as a picker value: '' is Automatic. */
export function botPickValue(pick: Pick<BotModelPick, 'instanceId' | 'model'> | null): string {
  return pick ? JSON.stringify([pick.instanceId ?? '', pick.model]) : ''
}

function pickOfValue(value: string): { instanceId?: string; model: string } | null {
  if (!value) return null
  const [instanceId, model] = JSON.parse(value) as [string, string]
  return { ...(instanceId ? { instanceId } : {}), model }
}

/** The option a pick names, when it is offered now. */
export function botOptionOf(options: readonly BotModelOption[], pick: BotModelPick | null): BotModelOption | undefined {
  return pick?.instanceId ? options.find((option) => option.instanceId === pick.instanceId && option.model === pick.model) : undefined
}

/** A model's name, with its entry's when another entry offers a model of the same name. */
function optionName(options: readonly BotModelOption[], option: BotModelOption): string {
  const twin = options.some((other) => other !== option && other.label === option.label && other.instanceId !== option.instanceId)
  return twin ? `${option.label} · ${option.entry}` : option.label
}

/**
 * A row's model choices: Automatic, then every entry's models under the entry's name. A pick that is not offered now
 * stays, marked so.
 */
export function botPickOptions(options: readonly BotModelOption[], pick: BotModelPick | null): SelectOption[] {
  // Each entry's models together, entries in the order they first come.
  const entries = [...new Set(options.map((option) => option.instanceId))]
  const byEntry = entries.flatMap((instanceId) => options.filter((option) => option.instanceId === instanceId))
  const choices: SelectOption[] = [
    { value: '', label: 'Automatic' },
    ...byEntry.map((option) => ({ value: botPickValue(option), label: option.label, textValue: optionName(options, option), group: option.entry }))
  ]
  if (pick && !botOptionOf(options, pick)) choices.push({ value: botPickValue(pick), label: pick.model, description: pick.instanceId ? 'Not available now' : 'On any entry that offers it' })
  return choices
}

/** A row's reasoning levels: Default (set by how hard the job is), then the ones its model offers. */
export function botLevelOptions(options: readonly BotModelOption[], pick: BotModelPick): SelectOption[] {
  const efforts = botOptionOf(options, pick)?.efforts ?? []
  const levels = pick.effort && !efforts.includes(pick.effort) ? [...efforts, pick.effort] : efforts
  return [{ value: '', label: 'Default' }, ...levels.map((effort) => ({ value: effort, label: reasoningLevelLabel(effort) }))]
}

interface RowSpec {
  key: BotModelSlotKey | 'work'
  label: string
  /** What the row is for, in the label's tooltip. */
  hint: string
}

const TALK_ROW: RowSpec = { key: 'talk', label: 'Talk', hint: 'Every chat reply' }
const SIMPLE_ROWS: readonly RowSpec[] = [TALK_ROW, { key: 'work', label: 'Work', hint: 'Everything it works on' }]
const ADVANCED_ROWS: readonly RowSpec[] = [
  TALK_ROW,
  { key: 'light', label: 'Light work', hint: 'Quick lookups and small routine jobs' },
  { key: 'medium', label: 'Medium work', hint: 'Most work' },
  { key: 'hard', label: 'Hard work', hint: 'Research, and long or difficult problems' }
]

/**
 * A bot's model rows (#673), for About → Runs on and New bot: Talk and Work, and with Advanced, Light, Medium and Hard
 * work. Each row is a model (Automatic, or an entry's model) and, for a model, a reasoning level. Advanced starts open
 * when the work rows differ; closing it puts Medium work's pick on all work. Controlled: `onChange` gets the whole rows.
 */
export function BotModelRows({ name, options, slots, onChange, disabled }: {
  /** The bot's name for the controls' labels ("Pip's Talk model"); New bot passes "New bot". */
  name: string
  options: readonly BotModelOption[]
  slots: BotModelSlots
  onChange: (slots: BotModelSlots) => void
  disabled?: boolean
}) {
  const differ = workRowsDiffer(slots)
  const [advanced, setAdvanced] = useState(differ)
  const advancedId = useId()
  // Rows that came to differ elsewhere (`use_model`, another window) open it.
  useEffect(() => { if (differ) setAdvanced(true) }, [differ])
  const rows = advanced ? ADVANCED_ROWS : SIMPLE_ROWS
  const pickOf = (key: RowSpec['key']) => slots[key === 'work' ? 'medium' : key]
  const set = (key: RowSpec['key'], pick: BotModelPick | null) =>
    onChange(key === 'work' ? slotsWith(slots, 'work', pick) : { ...slots, [key]: pick })
  const toggle = (next: boolean) => {
    setAdvanced(next)
    // One Work model again: Medium work's, on all work.
    if (!next && differ) onChange(slotsWith(slots, 'work', slots.medium))
  }
  return <div className="bot-model-rows" data-testid="bot-model-rows">
    {rows.map((row) => {
      const pick = pickOf(row.key)
      const option = botOptionOf(options, pick)
      // A model with no reasoning levels to pick shows none.
      const levels = pick ? botLevelOptions(options, pick) : []
      return <div className="bot-model-row" key={row.key} data-testid={`bot-model-row-${row.key}`}>
        <span className="bot-model-row-label" title={row.hint}>{row.label}</span>
        <Select
          ariaLabel={`${name}'s ${row.label} model`}
          size="small"
          className="bot-model-row-model"
          value={botPickValue(pick)}
          options={botPickOptions(options, pick)}
          title={option ? `${option.label} on ${option.entry}` : pick ? pick.model : AUTOMATIC_TITLE}
          renderValue={(selected) => (option ? optionName(options, option) : selected?.label ?? 'Automatic')}
          disabled={disabled}
          onChange={(value) => {
            const next = pickOfValue(value)
            // A new model starts at Default; the same one keeps its level.
            set(row.key, next ? { ...next, ...(pick?.effort && next.model === pick.model && next.instanceId === pick.instanceId ? { effort: pick.effort } : {}) } : null)
          }}
        />
        {pick && levels.length > 1
          ? <Select
            ariaLabel={`${name}'s ${row.label} reasoning level`}
            size="small"
            className="bot-model-row-level"
            value={pick.effort ?? ''}
            options={levels}
            title="Reasoning level. Default follows how hard the job is"
            disabled={disabled}
            onChange={(effort) => {
              const { effort: _was, ...model } = pick
              set(row.key, effort ? { ...model, effort } : model)
            }}
          />
          : <span className="bot-model-row-level" aria-hidden />}
      </div>
    })}
    <div className="bot-model-row bot-model-advanced">
      <span className="bot-model-row-label" id={advancedId} title="A model for each kind of work">Advanced</span>
      <Switch checked={advanced} onChange={toggle} labelledBy={advancedId} disabled={disabled} />
    </div>
  </div>
}
