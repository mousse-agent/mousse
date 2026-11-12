import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from '../../lib/icons'
import { pickDistinctLook } from '../../../shared/bots/personal/look'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotRunsOnChoices } from '../../../shared/bots/personal/methods'
import { botsClient, useBotsStore, type NewBotStep } from '../../stores/botsStore'
import { useChatsStore } from '../../stores/chatsStore'
import { WizardSteps } from '../ui/WizardSteps'
import { BotDialogFrame } from './BotDialogs'
import { BotComputerSelect, BotModelSelect } from './BotRunsOn'
import { BotLookPicker } from './face/BotLookPicker'
import '../../styles/chats.css'
import '../../styles/bots.css'

const STEP_LABELS: Record<NewBotStep, string> = { look: 'Look', about: 'What it does', runsOn: 'Runs on' }
/** The Look step's face: larger than Change look's, with the tiles still eight to a row at this width. */
const LOOK_PREVIEW_SIZE = 150
const FOCUSABLE = 'input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]'

/**
 * New bot (bot-ui §4.2) in the steps Add provider uses: Look (one the owner's other bots don't wear, already picked),
 * What it does (an optional name and one sentence, which Next waits for) and Runs on (#673: this computer, by usage
 * unless a model is picked by hand), where Create bot opens its chat. A service without `bots.model.choices` has no
 * Runs on step, so Create bot is on What it does.
 * What the owner puts in, and the step, are the store's draft, so closing, a click beside the dialog or a remount never
 * loses them; once anything is put in, only Close or Escape closes the dialog. A refused create returns to the step
 * that can fix it. From Automations it opens on What it does with the automation's words and, once made, returns
 * there with the bot picked (`onCreated`) instead.
 */
export function NewBotDialog({ initialDescription = '', onCreated, onClose }: { initialDescription?: string; onCreated?: (bot: BotSummary) => void; onClose?: () => void } = {}) {
  const bots = useBotsStore((s) => s.bots)
  const busy = useBotsStore((s) => s.busy)
  // Only an error about no bot is New bot's: another bot's stays in that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === null ? s.error : null))
  const draft = useBotsStore((s) => s.newBotDraft)
  const { setNewBotDraft, setNewBotStep } = useBotsStore.getState()
  const close = () => { useBotsStore.getState().closeNewBot(); onClose?.() }
  // Opened from Automations: the automation's words become the draft's sentence, shown on its step, before the first paint.
  useLayoutEffect(() => {
    if (!initialDescription.trim()) return
    setNewBotDraft({ description: initialDescription.slice(0, 500) })
    setNewBotStep('about')
  }, [initialDescription, setNewBotDraft, setNewBotStep])
  // The first time it opens, a look is picked and kept with the draft.
  const [firstLook] = useState(() => pickDistinctLook(bots.map((bot) => bot.look)))
  const look = draft.look ?? firstLook
  useEffect(() => {
    if (!useBotsStore.getState().newBotDraft.look) useBotsStore.setState((state) => ({ newBotDraft: { ...state.newBotDraft, look: firstLook } }))
  }, [firstLook])
  // undefined while asked; null from an older service, which has no `bots.model.choices`: no Runs on step, by usage as before.
  const [choices, setChoices] = useState<BotRunsOnChoices | null | undefined>(undefined)
  const loadChoices = useCallback(() => {
    let live = true
    botsClient().modelChoices().then((next) => { if (live) setChoices(next) }, () => { if (live) setChoices((known) => known ?? null) })
    return () => { live = false }
  }, [])
  useEffect(loadChoices, [loadChoices])

  const steps: NewBotStep[] = choices === null ? ['look', 'about'] : ['look', 'about', 'runsOn']
  // A step this service has no room for (Runs on, left open before an older service answered) shows as the last one.
  const step = steps.includes(draft.step) ? draft.step : steps[steps.length - 1]!
  const index = steps.indexOf(step)
  const last = index === steps.length - 1
  const described = draft.description.trim().length > 0
  const canGo = !busy && (step === 'look' || described)

  // Focus lands on the step's first control, also when the dialog opens.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus() }, [step])

  const goTo = (next: NewBotStep) => { if (!busy) setNewBotStep(next) }
  const forward = () => {
    if (step === 'about' && !described) { panel.current?.querySelector<HTMLElement>('#bot-new-text')?.focus(); return }
    goTo(steps[index + 1]!)
  }
  const submit = async () => {
    // Read now, not from this render: a second click before the next render must not create again.
    const state = useBotsStore.getState()
    const description = state.newBotDraft.description.trim()
    if (!description || state.busy) return
    const name = state.newBotDraft.name.trim()
    // Only with Runs on shown: a service without it would refuse the key.
    const model = choices ? state.newBotDraft.model : null
    const bot = await state.create({ look: state.newBotDraft.look ?? look, description, ...(name ? { name } : {}), ...(model ? { model } : {}) })
    if (bot && onCreated) onCreated(bot)
    else if (bot) await useChatsStore.getState().openBot(bot.id)
    // Refused because the pick is gone: Runs on shows it as not available now, next to what is.
    else if (model) loadChoices()
  }
  const primary = () => { if (last) void submit(); else forward() }

  return <BotDialogFrame title="New bot" onClose={close} busy={busy} keepOnBackdrop={draft.touched} width={600}>
    <form className="bot-new-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); primary() }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); primary() } }}>
      <WizardSteps steps={steps.map((entry) => STEP_LABELS[entry])} current={index} disabled={busy} onStep={(next) => goTo(steps[next]!)} />
      <div ref={panel} className="bot-new-step" data-step={step}>
        {step === 'look' && <BotLookPicker look={look} previewSize={LOOK_PREVIEW_SIZE} onChange={(next) => setNewBotDraft({ look: next })} existingLooks={bots.map((bot) => bot.look)} />}
        {step === 'about' && <>
          <label className="bot-new-label" htmlFor="bot-new-name">Name</label>
          <input id="bot-new-name" className="bot-new-name" maxLength={60} value={draft.name} placeholder="Optional. Leave it empty and the bot names itself." onChange={(event) => setNewBotDraft({ name: event.target.value })} />
          <label className="bot-new-label" htmlFor="bot-new-text">What should it do?</label>
          <textarea id="bot-new-text" className="bot-new-text" maxLength={500} value={draft.description} placeholder="For example: every morning, tell me which emails need a reply."
            onChange={(event) => setNewBotDraft({ description: event.target.value })} />
        </>}
        {step === 'runsOn' && <div className="bot-new-runs-on-step">
          {choices ? <NewBotRunsOn choices={choices} model={draft.model} onModel={(model) => setNewBotDraft({ model })} /> : null}
        </div>}
        {error && <p role="alert" className="chat-error bot-new-error">{error}</p>}
      </div>
      <div className="bot-new-foot">
        {index > 0 && <button type="button" className="bot-ghost-button" disabled={busy} onClick={() => goTo(steps[index - 1]!)}>Back</button>}
        <button type="submit" className="chat-primary-button" disabled={!canGo} title={last ? 'Change anything later by asking it' : undefined}>
          {last ? (busy ? <><Loader2 size={14} className="chat-spin" aria-hidden />Creating…</> : 'Create bot') : 'Next'}
        </button>
      </div>
    </form>
  </BotDialogFrame>
}

/**
 * Where the new bot will run (#673), as About → Runs on says it: this computer (a picker once there are two or more, the
 * others greyed) and By usage, or a model picked by hand. Left alone, Create bot works as it always has.
 */
function NewBotRunsOn({ choices, model, onModel }: { choices: BotRunsOnChoices; model: string | null; onModel: (model: string | null) => void }) {
  const here = choices.computers.find((computer) => computer.id === choices.computer)
  return <div className="bot-new-runs-on" data-testid="bot-new-runs-on">
    <div className="bot-new-row">
      <span>Computer</span>
      {choices.computers.length > 1
        ? <BotComputerSelect ariaLabel="New bot's computer" title="A bot runs on the computer it is made on" choices={choices} />
        : <span className="bot-new-runs-on-computer" title="This computer. A bot runs on the computer it is made on.">{here?.name ?? 'This computer'}</span>}
    </div>
    <div className="bot-new-row">
      <span>Model</span>
      <BotModelSelect ariaLabel="New bot's model" models={choices.models} value={model} onChange={onModel} />
    </div>
  </div>
}

/** New bot wherever it is opened from: it stays mounted whichever pane shows. */
export function NewBotDialogHost() {
  const open = useBotsStore((s) => s.newBotOpen)
  return open ? <NewBotDialog /> : null
}
