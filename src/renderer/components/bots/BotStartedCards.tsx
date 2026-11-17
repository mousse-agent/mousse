import { useEffect, useState } from 'react'
import { ChevronRight, Clock, Pause, Play, TerminalSquare, X } from '../../lib/icons'
import type { BotAutomationCard, BotWatcherCard } from '../../../shared/bots/personal/cards'
import { useBotsStore, watchBotDetail } from '../../stores/botsStore'
import { openAutomationRuns } from '../automations/inbox/inboxStore'
import '../../chat/components/agent-elements/tools/subagent-card.css'
import '../subagentAvatar.css'
import './botStartedCards.css'

/** "4m", "1h 12m": how long a background command has run. */
export function runningFor(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * A background command the bot started (`watch_start`), in the same row: its title, and while it runs how long it has
 * run, with Stop (the command line on hover); once it ended, "Ended" (the bot was woken with what happened).
 */
export function BotWatcherRow({ botId, card }: { botId: string; card: BotWatcherCard }) {
  const running = useBotsStore((s) => s.bots.find((bot) => bot.id === botId)?.watchers?.find((watcher) => watcher.id === card.watcherId))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [running])
  const [busy, setBusy] = useState(false)
  const stop = () => {
    if (busy) return
    setBusy(true)
    void useBotsStore.getState().stopWork(botId, card.watcherId).finally(() => setBusy(false))
  }
  return (
    <div className="bot-started-card" data-testid="bot-watcher-card" data-state={running ? 'running' : 'ended'}>
      <div className="subagent-card bot-started-static" title={card.command}>
        <span className="subagent-avatar is-chip" aria-hidden="true"><TerminalSquare size={14} /></span>
        <span className="subagent-card-body">
          <span className="subagent-card-head">
            <span className="subagent-card-title">{card.title}</span>
            <span className="subagent-card-model">Background</span>
          </span>
          <span className="subagent-card-line">
            <span className="subagent-card-result">{running ? `Running · ${runningFor(running.startedAt, now)}` : 'Ended'}</span>
          </span>
        </span>
      </div>
      {running && (
        <button type="button" className="bot-started-action" disabled={busy} title="Stop it; the bot is not woken for it" aria-label={`Stop ${card.title}`} onClick={stop}>
          <X size={13} aria-hidden />
          <span>Stop</span>
        </button>
      )}
    </div>
  )
}

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
            {/* A flex item drops its own outer spaces: the dot keeps them as no-break spaces. */}
            {note && <span className="subagent-card-sep" aria-hidden="true">{'\u00a0·\u00a0'}</span>}
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
