import { useState } from 'react'
import type { BotAskCard } from '../../../shared/bots/personal/chat'

/**
 * An open ask as a messenger's quick replies under the bot's bubble: Allow, Not now, and Details when there is more to
 * read (the note, what Allow gives, the tools it names). Once answered, the chat shows a quiet line instead
 * (botChatShape.ts, `askAnsweredLine`).
 */
export function BotAskReplies({ ask, onAnswer, onExport }: {
  ask: BotAskCard
  /**
   * Answers; a refusal of Allow comes back as why ("Allow this on the computer.": "Use your threads" is allowed only on
   * the bot's computer or from a device with Full access), and Allow then stays off with that reason.
   */
  onAnswer(answer: 'allow' | 'not_now'): Promise<string | undefined | void> | void
  /** `export_memory`: Allow picks a folder and saves the memory there. */
  onExport?(): Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  const [refused, setRefused] = useState<string | undefined>()
  const answer = async (choice: 'allow' | 'not_now') => {
    setBusy(true)
    try {
      const why = await (choice === 'allow' && ask.kind === 'export_memory' && onExport ? onExport() : onAnswer(choice))
      if (choice === 'allow' && typeof why === 'string') setRefused(why)
    } finally {
      setBusy(false)
    }
  }
  const allowOff = ask.loading ? 'Its tools are still loading' : refused
  const more = Boolean(ask.note || ask.tip || ask.details?.items.length)
  return <div className="bot-ask-replies">
    <div className="bot-ask-buttons" role="group" aria-label={`Answer: ${ask.title}`}>
      <button type="button" className="is-primary" disabled={busy || allowOff !== undefined} title={allowOff} onClick={() => void answer('allow')}>Allow</button>
      <button type="button" disabled={busy} onClick={() => void answer('not_now')}>Not now</button>
      {more && <button type="button" aria-expanded={details} onClick={() => setDetails((open) => !open)}>Details</button>}
    </div>
    {details && <div className="bot-ask-details">
      {ask.note && <p title={ask.tip}>{ask.note}</p>}
      {!ask.note && ask.tip && <p>{ask.tip}</p>}
      {ask.details && ask.details.items.length > 0 && <p>{ask.details.summary}: {ask.details.items.join(', ')}</p>}
      {ask.details?.more && <p>{ask.details.more}</p>}
    </div>}
  </div>
}
