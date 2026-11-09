import type { BotLook } from './bots/personal/look'
import { missingKeyText } from './automationKeys'
import type { PermissionMode } from './permissionMode'
import type { JobSchedule, ScheduledEventLogEntry, ScheduledJob, ScheduledJobRunRecord, ScheduledOccurrenceResult, ScheduledWebhookDeliveryOutcome, TellMe, ThreadEventKind } from './types'

/**
 * Automations: everything that runs on its own, in one list (the Automations page). Phase 1 reads three sources
 * without merging them: scheduled jobs, personal bots' schedules and threads that watch their pull request.
 */

export const AUTOMATIONS_METHODS = ['automations.list', 'automations.asks.answer', 'automations.keep', 'automations.move', 'automations.request.resend', 'automations.keys.list', 'automations.keys.set'] as const
export type AutomationsMethod = (typeof AUTOMATIONS_METHODS)[number]
export const AUTOMATIONS_CAPABILITY = 'automations.v1'

/**
 * What an automation is, underneath: where its record lives and what opens it. A bot's schedule is a job whose Who is
 * the bot. `moved` is one that moved to another computer: only its run history stays here, read-only (Recent).
 */
export type AutomationKind = 'job' | 'watch' | 'ask' | 'moved'

/** What starts it: a time, a signed request (webhook), something on its thread (a pull request), or a person. */
export type AutomationTrigger = 'time' | 'request' | 'thread_event' | 'on_demand'

// ── The Run contract ──────────────────────────────────────────────────────────────────────────────

/** A run that is not over: waiting to start, working, or held by something that clears by waiting. */
export type RunActiveState = 'queued' | 'running' | 'waiting'
/** How a run ended: did the work, had nothing new, stopped at a missing right, or failed. */
export type RunEndState = 'done' | 'nothing_new' | 'incomplete' | 'failed'
export type RunState = RunActiveState | RunEndState
/** Why a run waits. Every reason clears by waiting, so a waiting run never needs the person. */
export type RunWaitReason = 'usage_limit' | 'offline' | 'behind'

export const RUN_END_STATES: readonly RunEndState[] = ['done', 'nothing_new', 'incomplete', 'failed']

export function isRunEnded(state: RunState): state is RunEndState {
  return (RUN_END_STATES as readonly string[]).includes(state)
}

/** One occurrence of an automation. */
export interface AutomationRun {
  /** When it started, or when it was recorded. */
  at: string
  state: RunState
  reason?: RunWaitReason
  /** With `waiting` for a usage limit: when the limit resets. */
  until?: string
  /** The error, or a one-line result. */
  detail?: string
  /** The thread the run's turn ran on; opening it lets the person continue the work. */
  threadId?: string
  /** Who actually ran it: the saved agent or the model the run's binding used (not the job's field). */
  ranBy?: string
  /** The saved agent was published again since the run before this one. */
  agentChanged?: true
  /** Repeats missed while the owning computer was off collapsed into this run, which ran once ("Missed while offline"). */
  missed?: { count: number; since: string }
  /** A request started it: the delivery, and whether its stored payload is still there to Resend. */
  request?: { occurrenceId: string; resendable?: true }
  /** Pull request events started it. */
  events?: ThreadEventKind[]
  /** It ended Incomplete because this saved key is not stored. */
  missingKey?: string
}

/** One request to an automation's URL and what became of it (its delivery log). */
export interface AutomationDelivery {
  at: string
  outcome: ScheduledWebhookDeliveryOutcome
  /** Why it was refused, or how its run ended, in the log's own words. */
  detail?: string
  /** Fields the prompt uses that the request did not have. */
  missing?: string[]
  bytes: number
  occurrenceId?: string
  /** Its payload is still stored: Resend runs the automation again with it. */
  resendable?: true
  /** It was a Resend of an earlier delivery. */
  resent?: true
}

/** How an occurrence that ended maps onto the contract; null while it waits (a usage limit, a waiting workflow). */
export function occurrenceOutcome(status: ScheduledOccurrenceResult['status'] | ScheduledJobRunRecord['status'], silent?: boolean): RunEndState | null {
  switch (status) {
    case 'ok':
      return silent ? 'nothing_new' : 'done'
    case 'error':
    case 'interrupted':
    case 'uncertain':
      return 'failed'
    default:
      return null
  }
}

/** A workflow run that waits for the person's answer (an approval or input node), from its delivery text. */
const WORKFLOW_ASK = /^State: waiting-(approval|input)$/m

/** One of a job's run records in the contract. */
export function jobRecordRun(record: ScheduledJobRunRecord): AutomationRun {
  const ranBy = record.agent?.name ?? record.selection?.model
  const base = {
    at: record.runAt,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(ranBy ? { ranBy } : {}),
    ...(record.agent?.changed ? { agentChanged: true as const } : {}),
    ...(record.missed ? { missed: record.missed } : {})
  }
  // It stopped before it started, at a key it needs that is not stored: Incomplete, with the key to add.
  if (record.missingKey) return { ...base, state: 'incomplete', detail: missingKeyText(record.missingKey), missingKey: record.missingKey }
  const ended = occurrenceOutcome(record.status, record.silent)
  if (ended) return { ...base, state: ended, ...(record.error ? { detail: record.error } : {}) }
  if (record.status === 'queued') return { ...base, state: 'waiting', reason: 'behind' }
  // `waiting`: a usage limit that resets, or a workflow that stopped at an approval or input node (it asks).
  if (record.usageLimitUntil) return { ...base, state: 'waiting', reason: 'usage_limit', until: record.usageLimitUntil }
  if (record.output && WORKFLOW_ASK.test(record.output)) return { ...base, state: 'incomplete', detail: 'Waiting for your answer' }
  return { ...base, state: 'running' }
}

/** The occurrence of a job that is under way now, in the contract; undefined when nothing is. */
export function jobActiveRun(job: ScheduledJob, now: Date = new Date()): AutomationRun | undefined {
  const pending = job.pendingOccurrence
  const live = job.liveThreadId ?? pending?.threadId ?? job.runClaim?.threadId
  const at = job.runClaim?.claimedAt ?? now.toISOString()
  if (job.liveStatus === 'running') return { at, state: 'running', ...(live ? { threadId: live } : {}) }
  if (job.liveStatus === 'needs_answer') return { at, state: 'running', detail: 'Waiting for your answer', ...(live ? { threadId: live } : {}) }
  if (pending?.state === 'queued') return { at, state: 'waiting', reason: 'behind', threadId: pending.threadId }
  if (job.waitingBehind) return { at: job.waitingBehind.since, state: 'waiting', reason: 'behind', threadId: job.waitingBehind.threadId }
  if (job.state === 'running' || pending) return { at, state: 'queued', ...(live ? { threadId: live } : {}) }
  const last = job.runHistory?.[job.runHistory.length - 1]
  if (last && (last.status === 'waiting' || last.status === 'queued')) {
    const run = jobRecordRun(last)
    if (!isRunEnded(run.state)) return run
  }
  return undefined
}

/** The newest run of a job that ended; the one Needs you and the row's "last run" read. */
export function jobLastEndedRun(job: ScheduledJob): AutomationRun | undefined {
  const history = job.runHistory ?? []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const run = jobRecordRun(history[index]!)
    if (isRunEnded(run.state)) return run
  }
  return undefined
}

// ── Tell me ───────────────────────────────────────────────────────────────────────────────────────

/** Whether a run that ended this way tells the person, under `tellMe`. */
export function tellMeNotifies(tellMe: TellMe, outcome: RunEndState): boolean {
  if (tellMe === 'every') return true
  if (tellMe === 'problems') return outcome === 'failed' || outcome === 'incomplete'
  return outcome !== 'nothing_new'
}

export const TELL_ME_LABELS: Record<TellMe, string> = {
  every: 'Every run',
  news: 'Only news',
  problems: 'Only problems'
}

/** What the scheduler tells listeners when an occurrence ends (`scheduled.runEnded`). */
export interface ScheduledRunEnded {
  jobId: string
  jobName: string
  outcome: RunEndState
  /** The job's Tell me lets this run notify. */
  notify: boolean
  threadId?: string
  error?: string
}

// ── The index ─────────────────────────────────────────────────────────────────────────────────────

/** Who does the work: an agent (the job's model, or the default agent), or a bot with its look. */
export type AutomationWho =
  | { kind: 'agent'; name: string }
  | { kind: 'saved_agent'; name: string; definitionId: string }
  | { kind: 'bot'; name: string; look: BotLook }
  | { kind: 'workflow'; name: string }
  | { kind: 'none'; name: string }

/** What opens it: the job's detail (a bot's schedule names its bot too), an agent's ask, or the thread that watches. */
export type AutomationLink =
  | { kind: 'job'; jobId: string; botId?: string }
  /** An agent's first-creation ask: Allow makes the automation (`automations.asks.answer`). */
  | { kind: 'ask'; askId: string; threadId: string }
  | { kind: 'thread'; threadId: string }
  /** Moved to another computer (`jobId` qualified there); only its history is here. */
  | { kind: 'moved'; node: string; jobId: string }

/**
 * How Needs you answers an open ask in place, with the same daemon method its own surface uses: a thread's permission
 * request (`orchestrator.answerQuestions`), a workflow step's approval (`workflowRuns.approve`), an agent's
 * first-creation ask (`automations.asks.answer`) or a bot's ask (`bots.asks.answer`).
 */
export type AttentionAnswer =
  | { kind: 'thread_approval'; threadId: string; requestId: string; questionId: string; allow: string; deny: string }
  | { kind: 'workflow_approval'; runId: string; approvalId: string; nodeId: string; instanceKey: string; attempt: number }
  | { kind: 'agent_ask'; askId: string }
  | { kind: 'bot_ask'; botId: string; askId: string }

/** Why it needs the person: an open ask (answered where it was asked), or a run that ended Failed or Incomplete. */
export interface AutomationAttention {
  kind: 'ask' | 'failed' | 'incomplete'
  text: string
  threadId?: string
  /** An ask Needs you can answer in place (Allow, with Not now in "…"); absent: it is answered where it was asked. */
  answer?: AttentionAnswer
  /** An Incomplete run stopped at this saved key: Needs you offers Add key. */
  addKey?: string
}

export interface AutomationItem {
  /** Unique in the list: `job:<id>`, `ask:<id>`, `watch:<threadId>`. */
  key: string
  kind: AutomationKind
  id: string
  name: string
  trigger: AutomationTrigger
  /** The saved schedule of a job; the row and detail word it in the owning computer's clock. */
  schedule?: JobSchedule
  /** The When as one short line, for sources without a job schedule ("every weekday · 09:00", "PR checks"). */
  whenText: string
  who: AutomationWho
  where?: { projectId: string; name: string }
  paused: boolean
  /** A pause that ends by itself. */
  pausedUntil?: string
  pausedReason?: string
  /** Paused because its bot is paused (by its owner, three failed runs or a usage limit); Resume resumes the bot. */
  pausedBy?: 'bot'
  /** The next run, in the owning computer's time zone. */
  next?: { at: string; timeZone: string }
  active?: AutomationRun
  last?: AutomationRun
  /** Recent runs, newest first. */
  runs: AutomationRun[]
  /** The effective permission: the strictest of the automation's mode, its ceiling and its thread's. Absent for a bot, a saved agent or a watch. */
  may?: PermissionMode
  /** A bot's May is its grant, shown in its chat; a saved agent's is what it may use, set in the Library. */
  mayIsGrant?: true
  tellMe?: TellMe
  addedBy?: { threadId: string; threadName?: string }
  expiresAt?: string
  /** An agent-added automation with an end: Keep removes only that end (`automations.keep`). */
  keepable?: true
  /** A watch that only notifies its thread and never starts a turn. */
  notifyOnly?: true
  /** It takes signed requests: where senders post, and the newest requests with what became of each. */
  request?: { url: string; deliveries: AutomationDelivery[] }
  /** The saved keys its runs need, by name, and whether each is stored now. */
  keys?: Array<{ name: string; stored: boolean }>
  /**
   * It wakes on a pull request's activity: the thread the PR is linked to, what wakes it, whether the watch reads it now,
   * events waiting for the rate limit, and the newest events with what became of each ("(why?)").
   */
  threadEvent?: {
    threadId: string
    threadName?: string
    number: number
    events: ThreadEventKind[]
    watching: boolean
    heldUntil?: string
    log: ScheduledEventLogEntry[]
  }
  /** Present exactly when the item is in Needs you. */
  attention?: AutomationAttention
  link: AutomationLink
  /** The computer that owns and runs it. */
  computer: AutomationComputer
}

/** A computer that owns automations: this one (`local`), or another of the person's computers (`node`). */
export interface AutomationComputer {
  name: string
  /** Its IANA time zone; its automations' times follow its clock. */
  timeZone: string
  local: boolean
  /** Another computer's Net node; absent on this computer's own. */
  node?: string
  /** It cannot be reached now: its rows are the last copy it sent (`seenAt`), and nothing can be done to them. */
  offline?: true
  /** When the copy of an offline computer's automations was read. */
  seenAt?: string
}

export interface AutomationIndex {
  items: AutomationItem[]
  /** This computer's name and IANA time zone. */
  computer: { name: string; timeZone: string }
  /**
   * The person's other computers that own automations, online or not, with their zones as each last said (absent
   * until it has answered once). The Computer chip offers them; this computer is `computer`.
   */
  computers?: AutomationComputer[]
  /**
   * The full records of the other computers' automations (ids qualified `<node>:<id>`), so their detail can be edited
   * here. Another computer's own answer carries its shareable records in `jobs` instead.
   */
  remoteJobs?: ScheduledJob[]
  /** On the answer to another computer (`automations.list` over Bridge): the records of its job rows. */
  jobs?: ScheduledJob[]
  /** Sources that could not be read now; their rows are missing, not empty. */
  unavailable: Array<'bots' | 'watches'>
  generatedAt: string
}

/** What Move to computer answers: each automation that moved (its new qualified id), and each that did not, with why. */
export interface AutomationMoveResult {
  moved: Array<{ id: string; to: string; warning?: string }>
  failed: Array<{ id: string; name?: string; error: string }>
}

/** The words for an action on an automation of a computer that cannot be reached now. */
export function offlineText(computer: Pick<AutomationComputer, 'name'>): string {
  return `${computer.name} is offline.`
}

/**
 * Whether an item is in Needs you, from its runs and asks: an open ask, or a last ended run that is Failed or
 * Incomplete. Waiting never counts, and a later run that succeeded clears an earlier failure.
 */
export function attentionOf(input: { ask?: { text: string; threadId?: string; answer?: AttentionAnswer }; last?: AutomationRun }): AutomationAttention | undefined {
  if (input.ask) return { kind: 'ask', text: input.ask.text, ...(input.ask.threadId ? { threadId: input.ask.threadId } : {}), ...(input.ask.answer ? { answer: input.ask.answer } : {}) }
  const last = input.last
  if (last?.state === 'failed') return { kind: 'failed', text: last.detail ?? 'Failed', ...(last.threadId ? { threadId: last.threadId } : {}) }
  if (last?.state === 'incomplete') return { kind: 'incomplete', text: last.detail ?? 'Stopped at a missing permission', ...(last.threadId ? { threadId: last.threadId } : {}), ...(last.missingKey ? { addKey: last.missingKey } : {}) }
  return undefined
}
