import { useState, type ReactNode } from 'react'
import { CircleCheck, Shield } from '../../lib/icons'
import type { BotAskCard as BotAskData } from '../../../shared/bots/personal/chat'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'

/**
 * The one Needs you ask: something asks for a right, and the person answers Allow or Not now. Every ask renders
 * through it: a bot's ask (in its chat and in Needs you), a thread's permission request, a workflow step's approval
 * and an agent's first-creation ask. `card` is the ask in a conversation (the line, its note, Not now and Allow); `row`
 * is its Needs you row (the line, Allow as the one action, Not now in "…"). Once answered it is one line.
 */
export interface AskCardProps {
  /** "Pip wants to **read files in ~/Notes**": who asks and what it wants. */
  line: ReactNode
  /** The line as plain text, for the row's tooltip and labels. */
  lineText: string
  note?: string
  /** An answered ask shows `answered` as its one line. */
  answered?: { text: string; allowed: boolean }
  layout?: 'card' | 'row'
  onAnswer(answer: 'allow' | 'not_now'): Promise<void> | void
  /** The row: its automation's name, key and what else "…" offers (Open thread). */
  row?: { name: string; key: string; kind: string; menu?: RowMenuItem[]; onOpen?: () => void }
  /** The card's group label ("Pip asks"). */
  label?: string
}

export function AskCard({ line, lineText, note, answered, layout = 'card', onAnswer, row, label }: AskCardProps) {
  const [busy, setBusy] = useState(false)
  const answer = async (choice: 'allow' | 'not_now') => {
    setBusy(true)
    try { await onAnswer(choice) } finally { setBusy(false) }
  }
  if (answered) {
    return <div className="ask-card-answer" role="status">{answered.allowed && <CircleCheck size={13} aria-hidden />}{answered.text}</div>
  }
  if (layout === 'row' && row) {
    return <div className="automation-row" data-testid="automation-row" data-key={row.key} data-kind={row.kind} data-ask="" role="option" aria-selected={false}>
      <span className="automation-glyph needs" data-glyph="needs" title="Needs you" role="img" aria-label="Needs you">⚠</span>
      <button type="button" className="automation-row-main" data-row-button="" title={note || undefined} onClick={row.onOpen}>
        <span className="automation-row-name">{row.name}</span>
        <span className="automation-row-meta"><span className="automation-row-seg tone-warn" data-meta="attention">{line}</span></span>
      </button>
      <button type="button" className="settings-btn automation-primary primary" data-primary="allow" data-testid="automation-ask-allow" title={lineText} disabled={busy} onClick={() => void answer('allow')} aria-label={`Allow: ${row.name}`}>Allow</button>
      <RowMenu label={`More actions for ${row.name}`} items={[{ label: 'Not now', testId: 'automation-ask-not-now', onSelect: () => void answer('not_now') }, ...(row.menu ?? [])]} />
    </div>
  }
  return <div className="ask-card" role="group" aria-label={label ?? lineText}>
    <div className="ask-card-title"><Shield size={16} aria-hidden /><span>{line}</span></div>
    {note && <p className="ask-card-note">{note}</p>}
    <div className="ask-card-actions">
      <button type="button" className="bot-ghost-button" disabled={busy} onClick={() => void answer('not_now')}>Not now</button>
      <button type="button" className="chat-primary-button" disabled={busy} onClick={() => void answer('allow')}>Allow</button>
    </div>
  </div>
}

/** The one line a bot's answered ask becomes. */
export function askAnswerLine(ask: BotAskData, fromRun = false): string {
  if (ask.status === 'allowed') {
    if (ask.kind === 'export_memory') return 'Saved its memory to the folder you picked'
    return fromRun ? `Allowed: ${ask.title}. It uses it from the next run.` : `Allowed: ${ask.title}`
  }
  if (ask.status === 'not_now') return `Not now: ${ask.title}`
  return `No longer needed: ${ask.title}`
}

/** A bot's ask in its chat: "<name> wants to <title>"; an `export_memory` ask's Allow picks a folder first. */
export function BotAsk({ botName, ask, fromRun = false, onAnswer, onExport }: {
  botName: string
  ask: BotAskData
  /** A run's ask (a notice row): Allow applies from the next run. */
  fromRun?: boolean
  onAnswer(answer: 'allow' | 'not_now'): Promise<void> | void
  /** `export_memory`: Allow picks a folder and saves the memory there, then closes the card. */
  onExport?(): Promise<void> | void
}) {
  return <AskCard
    line={<>{botName} wants to <strong>{ask.title}</strong></>}
    lineText={`${botName} wants to ${ask.title}`}
    label={`${botName} asks`}
    {...(ask.note ? { note: ask.note } : {})}
    {...(ask.status !== 'open' ? { answered: { text: askAnswerLine(ask, fromRun), allowed: ask.status === 'allowed' } } : {})}
    onAnswer={(answer) => (answer === 'allow' && ask.kind === 'export_memory' && onExport ? onExport() : onAnswer(answer))}
  />
}
