import { useState } from 'react'
import { CircleCheck, Shield } from '../../lib/icons'
import type { BotAskCard as BotAsk } from '../../../shared/bots/personal/chat'

export interface BotAskCardProps {
  botName: string
  ask: BotAsk
  /** A run's ask (a notice row): Allow applies from the next run. */
  fromRun?: boolean
  onAnswer(answer: 'allow' | 'not_now'): Promise<void> | void
  /** `export_memory`: Allow picks a folder and saves the memory there, then closes the card. */
  onExport?(): Promise<void> | void
}

/** The one line an answered ask becomes. */
export function askAnswerLine(ask: BotAsk, fromRun = false): string {
  if (ask.status === 'allowed') {
    if (ask.kind === 'export_memory') return 'Saved its memory to the folder you picked'
    return fromRun ? `Allowed: ${ask.title}. It uses it from the next run.` : `Allowed: ${ask.title}`
  }
  if (ask.status === 'not_now') return `Not now: ${ask.title}`
  return `No longer needed: ${ask.title}`
}

/**
 * An ask in the bot's message (C4, bot-ui §4.5): "<name> wants to **<title>**", the note on its
 * limit, then Not now and Allow. Once answered it is one line.
 */
export function BotAskCard({ botName, ask, fromRun = false, onAnswer, onExport }: BotAskCardProps) {
  const [busy, setBusy] = useState(false)
  if (ask.status !== 'open') {
    return <div className="bot-ask-answer" role="status">{ask.status === 'allowed' && <CircleCheck size={13} aria-hidden />}{askAnswerLine(ask, fromRun)}</div>
  }
  const run = async (action: () => Promise<void> | void) => {
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  const allow = () => run(() => (ask.kind === 'export_memory' && onExport ? onExport() : onAnswer('allow')))
  return <div className="bot-ask" role="group" aria-label={`${botName} asks`}>
    <div className="bot-ask-title"><Shield size={16} aria-hidden /><span>{botName} wants to <strong>{ask.title}</strong></span></div>
    {ask.note && <p className="bot-ask-note">{ask.note}</p>}
    <div className="bot-ask-actions">
      <button type="button" className="bot-ghost-button" disabled={busy} onClick={() => void run(() => onAnswer('not_now'))}>Not now</button>
      <button type="button" className="chat-primary-button" disabled={busy} onClick={() => void allow()}>Allow</button>
    </div>
  </div>
}
