import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Loader2 } from '../../lib/icons'
import { pickDistinctLook } from '../../../shared/bots/personal/look'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotRunsOnChoices } from '../../../shared/bots/personal/methods'
import { botsClient, useBotsStore } from '../../stores/botsStore'
import { useChatsStore } from '../../stores/chatsStore'
import { BotDialogFrame } from './BotDialogs'
import { BotComputerSelect, BotModelSelect } from './BotRunsOn'
import { BotLookPicker } from './face/BotLookPicker'
import '../../styles/chats.css'
import '../../styles/bots.css'

/**
 * New bot (bot-ui §4.2): a look already picked (one the owner's other bots don't wear), an optional
 * name and one sentence, with one line saying where it runs (by usage unless a model is picked by hand, #673).
 * Create bot opens its chat at once; there is nothing else to fill in.
 * What the owner puts in is the store's draft, so closing, a click beside the dialog or a remount
 * never loses it; once anything is put in, only Close or Escape closes the dialog. From Automations it opens
 * with the automation's words and, once made, returns there with the bot picked (`onCreated`) instead.
 */
export function NewBotDialog({ initialDescription = '', onCreated, onClose }: { initialDescription?: string; onCreated?: (bot: BotSummary) => void; onClose?: () => void } = {}) {
  const bots = useBotsStore((s) => s.bots)
  const busy = useBotsStore((s) => s.busy)
  // Only an error about no bot is New bot's: another bot's stays in that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === null ? s.error : null))
  const draft = useBotsStore((s) => s.newBotDraft)
  const { setNewBotDraft } = useBotsStore.getState()
  const close = () => { useBotsStore.getState().closeNewBot(); onClose?.() }
  // Opened from Automations: the automation's words become the draft's sentence, before the first paint.
  useLayoutEffect(() => {
    if (initialDescription.trim()) setNewBotDraft({ description: initialDescription.slice(0, 500) })
  }, [initialDescription, setNewBotDraft])
  // The first time it opens, a look is picked and kept with the draft.
  const [firstLook] = useState(() => pickDistinctLook(bots.map((bot) => bot.look)))
  const look = draft.look ?? firstLook
  useEffect(() => {
    if (!useBotsStore.getState().newBotDraft.look) useBotsStore.setState((state) => ({ newBotDraft: { ...state.newBotDraft, look: firstLook } }))
  }, [firstLook])
  const [choices, setChoices] = useState<BotRunsOnChoices | null>(null)
  const loadChoices = useCallback(() => {
    let live = true
    // An older service has no `bots.model.choices`: the line stays away and the bot runs by usage, as before.
    botsClient().modelChoices().then((next) => { if (live) setChoices(next) }, () => undefined)
    return () => { live = false }
  }, [])
  useEffect(loadChoices, [loadChoices])
  const ready = draft.description.trim().length > 0 && !busy
  const submit = async () => {
    // Read now, not from this render: a second click before the next render must not create again.
    const state = useBotsStore.getState()
    const description = state.newBotDraft.description.trim()
    if (!description || state.busy) return
    const name = state.newBotDraft.name.trim()
    // Only with the line shown: a service without it would refuse the key.
    const model = choices ? state.newBotDraft.model : null
    const bot = await state.create({ look: state.newBotDraft.look ?? look, description, ...(name ? { name } : {}), ...(model ? { model } : {}) })
    if (bot && onCreated) onCreated(bot)
    else if (bot) await useChatsStore.getState().openBot(bot.id)
    // Refused because the pick is gone: the picker shows it as not available now, next to what is.
    else if (model) loadChoices()
  }
  return <BotDialogFrame title="New bot" onClose={close} busy={busy} keepOnBackdrop={draft.touched} width={560}>
    <form className="bot-new-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <BotLookPicker look={look} onChange={(next) => setNewBotDraft({ look: next })} existingLooks={bots.map((bot) => bot.look)} />
      <label className="bot-new-label" htmlFor="bot-new-name">Name</label>
      <input id="bot-new-name" className="bot-new-name" maxLength={60} value={draft.name} placeholder="Optional. Leave it empty and the bot names itself." onChange={(event) => setNewBotDraft({ name: event.target.value })} />
      <label className="bot-new-label" htmlFor="bot-new-text">What should it do?</label>
      <textarea id="bot-new-text" className="bot-new-text" maxLength={500} value={draft.description} placeholder="For example: every morning, tell me which emails need a reply."
        onChange={(event) => setNewBotDraft({ description: event.target.value })}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() } }} />
      {choices ? <NewBotRunsOn choices={choices} model={draft.model} onModel={(model) => setNewBotDraft({ model })} /> : null}
      {error && <p role="alert" className="chat-error">{error}</p>}
      <div className="bot-new-foot">
        <span className="bot-new-hint">Change anything later by asking it.</span>
        <button type="submit" className="chat-primary-button" disabled={!ready}>{busy ? <><Loader2 size={14} className="chat-spin" aria-hidden />Creating…</> : 'Create bot'}</button>
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
    <span>Runs on</span>
    {choices.computers.length > 1
      ? <BotComputerSelect ariaLabel="New bot's computer" title="A bot runs on the computer it is made on" choices={choices} />
      : <span className="bot-new-runs-on-computer" title="This computer. A bot runs on the computer it is made on.">{here?.name ?? 'This computer'}</span>}
    <BotModelSelect ariaLabel="New bot's model" models={choices.models} value={model} onChange={onModel} />
  </div>
}

/** New bot wherever it is opened from: it stays mounted whichever pane shows. */
export function NewBotDialogHost() {
  const open = useBotsStore((s) => s.newBotOpen)
  return open ? <NewBotDialog /> : null
}
