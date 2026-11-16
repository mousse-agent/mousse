import { useState, type ReactNode } from 'react'
import { useBotsStore } from '../../stores/botsStore'
import { botGroupTime } from './messageGroups'

/** Matches the shared projection supplied by the action service. */
export interface BotActionCardData {
  actionId: string; digest: string; title: string; serverName: string; args: unknown
  hasHiddenValues: boolean; hiddenPaths: string[]
  status: 'open' | 'approved' | 'running' | 'done' | 'failed' | 'uncertain' | 'declined' | 'expired' | 'withdrawn'
  at?: string; result?: { text: string; toolReportedError?: boolean }; note?: string
  previous?: { status: 'done' | 'uncertain' | 'failed'; at: string }; tooLarge?: boolean
}

// The chat guard's invisible and direction-changing characters; keep newlines, tabs and script/emoji joiners.
export function actionText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, '�')
}

/** Only structural markers are badges. An escaped literal's entire subtree stays ordinary data. */
function Value({ value, literal = false }: { value: unknown; literal?: boolean }): ReactNode {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (!literal && object.$mousse === 'literal') return <Value value={object.value} literal />
    if (!literal && object.$mousse === 'hidden' && object.text === 'hidden · will be sent')
      return <span className="bot-action-hidden" aria-label="Hidden value that will be sent">hidden · will be sent</span>
    return <dl>{Object.entries(object).map(([key, child]) => <div key={key}><dt>{actionText(key)}</dt><dd><Field name={key} value={child} literal={literal} /></dd></div>)}</dl>
  }
  if (Array.isArray(value)) return value.length ? <ol>{value.map((child, index) => <li key={index}><Value value={child} literal={literal} /></li>)}</ol> : <span>[]</span>
  return <span className="bot-action-text">{actionText(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))}</span>
}
function Field({ name, value, literal }: { name: string; value: unknown; literal: boolean }) {
  return typeof value === 'string' && (value.length > 400 || /^(body|text|content|message)$/i.test(name))
    ? <details><summary>Read {actionText(name)}</summary><Value value={value} literal={literal} /></details>
    : <Value value={value} literal={literal} />
}
export function actionStatus(card: BotActionCardData): string {
  switch (card.status) {
    case 'open': return ''
    case 'approved': case 'running': return 'Sending…'
    case 'done': return `Sent${card.at ? ` · ${botGroupTime(card.at)}` : ''}`
    case 'failed': return card.result?.toolReportedError ? 'The tool reported an error' : 'Not sent'
    case 'uncertain': return "Couldn't tell if it went through"
    case 'expired': return 'Expired · not sent'
    default: return 'Not sent'
  }
}

export function BotActionCard({ card, botId, botName, messageId }: { card: BotActionCardData; botId: string; botName: string; messageId: string }) {
  const [sending, setSending] = useState(false)
  const [changed, setChanged] = useState(false)
  const [error, setError] = useState('')
  const answer = async (choice: 'send' | 'not_now') => {
    if (sending) return
    setSending(true)
    setError('')
    try {
      const result = await useBotsStore.getState().answerAction(botId, card.actionId, card.digest, choice)
      setChanged(result === 'changed')
    } catch {
      setError('Could not answer. Try again.')
    } finally { setSending(false) }
  }
  const previous = card.previous
  return <section className="bot-action-card bot-ask-replies" aria-label="Action to review">
    <p className="bot-action-title">{actionText(card.title)}</p>
    <p className="bot-action-server">{actionText(card.serverName)}</p>
    <div className="bot-action-arguments" tabIndex={0} aria-label="Complete arguments"><Value value={card.args} /></div>
    {card.note && <p className="bot-action-note">{actionText(botName)} says: <span>{actionText(card.note)}</span></p>}
    {card.result && <blockquote role="note" aria-label="Tool result">{actionText(card.result.text)}</blockquote>}
    {actionStatus(card) && <p role="status" className="bot-question-settled" data-find-text data-message-id={messageId} data-part-index="0">{actionStatus(card)}</p>}
    {card.status === 'open' && <>
      {previous && <p role="note">{actionText(botName)} {previous.status === 'done' ? 'already sent exactly this' : previous.status === 'failed' ? 'already tried exactly this; the tool reported an error' : "already tried exactly this and couldn't tell if it went through"} at {botGroupTime(previous.at)}</p>}
      {card.hasHiddenValues && <p role="note">Hidden values will be sent: {card.hiddenPaths.map((path) => actionText(path.replaceAll('.', ' → '))).join(', ')}</p>}
      {card.tooLarge && <p role="note">This is too large to send from here. Use the computer to review and send it.</p>}
      {changed && <p role="status">This changed since you saw it</p>}
      {error && <p role="alert">{error}</p>}
      <div className="bot-ask-buttons" role="group" aria-label="Answer this action">
        <button type="button" disabled={sending || card.tooLarge} onClick={() => void answer('send')}>Send</button>
        <button type="button" disabled={sending} onClick={() => void answer('not_now')}>Not now</button>
      </div>
    </>}
  </section>
}
