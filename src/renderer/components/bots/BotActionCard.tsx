import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert } from '../../lib/icons'
import { useBotsStore, type BotActionRefusal } from '../../stores/botsStore'
import { guardTextCharacters } from '../../../shared/bots/personal/modelSlots'
import { botGroupTime } from './messageGroups'

import type { BotActionCard as BotActionCardData } from '../../../shared/bots/personal/chat'

const addressLike = (text: string) => /@|:\/\/|(?:[\p{L}\p{N}\u200c\u200d-]+\.)+[\p{L}]{2,}/u.test(text)

export function actionText(text: string): string {
  return text.split(/(\s+)/u).map((token) => guardTextCharacters(token, addressLike(token) ? 'address' : 'data')).join('')
}
function fieldName(text: string): string {
  const visible = actionText(text)
  return !text ? '(no name)' : visible === '(no name)' || /^\s+$/.test(visible) || /[\r\n↵\\"'“”‘’＂«»„]/u.test(visible) ? JSON.stringify(visible) : visible
}
function FieldName({ text }: { text: string }) {
  return text === '' ? <span className="bot-action-empty" aria-label="Empty field name">(no name)</span> : <>{fieldName(text)}</>
}
function AlphabetWarning({ text }: { text: string }) {
  const outsideAscii = (token: string) => /(?=[^\x00-\x7f])[\p{L}\p{N}]/u.test(token)
  const phoneLike = /^\+?[\p{N}(][\p{N}\s()+.-]{4,}$/u.test(text.trim())
  const warn = text.split(/\s+/u).some(token => addressLike(token) && outsideAscii(token)) || phoneLike && outsideAscii(text)
  return warn ? <small className="bot-action-alphabet" aria-label="Non-ASCII letters or digits">Contains letters or digits outside A–Z and 0–9</small> : null
}

/** A literal wrapper escapes this object only; its children have their own stored markers or escapes. */
function Value({ value, literal = false }: { value: unknown; literal?: boolean }): ReactNode {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (!literal && object.$mousse === 'literal') return <Value value={object.value} literal />
    if (!literal && object.$mousse === 'hidden' && object.text === 'hidden · will be sent')
      return <span className="bot-action-hidden" aria-label="Hidden value that will be sent">hidden · will be sent</span>
    if (!Object.keys(object).length) return <code aria-label="Object">{'{}'}</code>
    return <dl>{Object.entries(object).map(([key, child]) => <div key={key}><dt><FieldName text={key} /></dt><dd><Field name={key} value={child} literal={false} /></dd></div>)}</dl>
  }
  if (Array.isArray(value)) return value.length ? <ol>{value.map((child, index) => <li key={index}><Field name="item" value={child} literal={literal} /></li>)}</ol> : <code aria-label="List">[]</code>
  if (typeof value !== 'string') return <code aria-label="Non-text value">{JSON.stringify(value) ?? String(value)}</code>
  if (value === '') return <span className="bot-action-empty">(empty text)</span>
  const text = /^(?:true|false|null|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|\[\]|\{\})$/i.test(value.trim()) || /^["'“”‘’＂«»„]|["'“”‘’＂«»„]$/u.test(value) || value === '(empty text)' || /^\s+$/.test(value) ? JSON.stringify(value) : value
  return <div><blockquote className="bot-action-text">{actionText(text).replaceAll("\n", "↵\n")}</blockquote><AlphabetWarning text={value} /></div>
}
function Field({ name, value, literal }: { name: string; value: unknown; literal: boolean }) {
  return (Array.isArray(value) && value.length > 8) || typeof value === 'string' && (value.length > 280 || value.split(/\r\n|\r|\n/).length > 4)
    ? <details><summary>Read {fieldName(name)}</summary><Value value={value} literal={literal} /></details>
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
    const element = region.current
    if (element) observer?.observe(element)
    // Details toggle does not bubble; capture it with the native API supported by this element.
    element?.addEventListener('toggle', measure, true)
    return () => { observer?.disconnect(); element?.removeEventListener('toggle', measure, true) }
  }, [value])
  return <>
    <div ref={region} className="bot-action-arguments" role="region" tabIndex={0} aria-label="Everything it will send" onScroll={measure}><Value value={value} /></div>
    {more && <p role="note" className="bot-action-notice">More below</p>}
  </>
}

function HiddenPaths({ paths }: { paths: string[][] }) {
  return <div className="bot-action-paths">{paths.map((path, index) => <div key={index} aria-label="Hidden field path">
    {path.map((segment, part) => <Fragment key={part}>{part > 0 && ' → '}{segment.length > 80
      ? <details><summary>Read field name</summary><span className="bot-action-path-segment" aria-label="Field name">{segment === '' ? <span className="bot-action-empty" aria-label="Empty field name">(no name)</span> : actionText(JSON.stringify(segment).slice(1, -1))}</span></details>
      : <span className="bot-action-path-segment" aria-label="Field name">{segment === '' ? <span className="bot-action-empty" aria-label="Empty field name">(no name)</span> : actionText(JSON.stringify(segment).slice(1, -1))}</span>}</Fragment>)}
  </div>)}</div>
}

function outcome(card: BotActionCardData): string {
  switch (card.status) {
    case 'open': return ''
    case 'approved': return `Waiting for ${actionText(card.serverName)}…`
    case 'running': return 'Sending…'
    case 'done': return 'Sent'
    case 'failed': return card.result?.notSentInTime ? actionText(card.result.text ?? '') : card.result?.toolReportedError ? 'The tool reported an error' : 'Not sent'
    case 'uncertain': return "Couldn't tell if it went through"
    case 'expired': return 'Expired · not sent'
    default: return 'Not sent'
  }
}

export function actionTitle(card: BotActionCardData): string {
  return actionText(card.title).replace(/\s+/g, ' ')
}

/** The compact label comes only from the same masked data the full review shows. */
function identification(value: unknown, literal = false): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const child of value) { const found = identification(child); if (found) return found }
    return undefined
  }
  const object = value as Record<string, unknown>
  if (!literal && object.$mousse === 'hidden') return undefined
  if (!literal && object.$mousse === 'literal') return identification(object.value, true)
  const visible = (child: unknown): string | undefined => {
    if (typeof child === 'string') return child
    if (typeof child === 'number' || typeof child === 'boolean') return String(child)
    if (Array.isArray(child)) return child.map(visible).filter(Boolean).join(', ')
    return undefined
  }
  for (const [name, child] of Object.entries(object)) {
    if (/^(to|recipient|email|channel|subject|title)$/i.test(name)) {
      const text = visible(child)?.replace(/\s+/g, ' ').trim()
      if (text) return Array.from(actionText(text)).slice(0, 140).join('')
    }
    const nested = identification(child)
    if (nested) return nested
  }
  return undefined
}

function reviewLabel(card: BotActionCardData): string {
  if (card.result?.notSentInTime) return 'What it would have sent'
  if (card.status === 'done' || card.status === 'failed' && card.result?.toolReportedError) return 'What it sent'
  if (card.status === 'uncertain') return 'What it tried to send'
  if (card.status === 'approved') return 'What it will send'
  if (card.status === 'running') return 'What it is sending'
  return 'What it would have sent'
}

function outcomeLabel(card: BotActionCardData): string {
  const text = outcome(card)
  return card.result?.notSentInTime && card.at ? text.replace(/\.\s*$/, '') : text
}

export function actionStatus(card: BotActionCardData): string {
  const status = outcomeLabel(card)
  return status && card.at ? `${status} · ${botGroupTime(card.at)}` : status
}

/** `readOnly`: the copy of a bot whose computer is away; the action shows, and is answered once that computer is back. */
export function BotActionCard({ card, botId, botName, messageId, readOnly = false }: { card: BotActionCardData; botId: string; botName: string; messageId: string; readOnly?: boolean }) {
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<BotActionRefusal | null>(null)
  const [error, setError] = useState('')
  const answer = async (choice: 'send' | 'not_now') => {
    if (sending) return
    setSending(true)
    setError('')
    try {
      const result = await useBotsStore.getState().answerAction(botId, card.actionId, card.digest, choice)
      setRefusal(result)
    } catch {
      setError('Could not answer. Try again.')
    } finally { setSending(false) }
  }
  const previous = card.previous
  const repeatedAt = previous && (new Date(previous.at).toDateString() === new Date().toDateString()
    ? botGroupTime(previous.at)
    : new Date(previous.at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
  const identity = !card.forgotten && !card.tooLarge && !['open', 'approved', 'running'].includes(card.status) ? identification(card.args) : undefined
  const argumentsView = <>
    {!card.tooLarge && <Arguments value={card.args} />}
  </>
  return <section className="bot-action-card bot-ask-replies" aria-label="Action to review">
    <p className="bot-action-title" aria-label="Action summary"><span data-find-text data-message-id={messageId} data-part-index="0">{actionTitle(card)}</span>{!card.forgotten && <> · <span className="bot-action-server">{actionText(card.serverName)}</span></>}</p>
    {identity && <><blockquote className="bot-action-identification" aria-label="Request identification">{identity}</blockquote><AlphabetWarning text={identity} /></>}
    {actionStatus(card) && <p role="status" className="bot-action-outcome" data-find-text data-message-id={messageId} data-part-index="1">{card.at ? <>{outcomeLabel(card)} · <time dateTime={card.at}>{botGroupTime(card.at)}</time></> : actionStatus(card)}</p>}
    {card.status === 'expired' && !card.forgotten && card.askedAt && <p aria-label="Asked time">Asked <time dateTime={card.askedAt}>{botGroupTime(card.askedAt)}</time></p>}
    {!card.forgotten && card.result && !card.result.notSentInTime && card.result.text && (card.status === 'open' || card.result.toolReportedError) && <blockquote role="note" aria-label="Tool result">{actionText(card.result.text ?? '')}</blockquote>}
    {card.forgotten ? <p role="note">Forgotten</p> : card.tooLarge ? null : card.status === 'open' ? argumentsView : <details aria-label={reviewLabel(card)}><summary>{reviewLabel(card)}</summary>{argumentsView}</details>}
    {refusal && !(refusal.reason === 'bot_action_expired' && card.status === 'expired') && <p role="status" className="bot-action-notice"><CircleAlert size={14} aria-hidden />{actionText(refusal.text).replace(/\s+/g, ' ')}</p>}
    {!card.forgotten && card.tooLarge && <p role="note" className="bot-action-notice"><CircleAlert size={14} aria-hidden />This action is too large to review on this device. Use the computer to review and send it.</p>}
    {card.status === 'open' && !card.forgotten && <>
      {previous && <p role="note" className="bot-action-notice"><CircleAlert size={14} aria-hidden />{actionText(botName)} {previous.status === 'done' ? 'already sent exactly this' : previous.status === 'failed' ? 'already tried exactly this; the tool reported an error' : "already tried exactly this and couldn't tell if it went through"} at {repeatedAt}</p>}
      {card.hasHiddenValues && <div role="note" className="bot-action-notice"><CircleAlert size={14} aria-hidden />Hidden values will be sent{card.hiddenPaths.length ? ': ' : ''}<HiddenPaths paths={card.hiddenPaths} /></div>}
      {error && <p role="alert" className="bot-action-notice"><CircleAlert size={14} aria-hidden />{error}</p>}
      {!readOnly && <div className="bot-ask-buttons" role="group" aria-label="Answer this action">
        <button type="button" disabled={sending || card.tooLarge} onClick={() => void answer('send')}>Send</button>
        <button type="button" disabled={sending} onClick={() => void answer('not_now')}>Not now</button>
      </div>}
    </>}
  </section>
}
