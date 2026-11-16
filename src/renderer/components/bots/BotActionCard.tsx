import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Shield } from '../../lib/icons'
import { useBotsStore } from '../../stores/botsStore'
import { botGroupTime } from './messageGroups'

import type { BotActionCard as BotActionCardData } from '../../../shared/bots/personal/chat'

// The chat guard's invisible and direction-changing characters; keep newlines, tabs and script/emoji joiners.
export function actionText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, '�')
}

/** A literal wrapper escapes this object only; its children have their own stored markers or escapes. */
function Value({ value, literal = false }: { value: unknown; literal?: boolean }): ReactNode {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (!literal && object.$mousse === 'literal') return <Value value={object.value} literal />
    if (!literal && object.$mousse === 'hidden' && object.text === 'hidden · will be sent')
      return <span className="bot-action-hidden" aria-label="Hidden value that will be sent">hidden · will be sent</span>
    if (!Object.keys(object).length) return <code aria-label="Object">{'{}'}</code>
    return <dl>{Object.entries(object).map(([key, child]) => <div key={key}><dt>{actionText(key)}</dt><dd><Field name={key} value={child} literal={false} /></dd></div>)}</dl>
  }
  if (Array.isArray(value)) return value.length ? <ol>{value.map((child, index) => <li key={index}><Field name="item" value={child} literal={literal} /></li>)}</ol> : <code aria-label="List">[]</code>
  if (typeof value !== 'string') return <code aria-label="Non-text value">{JSON.stringify(value) ?? String(value)}</code>
  if (value === '') return <span className="bot-action-empty">(empty text)</span>
  const text = /^(?:true|false|null|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|\[\]|\{\})$/i.test(value.trim()) ? JSON.stringify(value) : value
  return <blockquote className="bot-action-text">{actionText(text).replaceAll("\n", "↵\n")}</blockquote>
}
function Field({ name, value, literal }: { name: string; value: unknown; literal: boolean }) {
  return (Array.isArray(value) && value.length > 8) || typeof value === 'string' && (value.length > 160 || /^(body|text|content|message)$/i.test(name))
    ? <details><summary>Read {actionText(name)}</summary><Value value={value} literal={literal} /></details>
    : <Value value={value} literal={literal} />
}
function Arguments({ value }: { value: unknown }) {
  const region = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = () => {
    const element = region.current
    setMore(Boolean(element && element.scrollTop + element.clientHeight < element.scrollHeight - 1))
  }
  useLayoutEffect(() => {
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (region.current) observer?.observe(region.current)
    return () => observer?.disconnect()
  }, [value])
  return <>
    <div ref={region} className="bot-action-arguments" role="region" tabIndex={0} aria-label="Complete arguments" onScroll={measure} onToggleCapture={measure}><Value value={value} /></div>
    {more && <p role="note" className="bot-action-notice"><Shield size={14} aria-hidden />More arguments below</p>}
  </>
}

function outcome(card: BotActionCardData): string {
  switch (card.status) {
    case 'open': return ''
    case 'approved': case 'running': return 'Sending…'
    case 'done': return 'Sent'
    case 'failed': return card.result?.toolReportedError ? 'The tool reported an error' : 'Not sent'
    case 'uncertain': return "Couldn't tell if it went through"
    case 'expired': return 'Expired · not sent'
    default: return 'Not sent'
  }
}

export function actionStatus(card: BotActionCardData): string {
  const status = outcome(card)
  return status && card.at ? `${status} · ${botGroupTime(card.at)}` : status
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
  const argumentsView = <>
    <Arguments value={card.args} />
    {card.note && <blockquote className="bot-action-note" aria-label="Bot note">{actionText(botName).replace(/\s+/g, " ")} says: <span>{actionText(card.note).replace(/\s+/g, " ")}</span></blockquote>}
  </>
  return <section className="bot-action-card bot-ask-replies" aria-label="Action to review">
    <p className="bot-action-title" aria-label="Action summary">{actionText(card.title)} · <span className="bot-action-server">{actionText(card.serverName)}</span></p>
    {card.status === 'open' ? argumentsView : <details aria-label="Action arguments"><summary>Review arguments</summary>{argumentsView}</details>}
    {card.result && (card.status === 'open' || card.result.toolReportedError) && <blockquote role="note" aria-label="Tool result">{actionText(card.result.text)}</blockquote>}
    {actionStatus(card) && <p role="status" className="bot-question-settled" data-find-text data-message-id={messageId} data-part-index="0">{actionStatus(card)}</p>}
    {card.status === 'open' && <>
      {previous && <p role="note" className="bot-action-notice"><Shield size={14} aria-hidden />{actionText(botName)} {previous.status === 'done' ? 'already sent exactly this' : previous.status === 'failed' ? 'already tried exactly this; the tool reported an error' : "already tried exactly this and couldn't tell if it went through"} at {botGroupTime(previous.at)}</p>}
      {card.hasHiddenValues && <p role="note" className="bot-action-notice"><Shield size={14} aria-hidden />Hidden values will be sent: {card.hiddenPaths.map((path) => actionText(path.replaceAll('.', ' → '))).join(', ')}</p>}
      {card.tooLarge && <p role="note" className="bot-action-notice"><Shield size={14} aria-hidden />This is too large to send from here. Use the computer to review and send it.</p>}
      {changed && <p role="status" className="bot-action-notice"><Shield size={14} aria-hidden />This changed since you saw it</p>}
      {error && <p role="alert" className="bot-action-notice"><Shield size={14} aria-hidden />{error}</p>}
      <div className="bot-ask-buttons" role="group" aria-label="Answer this action">
        <button type="button" disabled={sending || card.tooLarge} onClick={() => void answer('send')}>Send</button>
        <button type="button" disabled={sending} onClick={() => void answer('not_now')}>Not now</button>
      </div>
    </>}
  </section>
}
