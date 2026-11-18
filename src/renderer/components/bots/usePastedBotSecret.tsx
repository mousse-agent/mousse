import { useRef, useState } from 'react'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { pastedSecretShape } from '../../../shared/secretShapes'
import { DEFAULT_SECRET_KEEP, SECRET_KEEPS, secretKeepLabel, type SecretKeep } from '../../../shared/secretRequests'
import { useBotsStore } from '../../stores/botsStore'

/** Raw credentials stay in this composer's state. Only an explicit choice reaches the local secret method. */
export function usePastedBotSecret(bot: BotSummary, storedDraft: string) {
  const [privateDraft, setPrivateDraft] = useState<{ botId: string; text: string } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [highlighted, setHighlighted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [keep, setKeep] = useState<SecretKeep>(DEFAULT_SECRET_KEEP)
  const revision = useRef(0)
  const currentBot = useRef(bot.id)
  currentBot.current = bot.id
  const draft = privateDraft?.botId === bot.id ? privateDraft.text : storedDraft
  const shape = pastedSecretShape(draft)
  const change = (text: string) => {
    revision.current++
    setDismissed(false); setHighlighted(false); setFailed(false)
    if (pastedSecretShape(text)) {
      setPrivateDraft({ botId: bot.id, text })
      useBotsStore.getState().setDraft(bot.id, '')
    } else {
      setPrivateDraft(null)
      useBotsStore.getState().setDraft(bot.id, text)
    }
  }
  const save = async () => {
    if (!shape || busy) return
    const version = revision.current
    setBusy(true)
    setFailed(false)
    try {
      const { name } = await window.mousse.platformRequest.request<{ name: string }>('secrets.keepPasted', { botId: bot.id, value: draft.slice(shape.start, shape.end), keep })
      // No old answer may rewrite another bot's composer or text edited while saving.
      if (revision.current === version && currentBot.current === bot.id) change(`${draft.slice(0, shape.start)}the secret ${name}${draft.slice(shape.end)}`)
    } catch {
      if (revision.current === version && currentBot.current === bot.id) setFailed(true)
    } finally { setBusy(false) }
  }
  const beforeSend = () => {
    if (busy) return false
    if (shape && !dismissed && !highlighted) { setHighlighted(true); return false }
    // Ordinary sending starts only after the owner accepted sending text (or the extra Send).
    if (privateDraft?.botId === bot.id) {
      useBotsStore.getState().setDraft(bot.id, draft)
      setPrivateDraft(null)
    }
    return true
  }
  const offer = shape && !dismissed ? <div className="bot-pasted-secret secret-request-card" role={highlighted ? 'alert' : 'status'}>
    <p className="composer-question-prompt">This looks like a key. {failed ? `${bot.name} can't keep secrets; remove it before sending, or allow Use secrets in About.` : 'Keep it as a secret?'}</p>
    <div className="secret-request-keep" role="radiogroup" aria-label="Keep it for">
      {SECRET_KEEPS.map(option => <button key={option} type="button" role="radio" aria-checked={keep === option} className={`secret-request-keep-option${keep === option ? ' is-selected' : ''}`} disabled={busy} onClick={() => setKeep(option)}>{secretKeepLabel(option)}</button>)}
    </div>
    <div className="bot-pasted-secret-actions">
      <button type="button" className="composer-question-btn" disabled={busy} onClick={() => void save()}>Keep as secret</button>
      <button type="button" className="composer-question-btn is-quiet" disabled={busy} onClick={() => setDismissed(true)}>Send as text</button>
    </div>
  </div> : null
  return { draft, change, beforeSend, offer }
}
