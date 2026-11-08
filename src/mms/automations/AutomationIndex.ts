import { hostname } from 'node:os'
import {
  attentionOf,
  isRunEnded,
  jobActiveRun,
  jobLastEndedRun,
  jobRecordRun,
  type AutomationIndex,
  type AutomationItem,
  type AutomationRun,
  type AutomationWho
} from '../../shared/automations'
import { narrowPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { isWorkflowPrompt } from '../../shared/jobPermissionEdit'
import { tellMeOf, type ScheduledJob, type Thread } from '../../shared/types'
import type { BotAutomationSchedule, BotAutomationRunStatus } from '../bots/chat/BotChatService'

/** How many runs of each automation the list carries (the job keeps at most 20). */
const RUNS_PER_ITEM = 10

/** What the index reads. Each source may be missing or fail on its own; the rest of the list still shows. */
export interface AutomationIndexSources {
  jobs(): ScheduledJob[]
  thread(id: string): Thread | undefined
  /** Every thread, to find the ones that watch their pull request. */
  threads(): Thread[]
  projectName(id: string): string | undefined
  /** The mode a job's run takes from its thread: the bound thread's, else the mode new threads start in. */
  threadMode(threadId: string | undefined): PermissionMode
  bots?(): BotAutomationSchedule[]
  watchStatus?(threadId: string): { state: 'watching' | 'paused' | 'ended' | 'off'; nextCheckAt: string | null }
  computerName?: string
  timeZone?: string
  now?: () => Date
}

/** The computer's IANA time zone, as the scheduler's clock reads cron. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** One line of a prompt, cut, for a name. */
function lineOf(text: string, max = 70): string {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** The effective May of a job: the strictest of its mode, its ceiling and the mode its thread runs in. Workflows take none. */
export function jobEffectiveMay(job: ScheduledJob, threadMode: PermissionMode): PermissionMode | undefined {
  if (isWorkflowPrompt(job.prompt)) return undefined
  return narrowPermissionMode(job.permissionMode, job.permissionCeiling, threadMode)
}

function jobItem(job: ScheduledJob, sources: AutomationIndexSources, computer: AutomationItem['computer'], now: Date): AutomationItem {
  const workflow = isWorkflowPrompt(job.prompt)
  const who: AutomationWho = workflow
    ? { kind: 'workflow', name: job.prompt.trim().split(/\s+/)[0] ?? '/' }
    : { kind: 'agent', name: job.selection?.model ?? 'Default agent' }
  const trigger = job.trigger?.webhook && job.schedule.kind === 'manual' ? 'request' : job.schedule.kind === 'manual' ? 'on_demand' : 'time'
  const paused = job.state === 'paused' || (!job.enabled && job.state !== 'running')
  const active = jobActiveRun(job, now)
  const last = jobLastEndedRun(job)
  const runs = [...(job.runHistory ?? [])].reverse().slice(0, RUNS_PER_ITEM).map(jobRecordRun)
  // A run waiting for the person's answer on its thread is an open ask.
  const ask = job.liveStatus === 'needs_answer' ? { text: 'Waiting for your answer', ...(job.liveThreadId ? { threadId: job.liveThreadId } : {}) } : undefined
  const creator = job.createdBy ? sources.thread(job.createdBy.threadId) : undefined
  const projectName = job.projectId ? sources.projectName(job.projectId) : undefined
  const may = jobEffectiveMay(job, sources.threadMode(job.threadId))
  const attention = attentionOf({ ...(ask ? { ask } : {}), ...(last ? { last } : {}) })
  return {
    key: `job:${job.id}`,
    kind: 'job',
    id: job.id,
    name: job.name,
    trigger,
    schedule: job.schedule,
    whenText: '',
    who,
    ...(job.projectId ? { where: { projectId: job.projectId, name: projectName ?? 'Removed project' } } : {}),
    paused,
    ...(paused && job.resumeAt ? { pausedUntil: job.resumeAt } : {}),
    ...(paused && job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    ...(job.nextRunAt && !paused && job.state !== 'completed' ? { next: { at: job.nextRunAt, timeZone: computer.timeZone } } : {}),
    ...(active ? { active } : {}),
    ...(last ? { last } : {}),
    runs,
    ...(may ? { may } : {}),
    tellMe: tellMeOf(job),
    ...(job.createdBy ? { addedBy: { threadId: job.createdBy.threadId, ...(creator?.name ? { threadName: creator.name } : {}) } } : {}),
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    ...(attention ? { attention } : {}),
    link: { kind: 'job', jobId: job.id },
    computer
  }
}

/** A bot activation in the Run contract. */
export function botRun(run: BotAutomationSchedule['runs'][number]): AutomationRun {
  const base = { at: run.at, ...(run.threadId ? { threadId: run.threadId } : {}) }
  const state: Record<BotAutomationRunStatus, AutomationRun> = {
    queued: { ...base, state: 'queued' },
    running: { ...base, state: 'running' },
    // A run that stopped at a permission it lacks: the ask that stopped it is the same Needs you item.
    waiting_grant: { ...base, state: 'incomplete', detail: 'Waiting for your answer' },
    blocked: { ...base, state: 'incomplete', detail: 'Stopped at a missing permission' },
    paused: { ...base, state: 'waiting', reason: 'usage_limit' },
    done: { ...base, state: 'done' },
    failed: { ...base, state: 'failed', detail: run.endReason ? reasonText(run.endReason) : 'Failed' },
    cancelled: { ...base, state: 'failed', detail: run.endReason === 'stopped' ? 'Stopped' : run.endReason ? reasonText(run.endReason) : 'Cancelled' }
  }
  return state[run.status]
}

function reasonText(reason: string): string {
  const text = reason.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function botItem(schedule: BotAutomationSchedule, computer: AutomationItem['computer']): AutomationItem {
  const runs = schedule.runs.map(botRun)
  const active = runs[0] && !isRunEnded(runs[0].state) ? runs[0] : undefined
  const last = runs.find((run) => isRunEnded(run.state))
  const attention = attentionOf({ ...(schedule.ask ? { ask: { text: `Wants to ${schedule.ask.text}` } } : {}), ...(last ? { last } : {}) })
  return {
    key: `bot:${schedule.botId}:${schedule.scheduleId}`,
    kind: 'bot',
    id: `${schedule.botId}:${schedule.scheduleId}`,
    name: lineOf(schedule.prompt) || schedule.label,
    trigger: 'time',
    whenText: schedule.label,
    who: { kind: 'bot', name: schedule.botName, look: schedule.look },
    paused: schedule.paused,
    ...(schedule.pausedText ? { pausedReason: schedule.pausedText } : {}),
    ...(schedule.nextAt && !schedule.paused ? { next: { at: schedule.nextAt, timeZone: computer.timeZone } } : {}),
    ...(active ? { active } : {}),
    ...(last ? { last } : {}),
    runs,
    mayIsGrant: true,
    ...(attention ? { attention } : {}),
    link: { kind: 'bot', botId: schedule.botId, scheduleId: schedule.scheduleId },
    computer
  }
}

function watchItem(thread: Thread, status: { state: string; nextCheckAt: string | null } | undefined, sources: AutomationIndexSources, computer: AutomationItem['computer']): AutomationItem {
  const pr = thread.pullRequest!
  const projectName = thread.projectId ? sources.projectName(thread.projectId) : undefined
  const paused = status?.state === 'paused'
  return {
    key: `watch:${thread.id}`,
    kind: 'watch',
    id: thread.id,
    name: thread.name || `#${pr.number}`,
    trigger: 'thread_event',
    whenText: `PR #${pr.number}`,
    who: { kind: 'none', name: 'Notify' },
    ...(thread.projectId ? { where: { projectId: thread.projectId, name: projectName ?? 'Removed project' } } : {}),
    paused: false,
    // A watch waits out a rate limit or a sign-out on its own; it is never a pause the person made.
    ...(paused && status?.nextCheckAt ? { active: { at: status.nextCheckAt, state: 'waiting' as const, until: status.nextCheckAt, detail: 'Waiting to read the pull request again' } } : {}),
    ...(status?.nextCheckAt && !paused ? { next: { at: status.nextCheckAt, timeZone: computer.timeZone } } : {}),
    runs: [],
    notifyOnly: true,
    link: { kind: 'thread', threadId: thread.id },
    computer
  }
}

/**
 * The read-only automation index (Path step 1): scheduled jobs, personal bots' schedules and pull request watches,
 * each in the Run contract, with Needs you worked out the same way for all. Sources that cannot be read are named in
 * `unavailable` instead of showing as empty.
 */
export function buildAutomationIndex(sources: AutomationIndexSources): AutomationIndex {
  const now = sources.now?.() ?? new Date()
  const timeZone = sources.timeZone ?? localTimeZone()
  const computerName = sources.computerName ?? hostname()
  const computer = { name: computerName, timeZone, local: true }
  const items: AutomationItem[] = sources.jobs().map((job) => jobItem(job, sources, computer, now))
  const unavailable: AutomationIndex['unavailable'] = []
  if (sources.bots) {
    try {
      for (const schedule of sources.bots()) items.push(botItem(schedule, computer))
    } catch {
      unavailable.push('bots')
    }
  }
  if (sources.watchStatus) {
    try {
      for (const thread of sources.threads()) {
        if (thread.pullRequest?.watch !== 'notify' || thread.settledAt || thread.botOwned) continue
        let status: ReturnType<NonNullable<AutomationIndexSources['watchStatus']>> | undefined
        try {
          status = sources.watchStatus(thread.id)
        } catch {
          status = undefined
        }
        if (status && (status.state === 'off' || status.state === 'ended')) continue
        items.push(watchItem(thread, status, sources, computer))
      }
    } catch {
      unavailable.push('watches')
    }
  }
  return { items, computer: { name: computerName, timeZone }, unavailable, generatedAt: now.toISOString() }
}
