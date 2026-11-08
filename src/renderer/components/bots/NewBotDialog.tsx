import { useState } from 'react'
import { pickDistinctLook, type BotLook } from '../../../shared/bots/personal/look'
import { useBotsStore } from '../../stores/botsStore'
import { useChatsStore } from '../../stores/chatsStore'
import { BotDialogFrame } from './BotDialogs'
import { BotLookPicker } from './face/BotLookPicker'

/**
 * New bot (bot-ui §4.2): a look already picked (one the owner's other bots don't wear), an optional
 * name and one sentence. Create bot opens its chat at once; there is nothing else to fill in.
 */
export function NewBotDialog() {
  const bots = useBotsStore((s) => s.bots)
  const busy = useBotsStore((s) => s.busy)
  const error = useBotsStore((s) => s.error)
  const [look, setLook] = useState<BotLook>(() => pickDistinctLook(bots.map((bot) => bot.look)))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const close = () => useBotsStore.setState({ newBotOpen: false, error: null })
  const ready = description.trim().length > 0 && !busy
  const submit = async () => {
    if (!ready) return
    const bot = await useBotsStore.getState().create({ look, description: description.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
    if (bot) await useChatsStore.getState().openBot(bot.id)
  }
  return <BotDialogFrame title="New bot" onClose={close} busy={busy} width={520}>
    <form className="bot-new-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <BotLookPicker look={look} onChange={setLook} existingLooks={bots.map((bot) => bot.look)} />
      <label className="bot-new-label" htmlFor="bot-new-name">Name</label>
      <input id="bot-new-name" className="bot-new-name" maxLength={60} value={name} placeholder="Optional. Leave it empty and the bot names itself." onChange={(event) => setName(event.target.value)} />
      <label className="bot-new-label" htmlFor="bot-new-text">What should it do?</label>
      <textarea id="bot-new-text" className="bot-new-text" maxLength={500} value={description} placeholder="For example: every morning, tell me which emails need a reply."
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() } }} />
      {error && <p role="alert" className="chat-error">{error}</p>}
      <div className="bot-new-foot">
        <span className="bot-new-hint">Change anything later by asking it.</span>
        <button type="submit" className="chat-primary-button" disabled={!ready}>{busy ? 'Creating…' : 'Create bot'}</button>
      </div>
    </form>
  </BotDialogFrame>
}
