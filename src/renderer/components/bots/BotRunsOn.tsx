import { useEffect, useId, useState } from 'react'
import type { BotModelPick, BotModelSlotKey } from '../../../shared/bots/personal/definition'
import type { BotComputerChoice, BotImageUsage, BotRunsOnChoices, BotShownRows } from '../../../shared/bots/personal/methods'
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

/** Whether more than one entry offers models to this bot: then a closed row names its entry beside the model. */
export function severalEntries(providers: readonly LlmProviderOption[]): boolean {
  return new Set(providers.filter((provider) => provider.models.length > 0).map((provider) => provider.instanceId ?? provider.id)).size > 1
}

/** A row's tooltip: the model on its entry, why it can't be picked again, or who chooses until it is picked. */
export function botRowTitle(providers: readonly LlmProviderOption[], pick: BotModelPick | null, named?: string): string | undefined {
  const listing = offeredListing(providers, pick)
  if (listing && pick) return `${shortModelName(modelLabel(resolveModelChoice({ instanceId: pick.instanceId, provider: listing.id, model: pick.model }, providers), { effort: false }))} on ${listing.label}`
  if (isPinned(pick)) return 'Not available now. Pick another model.'
  if (named) return `Mousse runs ${shortModelName(named)} by name, on any entry, until you pick one.`
  return undefined
}

/** The Images row's control while no entry of the owner's can make pictures (its tooltip says what to add). */
export const NO_IMAGE_MODELS = 'None available'
/** The Images row with no pick: the bot makes no pictures. */
export const NO_IMAGES = 'None'

/** The Images row's tooltip: the model on its entry and today's pictures, why it can't be used, or what a pick does. */
export function imageRowTitle(providers: readonly LlmProviderOption[], pick: BotModelPick | null, missing?: string, usage?: BotImageUsage): string {
  const listing = offeredListing(providers, pick)
  const today = usage ? ` · ${usage.today} of ${usage.perDay} today` : ''
  if (listing && pick) return `${shortModelName(modelLabel(resolveModelChoice({ instanceId: pick.instanceId, provider: listing.id, model: pick.model }, providers), { effort: false }))} on ${listing.label}${today}`
  if (isPinned(pick)) return 'Not available now. Pick another model, or None.'
  if (missing) return missing
  return `Pick a model to let it make pictures when you ask${usage ? `, up to ${usage.perDay} a day` : ''}`
}

/** The Images row (#1088): absent from an older service, which has no image tool. */
export interface BotImageRow {
  /** Each ready entry's image models; empty when none of the owner's entries can make pictures. */
  providers: readonly LlmProviderOption[]
  pick: BotModelPick | null
  /** What to add while `providers` is empty (the tooltip). */
  missing?: string
  usage?: BotImageUsage
  /** A model, or null for None. */
  onPick: (pick: (BotModelPick & { instanceId: string }) | null) => void
}

/** The line to say once for the rows: the first picked row's entry that has one (a Codex not checked for bots). */
export function pickedNote(slots: BotShownRows, notes: BotRunsOnChoices['notes']): { text: string; title: string } | undefined {
  if (!notes) return undefined
  for (const row of ['talk', 'light', 'medium', 'hard'] as const) {
    const pick = slots[row]
    if (isPinned(pick) && notes[pick.instanceId]) return notes[pick.instanceId]
  }
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
export function BotModelRows({ name, providers, slots, named, notes, image, onPick, onOneWork, disabled }: {
  /** The bot's name for the controls' labels ("Pip's Talk model"); New bot passes "New bot". */
  name: string
  providers: readonly LlmProviderOption[]
  slots: BotShownRows
  /** Rows of a bot from before picks that run a model by name. */
  named?: Partial<Record<BotModelSlotKey, string>>
  /** By entry, what to say once when a row is picked there (`BotRunsOnChoices.notes`). */
  notes?: BotRunsOnChoices['notes']
  /** The Images row, under the work rows in Advanced (#1088). */
  image?: BotImageRow
  onPick: (rows: readonly BotModelSlotKey[], pick: BotModelPick & { instanceId: string }) => void
  onOneWork: () => void
  disabled?: boolean
}) {
  const differ = workRowsDiffer(slots)
  // An Images row with a pick shows too: Advanced starts open with it.
  const imaged = isPinned(image?.pick)
  const [advanced, setAdvanced] = useState(differ || imaged)
  const advancedId = useId()
  // Rows that came to differ elsewhere (`use_model`, another window), or an image model picked elsewhere, open it.
  useEffect(() => { if (differ || imaged) setAdvanced(true) }, [differ, imaged])
  const rows = advanced ? ADVANCED_ROWS : SIMPLE_ROWS
  // With two or more entries offering models, each row names its entry too, or two entries of one provider look alike.
  const entries = severalEntries(providers)
  // Closing puts Medium work's pick on all work: there must be one.
  const cannotClose = advanced && differ && !isPinned(slots.medium)
  const note = pickedNote(slots, notes)
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
          entry={entries && listing ? listing.label : undefined}
          disabled={disabled}
          // Every pick is sent, also the one the row has: saving it again accepts an entry whose sign-in changed.
          onSelect={(_providerId, choice, instanceId) => {
            if (instanceId) onPick(ROWS_OF[row.key], { instanceId, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) })
          }}
        />
      </div>
    })}
    {advanced && image ? <ImageRow name={name} image={image} disabled={disabled} /> : null}
  </div>
    {note ? <p className="bot-model-note" title={note.title} data-testid="bot-model-note">{note.text}</p> : null}
    <div className="bot-model-advanced">
      <span id={advancedId} title={cannotClose ? 'Pick a model for Medium work first' : image ? 'A model for each kind of work, and for pictures' : 'A model for each kind of work'}>Advanced</span>
      <Switch checked={advanced} onChange={toggle} labelledBy={advancedId} disabled={disabled || cannotClose} />
    </div>
  </div>
}

/**
 * The Images row (#1088): the same label and model picker as the other rows, fed the entries' image models, with None
 * in the menu's footer. While no entry can make pictures, the control says so and its tooltip says what to add.
 */
function ImageRow({ name, image, disabled }: { name: string; image: BotImageRow; disabled?: boolean }) {
  const listing = offeredListing(image.providers, image.pick)
  const shown = listing && image.pick ? image.pick : null
  const none = image.providers.length === 0
  // A pick whose entry offers nothing now can still be set to None: the menu opens on its entry, empty, with None.
  const providers = none && isPinned(image.pick) ? [{ id: image.pick.instanceId.split(':').at(-1) ?? image.pick.instanceId, instanceId: image.pick.instanceId, label: '', models: [] }] : image.providers
  return <div className="bot-model-row" data-testid="bot-model-row-image">
    <span className="bot-model-row-label" title="Pictures it makes when you ask">Images</span>
    <SettingsModelPicker
      ariaLabel={`${name}'s Images model`}
      providers={providers as LlmProviderOption[]}
      providerId={listing?.id ?? ''}
      instanceId={shown?.instanceId}
      modelId={shown?.model ?? ''}
      placeholder={isPinned(image.pick) && !listing ? `${shortModelName(image.pick.model)} · not available` : none ? NO_IMAGE_MODELS : NO_IMAGES}
      title={imageRowTitle(image.providers, image.pick, image.missing, image.usage)}
      entry={severalEntries(image.providers) && listing ? listing.label : undefined}
      disabled={disabled}
      clear={{ label: NO_IMAGES, title: 'It makes no pictures', onClear: () => image.onPick(null) }}
      onSelect={(_providerId, choice, instanceId) => {
        if (instanceId) image.onPick({ instanceId, model: choice.model })
      }}
    />
  </div>
}
