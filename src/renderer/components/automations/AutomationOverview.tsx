import { useState } from 'react'
import { ChevronLeft } from '../../lib/icons'
import type { AutomationItem, AutomationRun } from '../../../shared/automations'
import type { ScheduledJob } from '../../../shared/types'
import { RowMenu } from '../integrations/RowMenu'
import { DraftCard } from './DraftCard'
import { missedText, runText, type MetaContext } from './automationList'
import { ownedWhenText } from './automationTime'

const RUN_GLYPH: Record<AutomationRun['state'], string> = {
  done: '✓', nothing_new: '·', incomplete: '◐', failed: '✕', queued: '◌', running: '◌', waiting: '◷'
}
const RECENT_RUNS = 5

/**
 * An automation's detail: the card at the top, "Change it…" (the words go to the manager with its id), its runs, and
 * Edit details, which opens the full form. A draft's card has Turn on and Discard; an automation's head has Run now
 * and Pause.
 */
export function AutomationOverview({ item, job, who, ctx, onBack, onRunNow, onPause, onResume, onDelete, onTurnOn, onDiscard, onAnswer, onEditDetails, onChangeIt, onOpenThread, onOpenConversation }: {
  item: AutomationItem
  job: ScheduledJob
  who: string
  ctx: MetaContext
  onBack: () => void
  onRunNow: () => void
  onPause: () => void
  onResume: () => void
  onDelete: () => void
  onTurnOn: () => Promise<void>
  onDiscard: () => void
  onAnswer: (answer: string) => void
  onEditDetails: () => void
  onChangeIt: (text: string) => Promise<void>
  onOpenThread: (threadId: string) => void
  onOpenConversation?: () => void
}) {
  const [change, setChange] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [allRuns, setAllRuns] = useState(false)
  const draft = Boolean(item.draft)
  const runs = item.runs.slice(0, allRuns ? item.runs.length : RECENT_RUNS)
  const send = async () => {
    if (!change.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onChangeIt(change.trim())
      setChange('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="automation-detail"
      data-testid="automation-overview"
      data-job-id={job.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          onBack()
        }
      }}
    >
      <div className="automation-detail-head">
        <button type="button" className="automations-back" onClick={onBack} aria-label="Back to Automations" title="Back">
          <ChevronLeft size={15} />
        </button>
        <h2 className="automation-detail-name">{item.name}</h2>
        {draft ? null : (
          <div className="automation-detail-actions">
            {item.who.kind === 'bot' ? null : <button type="button" className="settings-btn" onClick={onRunNow} disabled={Boolean(item.active && item.active.state !== 'waiting')}>Run now</button>}
            {item.paused
              ? <button type="button" className="settings-btn" onClick={onResume} data-testid="automation-detail-resume">Resume</button>
              : <button type="button" className="settings-btn" onClick={onPause} title="Pause…" aria-label="Pause…" data-testid="automation-detail-pause">⏸</button>}
            <RowMenu label={`More actions for ${item.name}`} items={[{ label: 'Delete', danger: true, onSelect: onDelete }]} />
          </div>
        )}
      </div>

      <DraftCard
        item={item}
        job={job}
        who={who}
        ctx={ctx}
        onTurnOn={onTurnOn}
        onEditDetails={onEditDetails}
        onDiscard={onDiscard}
        onAnswer={onAnswer}
        {...(onOpenConversation ? { onOpenConversation } : {})}
      />

      {item.who.kind === 'bot' ? null : (
        <div className="automation-change">
          <input
            className="automation-change-input"
            data-testid="automation-change-it"
            aria-label="Change it"
            placeholder="Change it… (describe the change)"
            value={change}
            disabled={busy}
            onChange={(event) => setChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void send() } }}
          />
          <button type="button" className="settings-btn" disabled={busy || !change.trim()} onClick={() => void send()}>Send</button>
        </div>
      )}
      {error ? <p className="scheduled-action-error" role="alert">{error}</p> : null}

      <section className="automation-runs" aria-label={`Runs of ${item.name}`}>
        <h3 className="automation-runs-head">Runs</h3>
        {runs.length === 0 ? <p className="scheduled-note">{draft ? 'Nothing runs until you turn it on.' : 'No runs yet.'}</p> : (
          <ul>
            {runs.map((run, index) => (
              <li key={`${run.at}-${index}`} className="automation-run" data-state={run.state}>
                <span className={`automation-run-glyph ${run.state}`} aria-hidden="true">{RUN_GLYPH[run.state]}</span>
                <span className="automation-run-when">{ownedWhenText(run.at, ctx.now, item.computer, ctx.viewerZone)}</span>
                <span className="automation-run-text">{runText(run, ctx.now, item.computer, ctx.viewerZone).replace(/ · (just now|\d+ (min|h|d) ago)$/, '')}</span>
                {missedText(run) ? <span className="automation-run-missed" title={missedText(run)!.title}>{missedText(run)!.text}</span> : null}
                {run.threadId ? <button type="button" className="scheduled-link-btn" onClick={() => onOpenThread(run.threadId!)}>Open thread</button> : null}
              </li>
            ))}
          </ul>
        )}
        {item.runs.length > RECENT_RUNS ? (
          <button type="button" className="scheduled-link-btn" aria-expanded={allRuns} onClick={() => setAllRuns((all) => !all)}>{allRuns ? 'Fewer runs' : 'All runs'}</button>
        ) : null}
      </section>
    </div>
  )
}
