import { useEffect, useState } from 'react'
import { ChevronRight, Clock, Pause, Play } from '../../lib/icons'
import type { BotAutomationCard } from '../../../shared/bots/personal/cards'
import { useBotsStore, watchBotDetail } from '../../stores/botsStore'
import { openAutomationRuns } from '../automations/inbox/inboxStore'
import '../../chat/components/agent-elements/tools/subagent-card.css'
import '../subagentAvatar.css'
import './botStartedCards.css'

/**
 * What a bot started that keeps going on its own, as a card on the message of the turn that started it, in the same
 * row as a thread's subagent card: an automation it created (on at once, no step for the owner). The row opens it in
 * Automations; Pause (Resume once paused) acts on it there. Its state is read from the bot's runs, kept fresh while the
 * card is on screen.
 */
export function BotAutomationRow({ botId, card }: { botId: string; card: BotAutomationCard }) {
  useEffect(() => watchBotDetail(botId), [botId])
  const runs = useBotsStore((s) => s.details[botId]?.runs)
  const run = runs?.find((entry) => entry.jobId === card.jobId)
  const gone = runs !== undefined && !run
  const paused = run?.paused === true
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const toggle = () => {
    if (busy) return
    setBusy(true)
    setFailed(null)
    const scheduled = window.mousse.scheduled
    void (paused ? scheduled.resume(card.jobId) : scheduled.pause(card.jobId))
      .then(() => useBotsStore.getState().loadDetail(botId))
      .catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }
  const note = gone ? 'Removed' : paused ? 'Paused' : null
  const line = run?.label ?? card.label
  return (
    <div className="bot-started-card" data-testid="bot-automation-card" data-state={gone ? 'removed' : paused ? 'paused' : 'on'}>
      <button
        type="button"
        className="subagent-card"
        disabled={gone}
        title={gone ? `${card.name} was removed` : `Open ${card.name} in Automations`}
        aria-label={gone ? `${card.name}, removed` : `Open automation ${card.name}`}
        onClick={() => openAutomationRuns(card.jobId)}
      >
        <span className="subagent-avatar is-chip" aria-hidden="true"><Clock size={14} /></span>
        <span className="subagent-card-body">
          <span className="subagent-card-head">
            <span className="subagent-card-title">{card.name}</span>
            <span className="subagent-card-model">Automation</span>
          </span>
          <span className="subagent-card-line" title={failed ?? line}>
            {note && <span className="subagent-card-note" data-tone="attention">{note}</span>}
            {note && <span className="subagent-card-sep" aria-hidden="true"> · </span>}
            <span className="subagent-card-result">{failed ?? line}</span>
          </span>
        </span>
        {!gone && <ChevronRight className="subagent-card-chevron" aria-hidden="true" />}
      </button>
      {!gone && (
        <button type="button" className="bot-started-action" disabled={busy || runs === undefined} title={paused ? 'Resume its runs' : 'Pause its runs'} aria-label={`${paused ? 'Resume' : 'Pause'} ${card.name}`} onClick={toggle}>
          {paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
          <span>{paused ? 'Resume' : 'Pause'}</span>
        </button>
      )}
    </div>
  )
}
