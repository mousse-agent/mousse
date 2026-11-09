// The strip above a run's thread while the Automations inbox shows it: the run's level (or Resolved), its bot, its
// pull request with Open PR and Merge (the PR panel and its own merge), its usage, calibration and Resolve.
import { useMemo } from 'react'
import type { AutomationItem } from '../../../../shared/automations'
import { openForPerson, resolvedRun, type InboxRun, type TuningNote } from '../../../../shared/automationInbox'
import { Bell, Check, ExternalLink, GitMerge, Undo2, VolumeHigh } from '../../../lib/icons'
import { useAppStore } from '../../../stores/appStore'
import { requestPanelMerge } from '../../pullRequestPanelRequests'
import { automationsById, usageText } from './inboxModel'
import { AssigneeChip, botNameOf, LEVEL_VIEW, PrChip, RunIcon, usePrChecks } from './RunParts'
import { calibrateRun, resolveRun, undoResolve, useInboxStore } from './inboxStore'

function openPullRequestPanel(): void {
  const app = useAppStore.getState()
  app.setMainView('pullRequest')
  app.setMainAreaOpen(true)
}

export function RunStrip() {
  const openRunId = useInboxStore((s) => s.openRunId)
  const inbox = useInboxStore((s) => s.inbox)
  const index = useInboxStore((s) => s.index)
  const run = inbox?.runs.find((entry) => entry.id === openRunId)
  const automations = useMemo(() => automationsById(index?.items), [index])
  if (!run) return null
  return <Strip run={run} automation={automations.get(run.jobId)} tuning={inbox?.tuning ?? []} undoRunId={inbox?.undo?.runId} />
}

function Strip({ run, automation, tuning, undoRunId }: { run: InboxRun; automation: AutomationItem | undefined; tuning: readonly TuningNote[]; undoRunId?: string }) {
  const checks = usePrChecks(run.threadId, run.pr?.number)
  const resolved = resolvedRun(run)
  const queue = openForPerson(run)
  const ended = run.state === 'done' || run.state === 'failed'
  const level = ended ? (run.level ? LEVEL_VIEW[run.level] : run.state === 'failed' ? undefined : LEVEL_VIEW.none) : undefined
  const noisy = tuning.some((note) => note.runId === run.id && note.kind === 'noisy')
  const missed = tuning.some((note) => note.runId === run.id && note.kind === 'missed')
  const bot = botNameOf(run, automation)
  const usage = usageText(run.usage)
  const name = automation?.name ?? run.jobName
  return (
    <div className="inbox-strip" data-testid="inbox-strip" data-run-id={run.id}>
      <span className="inbox-strip-name" title={name}>{name}</span>
      {!ended || run.state === 'failed' ? <span className="inbox-strip-state"><RunIcon run={run} automation={automation} /></span> : null}
      {resolved ? (
        <span className="inbox-level" data-level="resolved" title="Resolved"><Check size={13} strokeWidth={2} aria-hidden="true" /><span>Resolved</span></span>
      ) : level ? (
        <span className="inbox-level" data-level={run.level ?? 'none'} data-testid="inbox-strip-level" title={run.summary ?? level.label}>{level.icon}<span>{level.label}</span></span>
      ) : null}
      {bot ? <AssigneeChip name={bot} /> : null}
      {run.pr ? (
        <span className="inbox-strip-pr">
          <PrChip number={run.pr.number} checks={checks} />
          <button type="button" className="inbox-icon-btn small" data-testid="inbox-open-pr" title={`Open PR #${run.pr.number}`} aria-label={`Open PR #${run.pr.number}`} onClick={openPullRequestPanel}><ExternalLink size={13} strokeWidth={1.8} /></button>
          {checks !== 'merged' && checks !== 'closed' ? (
            <button
              type="button"
              className="inbox-icon-btn small"
              data-testid="inbox-merge-pr"
              title={checks === 'pass' ? `Merge #${run.pr.number}…` : `Merge #${run.pr.number} · checks must pass first`}
              aria-label={`Merge PR #${run.pr.number}`}
              disabled={checks !== 'pass'}
              onClick={() => {
                if (run.threadId && run.pr) requestPanelMerge(run.threadId, run.pr.number)
                openPullRequestPanel()
              }}
            ><GitMerge size={13} strokeWidth={1.8} /></button>
          ) : null}
        </span>
      ) : null}
      {usage ? <span className="inbox-strip-usage" data-testid="inbox-strip-usage" title="This run's tokens by model; the cost shows only when it is known (API keys)">{usage}</span> : null}
      <span className="inbox-strip-spacer" />
      {ended ? (
        <>
          <button type="button" className="inbox-icon-btn small" data-testid="inbox-too-noisy" aria-pressed={noisy} title={noisy ? 'Noted in Tuning · click to take back' : 'Too noisy'} aria-label="Too noisy" onClick={() => void calibrateRun(run.id, 'noisy')}><VolumeHigh size={14} strokeWidth={1.8} /></button>
          <button type="button" className="inbox-icon-btn small" data-testid="inbox-should-tell" aria-pressed={missed} title={missed ? 'Noted in Tuning · click to take back' : 'Should have told me'} aria-label="Should have told me" onClick={() => void calibrateRun(run.id, 'missed')}><Bell size={14} strokeWidth={1.8} /></button>
        </>
      ) : null}
      {queue ? (
        <button type="button" className="inbox-resolve-btn" data-testid="inbox-resolve" title="Resolve · e" aria-label="Resolve" onClick={() => void resolveRun(run.id)}><Check size={14} strokeWidth={2} /></button>
      ) : resolved && undoRunId === run.id ? (
        <button type="button" className="inbox-icon-btn small" data-testid="inbox-undo-resolve" title="Undo resolve · u" aria-label="Undo resolve" onClick={() => void undoResolve()}><Undo2 size={14} strokeWidth={1.8} /></button>
      ) : null}
    </div>
  )
}
