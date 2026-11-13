import type { BotComputerChoice, BotRunsOnChoices } from '../../../shared/bots/personal/methods'
import { Select, type SelectOption } from '../ui/Select'

/**
 * What a bot runs on, by hand (#673): the model and computer pickers About → Runs on and New bot share. The model is
 * By usage (the default) or one of the ready models that can hold a bot; the computer is this one, with the person's
 * other computers listed but greyed.
 */

/** Said on both pickers' model control. */
export const BY_USAGE_TITLE = 'By usage picks a ready model each run'

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

/** The model picker: '' is By usage, passed on as null. */
export function BotModelSelect({ ariaLabel, models, value, onChange }: { ariaLabel: string; models: BotRunsOnChoices['models']; value: string | null; onChange: (model: string | null) => void }) {
  return <Select ariaLabel={ariaLabel} size="small" value={value ?? ''} options={botModelOptions(models, value)} title={BY_USAGE_TITLE} onChange={(model) => onChange(model || null)} />
}

/** The computer picker, shown once there are two or more computers: only the one that holds the bot can be picked. */
export function BotComputerSelect({ ariaLabel, title, choices }: { ariaLabel: string; title: string; choices: Pick<BotRunsOnChoices, 'computer' | 'computers'> }) {
  return <Select ariaLabel={ariaLabel} size="small" value={choices.computer} options={botComputerOptions(choices.computers)} title={title} onChange={() => undefined} />
}
