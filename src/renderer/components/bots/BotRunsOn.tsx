import { useEffect, useId, useState } from 'react'
import type { BotModelPick, BotModelSlotKey } from '../../../shared/bots/personal/definition'
import type { BotComputerChoice, BotRunsOnChoices, BotShownRows } from '../../../shared/bots/personal/methods'
import { isPinned, workRowsDiffer } from '../../../shared/bots/personal/modelSlots'
import { modelLabel } from '../../../shared/modelChoice'
import { shortModelName } from '../../../shared/modelNames'
import type { LlmProviderOption } from '../../../shared/settings'
import { resolveModelChoice } from '../../lib/modelChoice'
import { SettingsModelPicker } from '../settings/SettingsModelPicker'
import { Switch } from '../settings/SettingsRow'
import { Select, type SelectOption } from '../ui/Select'

/**
 * What a bot runs on, by hand (#673): the model and computer pickers About → Runs on and New bot share. A bot's models
 * are rows: Talk and Work, or with Advanced, Light, Medium and Hard work. Each row is the app's model picker
 * (`SettingsModelPicker`): an entry's model and its reasoning level, as one choice. The computer is this one, with the
 * person's other computers listed but greyed. These pickers are the only bot screens that name models.
 */

/** Said on the model control of a single picker (an older service, before rows). */
export const BY_USAGE_TITLE = 'By usage picks a ready model each run'
/** A row with no pick yet. */
export const PICK_A_MODEL = 'Pick a model'

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

/** The listing that offers a pick now, and the model on it; undefined when it is not offered now. */
export function offeredListing(providers: readonly LlmProviderOption[], pick: BotModelPick | null): LlmProviderOption | undefined {
  if (!isPinned(pick)) return undefined
  const listing = providers.find((provider) => provider.instanceId === pick.instanceId)
  return listing?.models.some((model) => model.id === pick.model) ? listing : undefined
}

/** A row's tooltip: the model on its entry, why it can't be picked again, or who chooses until it is picked. */
export function botRowTitle(providers: readonly LlmProviderOption[], pick: BotModelPick | null, named?: string): string | undefined {
  const listing = offeredListing(providers, pick)
  if (listing && pick) return `${shortModelName(modelLabel(resolveModelChoice({ instanceId: pick.instanceId, provider: listing.id, model: pick.model }, providers), { effort: false }))} on ${listing.label}`
  if (isPinned(pick)) return 'Not available now. Pick another model.'
  if (named) return `Mousse runs ${shortModelName(named)} by name, on any entry, until you pick one.`
  return undefined
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
const ROWS_OF: Record<RowSpec['key'], readonly BotModelSlotKey[]> = { talk: ['talk'], work: ['light', 'medium', 'hard'], light: ['light'], medium: ['medium'], hard: ['hard'] }

/**
 * A bot's model rows (#673), for About → Runs on and New bot: Talk and Work, and with Advanced, Light, Medium and Hard
 * work, each the app's model picker fed the bot's choices (each ready entry's models that can hold a bot). A row with no
 * pick says Pick a model; on a bot from before picks its tooltip says Mousse chooses until then. Advanced starts open
 * when the work rows differ; closing it puts Medium work's pick on all work (`onOneWork`), and is refused while Medium
 * work has no pick and the rows differ. Controlled: `onPick` gets the rows a pick goes on (Work is all three).
 */
export function BotModelRows({ name, providers, slots, named, onPick, onOneWork, disabled }: {
  /** The bot's name for the controls' labels ("Pip's Talk model"); New bot passes "New bot". */
  name: string
  providers: readonly LlmProviderOption[]
  slots: BotShownRows
  /** Rows of a bot from before picks that run a model by name. */
  named?: Partial<Record<BotModelSlotKey, string>>
  onPick: (rows: readonly BotModelSlotKey[], pick: BotModelPick & { instanceId: string }) => void
  onOneWork: () => void
  disabled?: boolean
}) {
  const differ = workRowsDiffer(slots)
  const [advanced, setAdvanced] = useState(differ)
  const advancedId = useId()
  // Rows that came to differ elsewhere (`use_model`, another window) open it.
  useEffect(() => { if (differ) setAdvanced(true) }, [differ])
  const rows = advanced ? ADVANCED_ROWS : SIMPLE_ROWS
  // Closing puts Medium work's pick on all work: there must be one.
  const cannotClose = advanced && differ && !isPinned(slots.medium)
  const toggle = (next: boolean) => {
    if (!next && cannotClose) return
    setAdvanced(next)
    if (!next && differ) onOneWork()
  }
  return <div className="bot-model-picker" data-testid="bot-model-rows"><div className="bot-model-rows">
    {rows.map((row) => {
      const pick = slots[row.key === 'work' ? 'medium' : row.key]
      const listing = offeredListing(providers, pick)
      const shown = listing && pick ? pick : null
      return <div className="bot-model-row" key={row.key} data-testid={`bot-model-row-${row.key}`}>
        <span className="bot-model-row-label" title={row.hint}>{row.label}</span>
        <SettingsModelPicker
          ariaLabel={`${name}'s ${row.label} model`}
          providers={providers as LlmProviderOption[]}
          providerId={listing?.id ?? ''}
          instanceId={shown?.instanceId}
          modelId={shown?.model ?? ''}
          effort={shown?.effort}
          placeholder={isPinned(pick) && !listing ? `${shortModelName(pick.model)} · not available` : PICK_A_MODEL}
          title={botRowTitle(providers, pick, named?.[row.key === 'work' ? 'medium' : row.key])}
          disabled={disabled}
          // Every pick is sent, also the one the row has: saving it again accepts an entry whose sign-in changed.
          onSelect={(_providerId, choice, instanceId) => {
            if (instanceId) onPick(ROWS_OF[row.key], { instanceId, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) })
          }}
        />
      </div>
    })}
  </div>
    <div className="bot-model-advanced">
      <span id={advancedId} title={cannotClose ? 'Pick a model for Medium work first' : 'A model for each kind of work'}>Advanced</span>
      <Switch checked={advanced} onChange={toggle} labelledBy={advancedId} disabled={disabled || cannotClose} />
    </div>
  </div>
}
