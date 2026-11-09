// Small pieces the inbox shares: a run's icon (its state, else its trigger), the PR chip with its checks, the bot chip,
// and how each report level looks.
import { useEffect, useState, type ReactNode } from 'react'
import type { AutomationItem } from '../../../../shared/automations'
import type { InboxRun, RunLevel } from '../../../../shared/automationInbox'
import {
  Bot, Check, CircleAlert, CircleCheck, CircleDotDashed, CircleX, Clock, Eye, GitMerge, GitPullRequest, Info,
  Loader2, MessageQuestion, Monitor, Pause, Play, Webhook, X
} from '../../../lib/icons'

export function TriggerIcon({ trigger, size = 14 }: { trigger: AutomationItem['trigger'] | undefined; size?: number }) {
  const Icon = trigger === 'thread_event' ? GitPullRequest : trigger === 'request' ? Webhook : trigger === 'on_demand' ? Play : Clock
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />
}

/** A run's leading icon: its state while it is not simply done, else its automation's trigger. */
export function RunIcon({ run, automation, resolved }: { run: InboxRun; automation?: AutomationItem; resolved?: boolean }) {
  const [icon, title, tone]: [ReactNode, string, string] =
    resolved ? [<CircleCheck key="i" size={15} strokeWidth={1.8} />, 'Resolved', 'done']
      : run.state === 'running' ? [<Loader2 key="i" size={15} strokeWidth={1.8} className="inbox-spin" />, 'Running', 'running']
        : run.state === 'queued' ? [<Clock key="i" size={15} strokeWidth={1.8} />, 'Waiting to start', 'waiting']
          : run.state === 'waiting_computer' ? [<Monitor key="i" size={15} strokeWidth={1.8} />, 'Waiting for its computer', 'waiting']
            : run.state === 'paused_usage' ? [<Pause key="i" size={15} strokeWidth={1.8} />, 'Paused for usage', 'paused']
              : run.state === 'failed' ? [<CircleX key="i" size={15} strokeWidth={1.8} />, 'Failed', 'failed']
                : !run.level ? [<MessageQuestion key="i" size={15} strokeWidth={1.8} />, 'No report', 'none']
                  : [<TriggerIcon key="i" trigger={automation?.trigger} size={15} />, LEVEL_VIEW[run.level].label, run.level === 'quiet' ? 'quiet' : 'trigger']
  return <span className="inbox-run-icon" data-tone={tone} title={title} role="img" aria-label={title}>{icon}</span>
}

export type PrChecks = 'pass' | 'fail' | 'pending' | 'merged' | 'closed' | 'unknown'

const CHECKS: Record<PrChecks, { title: string; icon: ReactNode }> = {
  pass: { title: 'checks pass', icon: <Check size={11} strokeWidth={2.4} /> },
  fail: { title: 'checks fail', icon: <X size={11} strokeWidth={2.4} /> },
  pending: { title: 'checks running', icon: <CircleDotDashed size={11} strokeWidth={2} /> },
  merged: { title: 'merged', icon: <GitMerge size={11} strokeWidth={2} /> },
  closed: { title: 'closed', icon: <X size={11} strokeWidth={2} /> },
  unknown: { title: 'checks not read', icon: null }
}

/** What a pull request's checks and state are, read once per window session and kept a short while. */
const prCache = new Map<string, { at: number; checks: PrChecks; headSha?: string }>()
const PR_FRESH_MS = 120_000

export function usePrChecks(threadId: string | undefined, number: number | undefined): PrChecks {
  const key = threadId && number ? `${threadId}#${number}` : ''
  const [checks, setChecks] = useState<PrChecks>(() => (key ? prCache.get(key)?.checks ?? 'unknown' : 'unknown'))
  useEffect(() => {
    if (!key || !threadId || !number) return
    const cached = prCache.get(key)
    if (cached) setChecks(cached.checks)
    if (cached && Date.now() - cached.at < PR_FRESH_MS) return
    let live = true
    void window.mousse.pullRequests.detail({ threadId }, number).then((detail) => {
      const next: PrChecks = detail.state === 'merged' ? 'merged' : detail.state === 'closed' ? 'closed'
        : detail.checks === 'passing' ? 'pass' : detail.checks === 'failing' ? 'fail' : detail.checks === 'pending' ? 'pending' : 'unknown'
      prCache.set(key, { at: Date.now(), checks: next, headSha: detail.headSha })
      if (live) setChecks(next)
    }, () => {
      // Signed out, or no host: the chip shows the number alone.
    })
    return () => { live = false }
  }, [key, threadId, number])
  return checks
}

export function PrChip({ number, checks }: { number: number; checks: PrChecks }) {
  const view = CHECKS[checks]
  return (
    <span className="inbox-chip inbox-pr-chip" data-checks={checks} data-testid="inbox-pr-chip" title={`PR #${number} · ${view.title}`}>
      <GitPullRequest size={11} strokeWidth={2} aria-hidden="true" />
      {number}
      {view.icon ? <span className="inbox-pr-checks" aria-hidden="true">{view.icon}</span> : null}
    </span>
  )
}

/** A run's PR, read by its thread. */
export function RunPrChip({ run }: { run: InboxRun }) {
  const checks = usePrChecks(run.threadId, run.pr?.number)
  return run.pr ? <PrChip number={run.pr.number} checks={checks} /> : null
}

export function AssigneeChip({ name }: { name: string }) {
  return <span className="inbox-chip inbox-assignee-chip" title={`Assigned to ${name}`}><Bot size={11} strokeWidth={2} aria-hidden="true" />{name}</span>
}

export const LEVEL_VIEW: Record<RunLevel | 'none', { label: string; icon: ReactNode }> = {
  needs_you: { label: 'Needs you', icon: <CircleAlert size={13} strokeWidth={2} aria-hidden="true" /> },
  look: { label: 'Worth a look', icon: <Eye size={13} strokeWidth={2} aria-hidden="true" /> },
  fyi: { label: 'FYI', icon: <Info size={13} strokeWidth={2} aria-hidden="true" /> },
  quiet: { label: 'Quiet', icon: <Info size={13} strokeWidth={2} aria-hidden="true" /> },
  none: { label: 'No report', icon: <MessageQuestion size={13} strokeWidth={2} aria-hidden="true" /> }
}

/** The bot a run's items are assigned to, by its automation's Who. */
export function botNameOf(run: InboxRun, automation: AutomationItem | undefined): string | undefined {
  if (!run.botId) return undefined
  return automation?.who.kind === 'bot' ? automation.who.name : 'Bot'
}
