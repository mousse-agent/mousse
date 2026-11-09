import { hostname } from 'node:os'
import {
  attentionOf,
  isRunEnded,
  jobActiveRun,
  jobLastEndedRun,
  jobRecordRun,
  type AutomationDelivery,
  type AutomationIndex,
  type AutomationItem,
  type AutomationRun,
  type AutomationWho,
  type AttentionAnswer
} from '../../shared/automations'
import { narrowPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { isWorkflowPrompt } from '../../shared/jobPermissionEdit'
import { tellMeOf, type ScheduledJob, type ScheduledJobRunRecord, type ScheduledWebhookDelivery, type Thread } from '../../shared/types'
import { deliveryStartedRun, takesRequests } from '../../shared/requestTrigger'
import { threadEventsOfOccurrence, threadEventText } from '../../shared/threadEvents'
import type { BotAutomationFacts, BotAutomationRunStatus } from '../bots/chat/BotChatService'
import type { AgentJobAsk } from './AgentJobAsks'
import { describeSchedule } from '../../shared/scheduleLabel'
import type { RemoteAutomationsPart } from '../protocol/remoteAutomationsPort'
import { qualifyId } from '../../shared/threadRef'
import type { MovedAutomation } from './MovedAutomations'

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
  /** A bot beside one of its schedules (a job whose Who is the bot): its name, face, pause and runs; undefined when it is gone. */
  bot?(botId: string, scheduleId: string): BotAutomationFacts | undefined
  /** The permission request waiting on a thread, when it is one Allow can answer (`permissionRequestOptions`). */
  pendingApproval?(threadId: string): Extract<AttentionAnswer, { kind: 'thread_approval' }> | undefined
  /** A workflow run's open step approval, when it waits for one. */
  workflowApproval?(runId: string): Extract<AttentionAnswer, { kind: 'workflow_approval' }> | undefined
  /** Agents' open first-creation asks: each is a Needs you item until it is answered. */
  asks?(): AgentJobAsk[]
  /** A saved agent's name, for a job whose Who is one; undefined when it is gone. */
  savedAgentName?(definitionId: string): string | undefined
  watchStatus?(threadId: string): { state: 'watching' | 'paused' | 'ended' | 'off'; nextCheckAt: string | null }
  /** Automations that moved to another computer: their history stays here, read-only. */
  moved?(): MovedAutomation[]
  /** Where a job's signed requests are posted. */
  requestUrl?(jobId: string): string
  /** A job's delivery log, newest first. */
  deliveries?(jobId: string): ScheduledWebhookDelivery[]
  /** Whether a delivery's payload is still stored, so Resend can run it again. */
  payloadKept?(jobId: string, occurrenceId: string): boolean
  /** Whether a saved key is in the profile's secret store (its value is never read here). */
  keyStored?(name: string): boolean
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

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** The step approval a workflow job's last run waits for, from the run its delivery names ("Run: <id>"). */
function workflowAsk(job: ScheduledJob, sources: AutomationIndexSources): { text: string; threadId?: string; answer: AttentionAnswer } | undefined {
  const record = [...(job.runHistory ?? [])].reverse().find((entry) => entry.output)
  const runId = record?.output ? /^Run: ([0-9a-f-]{36})$/m.exec(record.output)?.[1] : undefined
  const answer = runId ? safely(() => sources.workflowApproval?.(runId)) : undefined
  return answer ? { text: 'A workflow step wants your approval', ...(record?.threadId ? { threadId: record.threadId } : {}), answer } : undefined
}

function savedAgentName(definitionId: string, sources: AutomationIndexSources): string {
  try {
    return sources.savedAgentName?.(definitionId) ?? 'Removed agent'
  } catch {
    return 'Removed agent'
  }
}

/** One line of a prompt, cut, for a name. */
function lineOf(text: string, max = 70): string {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** The effective May of a job: the strictest of its mode, its ceiling and the mode its thread runs in (a workflow's too, #338). */
export function jobEffectiveMay(job: ScheduledJob, threadMode: PermissionMode): PermissionMode {
  return narrowPermissionMode(job.permissionMode, job.permissionCeiling, threadMode)
}

/**
 * A job whose Who is a bot: the same record and row as any job, with the bot's face, its own pause, and the runs its
 * run lane made (the bot's activations). Its May is the bot's grant. Undefined for a bot that is gone or deleted.
 */
function botJobItem(job: ScheduledJob & { bot: NonNullable<ScheduledJob['bot']> }, facts: BotAutomationFacts, computer: AutomationItem['computer']): AutomationItem {
  const runs = facts.runs.map(botRun)
  const active = runs[0] && !isRunEnded(runs[0].state) ? runs[0] : undefined
  const last = runs.find((run) => isRunEnded(run.state))
  const jobPaused = job.state === 'paused' || (!job.enabled && job.state !== 'running')
  const paused = jobPaused || facts.paused
  const attention = attentionOf({
    ...(facts.ask ? { ask: { text: `Wants to ${facts.ask.text}`, ...(facts.ask.askId ? { answer: { kind: 'bot_ask' as const, botId: job.bot.botId, askId: facts.ask.askId } } : {}) } } : {}),
    ...(last ? { last } : {})
  })
  return {
    key: `job:${job.id}`,
    kind: 'job',
    id: job.id,
    name: job.name,
    trigger: 'time',
    schedule: job.schedule,
    whenText: '',
    who: { kind: 'bot', name: facts.botName, look: facts.look },
    paused,
    ...(jobPaused && job.resumeAt ? { pausedUntil: job.resumeAt } : {}),
    ...(jobPaused && job.pausedReason ? { pausedReason: job.pausedReason } : !jobPaused && facts.pausedText ? { pausedReason: facts.pausedText } : {}),
    // The bot's own pause (not this row's) is resumed from the bot.
    ...(!jobPaused && facts.paused ? { pausedBy: 'bot' as const } : {}),
    ...(job.nextRunAt && !paused && job.state !== 'error' ? { next: { at: job.nextRunAt, timeZone: computer.timeZone } } : {}),
    ...(active ? { active } : {}),
    ...(last ? { last } : {}),
    runs,
    mayIsGrant: true,
    tellMe: tellMeOf(job),
    ...(attention ? { attention } : {}),
    link: { kind: 'job', jobId: job.id, botId: job.bot.botId },
    computer
  }
}

/** How many requests of an automation's delivery log the list carries. */
const DELIVERIES_PER_ITEM = 20

/** The delivery a run record names (`webhook:<id>`), or undefined for a timed or manual run. */
function requestOf(record: ScheduledJobRunRecord): string | undefined {
  return record.occurrenceKey?.startsWith('webhook:') ? record.occurrenceKey.slice('webhook:'.length) : undefined
}

/**
 * A job that takes requests: where senders post, and its newest requests with what became of each. A delivery that
 * started a run and whose payload is still stored can be resent.
 */
function requestPart(job: ScheduledJob, sources: AutomationIndexSources): AutomationItem['request'] | undefined {
  if (!job.trigger?.webhook || !sources.requestUrl) return undefined
  const canResend = takesRequests(job)
  const kept = (occurrenceId: string) => canResend && (safely(() => sources.payloadKept?.(job.id, occurrenceId)) ?? false)
  const deliveries = (safely(() => sources.deliveries?.(job.id)) ?? []).slice(0, DELIVERIES_PER_ITEM).map((row): AutomationDelivery => ({
    at: row.receivedAt,
    outcome: row.outcome,
    bytes: row.bodyBytes,
    ...(row.error ? { detail: row.error } : {}),
    ...(row.missingPlaceholders?.length ? { missing: row.missingPlaceholders } : {}),
    ...(row.occurrenceId ? { occurrenceId: row.occurrenceId } : {}),
    ...(row.occurrenceId && deliveryStartedRun(row.outcome) && kept(row.occurrenceId) ? { resendable: true as const } : {}),
    ...(row.resentFrom ? { resent: true as const } : {})
  }))
  return { url: sources.requestUrl(job.id), deliveries }
}

/** A thread-event job's pull request: the thread it is linked to, whether its watch reads it, what waits, and the log. */
function threadEventPart(job: ScheduledJob, wakesOn: NonNullable<NonNullable<ScheduledJob['trigger']>['threadEvent']>, sources: AutomationIndexSources): NonNullable<AutomationItem['threadEvent']> {
  const thread = safely(() => sources.thread(wakesOn.threadId))
  const watch = safely(() => sources.watchStatus?.(wakesOn.threadId))
  return {
    threadId: wakesOn.threadId,
    ...(thread?.name ? { threadName: thread.name } : {}),
    number: wakesOn.number,
    events: wakesOn.events,
    watching: watch ? watch.state === 'watching' || watch.state === 'paused' : false,
    ...(job.pendingEvent ? { heldUntil: job.pendingEvent.dueAt } : {}),
    log: [...(job.eventLog ?? [])].reverse()
  }
}

function jobItem(job: ScheduledJob, sources: AutomationIndexSources, computer: AutomationItem['computer'], now: Date): AutomationItem {
  const workflow = isWorkflowPrompt(job.prompt)
  const who: AutomationWho = workflow
    ? { kind: 'workflow', name: job.prompt.trim().split(/\s+/)[0] ?? '/' }
    : job.agent
      ? { kind: 'saved_agent', name: savedAgentName(job.agent.definitionId, sources), definitionId: job.agent.definitionId }
      : { kind: 'agent', name: job.selection?.model ?? 'Default agent' }
  const wakesOn = job.trigger?.threadEvent
  const trigger = wakesOn ? 'thread_event' : job.trigger?.webhook && job.schedule.kind === 'manual' ? 'request' : job.schedule.kind === 'manual' ? 'on_demand' : 'time'
  // A draft is not paused: it has never been on.
  const paused = !job.draft && (job.state === 'paused' || (!job.enabled && job.state !== 'running'))
  const active = jobActiveRun(job, now)
  const last = jobLastEndedRun(job)
  const request = requestPart(job, sources)
  const resendable = new Set(request?.deliveries.flatMap((row) => (row.resendable && row.occurrenceId ? [row.occurrenceId] : [])) ?? [])
  const runs = [...(job.runHistory ?? [])].reverse().slice(0, RUNS_PER_ITEM).map((record) => {
    const run = jobRecordRun(record)
    const occurrenceId = requestOf(record)
    const events = threadEventsOfOccurrence(record.occurrenceKey)
    if (events?.length) return { ...run, events }
    return occurrenceId ? { ...run, request: { occurrenceId, ...(resendable.has(occurrenceId) ? { resendable: true as const } : {}) } } : run
  })
  // A run waiting for the person's answer on its thread is an open ask; a permission request on it is answered in place.
  const approval = job.liveStatus === 'needs_answer' && job.liveThreadId ? safely(() => sources.pendingApproval?.(job.liveThreadId!)) : undefined
  const ask = job.liveStatus === 'needs_answer'
    ? { text: approval ? 'Wants your approval' : 'Waiting for your answer', ...(job.liveThreadId ? { threadId: job.liveThreadId } : {}), ...(approval ? { answer: approval } : {}) }
    : last?.state === 'incomplete' ? workflowAsk(job, sources) : undefined
  const creator = job.createdBy ? sources.thread(job.createdBy.threadId) : undefined
  const projectName = job.projectId ? sources.projectName(job.projectId) : undefined
  // A saved agent keeps to what it may use (its grants), not a permission mode.
  const may = job.agent && !workflow ? undefined : jobEffectiveMay(job, sources.threadMode(job.threadId))
  // A draft never runs, so it never needs the person: it waits in the Draft section for Turn on.
  const attention = job.draft ? undefined : attentionOf({ ...(ask ? { ask } : {}), ...(last ? { last } : {}) })
  const draft = job.draft
    ? {
        draftId: job.draft.draftId || job.id,
        ...(job.draft.managerThreadId ? { managerThreadId: job.draft.managerThreadId } : {}),
        ...(job.draft.botId ? { botId: job.draft.botId } : {}),
        problems: job.draft.problems,
        ...(job.draft.ask ? { ask: { question: job.draft.ask.question, options: job.draft.ask.options } } : {})
      }
    : undefined
  return {
    key: `job:${job.id}`,
    kind: 'job',
    id: job.id,
    name: job.name,
    trigger,
    schedule: job.schedule,
    whenText: wakesOn ? threadEventText(wakesOn.number, wakesOn.events) : '',
    who,
    ...(job.projectId ? { where: { projectId: job.projectId, name: projectName ?? 'Removed project' } } : {}),
    paused,
    ...(paused && job.resumeAt ? { pausedUntil: job.resumeAt } : {}),
    ...(paused && job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    ...(job.nextRunAt && !paused && !job.draft && job.state !== 'completed' ? { next: { at: job.nextRunAt, timeZone: computer.timeZone } } : {}),
    ...(active ? { active } : {}),
    ...(last ? { last } : {}),
    runs,
    ...(may ? { may } : {}),
    ...(job.agent && !workflow ? { mayIsGrant: true as const } : {}),
    tellMe: tellMeOf(job),
    ...(job.createdBy ? { addedBy: { threadId: job.createdBy.threadId, ...(creator?.name ? { threadName: creator.name } : {}) } } : {}),
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    ...(job.createdBy && job.expiresAt ? { keepable: true as const } : {}),
    ...(request ? { request } : {}),
    ...(job.keys?.length ? { keys: job.keys.map((name) => ({ name, stored: safely(() => sources.keyStored?.(name)) ?? false })) } : {}),
    ...(wakesOn ? { threadEvent: threadEventPart(job, wakesOn, sources) } : {}),
    ...(draft ? { draft } : {}),
    result: { thread: job.draft?.reuseThread || (job.threadId && !wakesOn) ? 'reuse' : 'new' },
    ...(job.cliName ? { cliName: job.cliName } : {}),
    ...(attention ? { attention } : {}),
    link: { kind: 'job', jobId: job.id },
    computer
  }
}

/**
 * The words of an agent's first-creation ask: "<thread> wants to <what> <when>", with what cut to one short line.
 */
export function askText(ask: Pick<AgentJobAsk, 'input'>, threadName: string | undefined, now: Date = new Date()): string {
  const what = lineOf(ask.input.prompt, 60)
  const lowered = what ? what.charAt(0).toLowerCase() + what.slice(1) : 'add an automation'
  return `${threadName ?? 'An agent'} wants to ${lowered} ${scheduleWords(ask.input.schedule, now)}`.trim()
}

function scheduleWords(schedule: AgentJobAsk['input']['schedule'], now: Date): string {
  if (schedule.kind === 'manual') return 'when you run it'
  const text = describeSchedule(schedule, now)
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function askItem(ask: AgentJobAsk, sources: AutomationIndexSources, computer: AutomationItem['computer']): AutomationItem {
  const thread = sources.thread(ask.threadId)
  const projectName = ask.input.projectId ? sources.projectName(ask.input.projectId) : undefined
  const trigger = ask.input.schedule.kind === 'manual' ? 'on_demand' : 'time'
  return {
    key: `ask:${ask.id}`,
    kind: 'ask',
    id: ask.id,
    name: ask.input.name,
    trigger,
    schedule: ask.input.schedule,
    whenText: '',
    who: { kind: 'agent', name: thread?.name ?? 'An agent' },
    ...(ask.input.projectId ? { where: { projectId: ask.input.projectId, name: projectName ?? 'Removed project' } } : {}),
    paused: false,
    runs: [],
    addedBy: { threadId: ask.threadId, ...(thread?.name ? { threadName: thread.name } : {}) },
    attention: { kind: 'ask', text: askText(ask, thread?.name, sources.now?.()), threadId: ask.threadId, answer: { kind: 'agent_ask', askId: ask.id } },
    link: { kind: 'ask', askId: ask.id, threadId: ask.threadId },
    computer
  }
}

/** A bot activation in the Run contract. */
export function botRun(run: BotAutomationFacts['runs'][number]): AutomationRun {
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

/** An automation that moved to another computer: no row of its own, only the runs it made here (Recent). */
function movedItem(entry: MovedAutomation, computer: AutomationItem['computer']): AutomationItem {
  return {
    key: `moved:${entry.id}`,
    kind: 'moved',
    id: entry.id,
    name: entry.name,
    trigger: entry.schedule.kind === 'manual' ? 'on_demand' : 'time',
    schedule: entry.schedule,
    whenText: `moved to ${entry.movedTo.name}`,
    who: { kind: 'none', name: '' },
    paused: false,
    runs: [...entry.runHistory].reverse().slice(0, RUNS_PER_ITEM).map(jobRecordRun),
    link: { kind: 'moved', node: entry.movedTo.node, jobId: qualifyId(entry.movedTo.node, entry.movedTo.jobId) },
    computer
  }
}

/**
 * The automation index: scheduled jobs (a bot's schedules among them, as jobs whose Who is the bot) and pull request
 * watches, each in the Run contract, with Needs you worked out the same way for all. Sources that cannot be read are
 * named in `unavailable` instead of showing as empty.
 */
export function buildAutomationIndex(sources: AutomationIndexSources): AutomationIndex {
  const now = sources.now?.() ?? new Date()
  const timeZone = sources.timeZone ?? localTimeZone()
  const computerName = sources.computerName ?? hostname()
  const computer = { name: computerName, timeZone, local: true }
  const items: AutomationItem[] = []
  const unavailable: AutomationIndex['unavailable'] = []
  for (const job of sources.jobs()) {
    if (!job.bot) {
      items.push(jobItem(job, sources, computer, now))
      continue
    }
    // A bot's schedule shows with its bot; a bot that is gone or deleted takes its rows out of the list.
    let facts: BotAutomationFacts | undefined
    try {
      facts = sources.bot?.(job.bot.botId, job.bot.scheduleId)
      if (!sources.bot) throw new Error('bots unavailable')
    } catch {
      if (!unavailable.includes('bots')) unavailable.push('bots')
      continue
    }
    if (facts) items.push(botJobItem(job as ScheduledJob & { bot: NonNullable<ScheduledJob['bot']> }, facts, computer))
  }
  try {
    for (const entry of sources.moved?.() ?? []) items.push(movedItem(entry, computer))
  } catch {
    // The record of moved automations could not be read: only their old runs are missing.
  }
  try {
    for (const ask of sources.asks?.() ?? []) items.push(askItem(ask, sources, computer))
  } catch {
    // The asks file could not be read: the jobs and the rest still show.
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

/**
 * This computer's list with the other computers' automations after it, the way their threads merge into the
 * sidebar: each row keeps its computer (with its zone), and an offline computer's rows are its last copy.
 */
export function mergeRemoteAutomations(local: AutomationIndex, parts: readonly RemoteAutomationsPart[]): AutomationIndex {
  if (!parts.length) return local
  return {
    ...local,
    items: [...local.items, ...parts.flatMap((part) => part.items)],
    computers: parts.map((part) => part.computer),
    remoteJobs: parts.flatMap((part) => part.jobs)
  }
}
