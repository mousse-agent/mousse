import type { PermissionMode } from '../../../../shared/permissionMode'
import { isWorkflowPrompt, permissionsAfterEdit } from '../../../scheduled/jobPermission'
import type { JobSchedule, ScheduledJob } from '../../../../shared/types'
import { AGENT_JOB_LIMIT_DEFAULTS, type AgentJobLimits } from '../../../../shared/agentJobLimits'
import { agentJobExpiry, isActiveAgentJob, isExpired } from '../../../scheduled/agentJobLimits'
import { runNowRefusal } from '../../../scheduled/runNowRefusal'
import { cronProblem, minCronGapMinutes } from '../../../scheduled/computeNextRun'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../../../protocol/validators'
import type { RunEngine } from '../../RunEngine'
import type { AgentScheduleHost, AppToolHost } from './host'
import { botThreadReach, lineageRelation } from './thread'
import { checkedInHandler, CLIENT_REQUEST_ID_SCHEMA, json, McpToolError, type MousseTool, type ToolCallContext } from './types'

/** The prompt `schedule_list` returns is cut to this many characters. */
const PROMPT_LIST_CHARS = 2000
/** Run records `schedule_list` returns per job. */
const RECENT_RUNS = 3
/** Subagent links followed up from a job's creating thread to the caller; a deeper chain is not the caller's. */
const SUBAGENT_DEPTH = 64
/**
 * The run-store receipt kind that keeps what `schedule_delete` removed (docs/plans/tool-api.md §1.2 "Retry"), under three
 * keys: the delete's own request key, the job (`job:<id>`), and the request key that created it (`created:<key>`). A retry
 * after a restart replays, and a stale retry of the create that made a job removed since does not make it again.
 */
export const SCHEDULE_DELETE_RECEIPT = 'schedule_delete'

/** The schedule's schema with the profile's shortest interval as it is now. */
function scheduleSchema(minMinutes: number) {
  return {
    type: 'object',
    description: `When the job runs. kind "interval": minutes (at least ${minMinutes}). kind "cron": expr with exactly five fields whose minute field is a fixed list such as "0" or "15,45", with runs at least ${minMinutes} minutes apart. kind "once": runAt, an ISO date. kind "manual": no clock; a person's turn starts it with schedule_run.`,
    properties: {
      kind: { type: 'string', enum: ['once', 'interval', 'cron', 'manual'] },
      minutes: { type: 'integer', minimum: minMinutes },
      expr: { type: 'string' },
      runAt: { type: 'string' }
    },
    required: ['kind']
  }
}

const SELECTION_SCHEMA = {
  type: 'object',
  description: 'The provider instance and model every run uses; leave it out for the thread\'s own model (a bound job) or the profile default.',
  properties: { instanceId: { type: 'string' }, model: { type: 'string' } },
  required: ['instanceId', 'model']
}

const WORKSPACE_SCHEMA = {
  type: 'object',
  description: 'Where a per-run thread works: "project" (the project checkout, the default) or "newWorktree" (a fresh Git worktree per run, agent mode only). A job bound to a thread runs in that thread\'s own workspace.',
  properties: { kind: { type: 'string', enum: ['project', 'newWorktree'] } },
  required: ['kind']
}

/** `args` without the named keys. */
function without(args: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)))
}

function toolRequestId(args: Record<string, unknown>, ctx: ToolCallContext): string {
  if (args.clientRequestId === undefined) return ctx.toolCallId
  if (typeof args.clientRequestId !== 'string' || !args.clientRequestId) throw new Error('clientRequestId must be a non-empty string')
  return args.clientRequestId
}

function requiredId(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Inputs an agent may never set, with the reason it is told. */
const FORBIDDEN_INPUTS: Readonly<Record<string, string>> = {
  trigger: 'Agent-created jobs cannot have a webhook trigger.',
  webhook: 'Agent-created jobs cannot have a webhook trigger.',
  accessCap: 'The access a job may be granted is set by Mousse from your own; you cannot choose it.',
  permissionCeiling: 'The permission mode a job may run in is set by Mousse from your own; you cannot choose it.',
  permissionMode: 'The permission mode a job runs in is set by Mousse from your own; you cannot choose it.',
  createdBy: 'createdBy is set by Mousse.',
  expiresAt: 'When a job ends is set by Mousse; only a person extends it.',
  projectId: 'A job takes the project of your own thread; you cannot name another.',
  createThread: 'createThread is not available to agents: leave threadId out for a thread per run.',
  agent: 'A saved agent is chosen by a person; a job you create runs as you, no wider.'
}

function refuseForbidden(args: Record<string, unknown>): void {
  for (const [key, reason] of Object.entries(FORBIDDEN_INPUTS)) if (args[key] !== undefined) throw new Error(reason)
}

/**
 * The cadence rules for jobs an agent makes: nothing more often than every `minMinutes` (the profile's
 * `scheduled.agentJobMinIntervalMinutes` as it is now). A cron expression has exactly five fields and a fixed list of
 * minutes that far apart (`*` and steps in the minute field would fire every minute); above an hour, the hours it
 * names must keep its runs that far apart too.
 */
export function scheduleRefusal(schedule: JobSchedule, minMinutes: number): string | undefined {
  if (schedule.kind === 'interval' && (schedule.minutes ?? 0) < minMinutes)
    return `An interval of less than ${minMinutes} minutes is not allowed for an agent's job.`
  if (schedule.kind !== 'cron') return undefined
  const fields = (schedule.expr ?? '').trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) return 'A cron expression needs exactly five fields: minute hour day-of-month month day-of-week.'
  if (!/^\d{1,2}(,\d{1,2})*$/.test(fields[0])) return 'The minute field of a cron expression must be a fixed list of minutes such as "0" or "15,45"; "*", ranges and steps are not allowed.'
  const minutes = [...new Set(fields[0].split(',').map(Number))].sort((a, b) => a - b)
  if (minutes.some((minute) => minute > 59)) return 'The minute field of a cron expression must be between 0 and 59.'
  const gaps = minutes.map((minute, index) => (index === 0 ? minutes[0] + 60 - minutes[minutes.length - 1] : minute - minutes[index - 1]))
  if (minutes.length > 1 && Math.min(...gaps) < minMinutes)
    return `The minutes of a cron expression must be at least ${minMinutes} apart.`
  const invalid = cronProblem(schedule.expr ?? '')
  if (invalid) return invalid
  // The minute field alone cannot keep runs an hour or more apart: "0 * * * *" runs every hour.
  if (minMinutes > 60) {
    const gap = minCronGapMinutes(schedule.expr ?? '')
    if (gap !== null && gap < minMinutes) return `A cron expression must not run more often than every ${minMinutes} minutes; this one runs every ${gap}.`
  }
  return undefined
}

/** A job that would start a workflow is refused: only a person starts one from a schedule. */
function promptRefusal(prompt: string): string | undefined {
  return isWorkflowPrompt(prompt) ? 'A job an agent creates cannot run workflows: its prompt may not start with "/".' : undefined
}

/**
 * The job's permission mode and ceiling after an agent changed what it does: the stricter of the stored ceiling and the
 * editor's, with the mode brought down to it (`permissionsAfterEdit`, an editor that cannot raise a ceiling).
 */
function permissionFieldsAfterAgentEdit(job: ScheduledJob, editor: PermissionMode): Pick<ScheduledJob, 'permissionMode' | 'permissionCeiling'> {
  const edit = permissionsAfterEdit({ stored: job, editor, patchMode: undefined, executable: true, canRaise: false })
  if (!edit.ok) throw new Error(edit.error)
  return { permissionMode: edit.permissionMode, permissionCeiling: edit.permissionCeiling }
}

/**
 * `schedule_list`, `schedule_create`, `schedule_update`, `schedule_pause`, `schedule_run` and `schedule_delete`: an
 * agent's hand on the jobs its own thread made (docs/run-engine/SPEC.md §15.1). `schedule_delete` also removes a job one
 * of the thread's subagents made; a subagent has these tools as its parent has them. The
 * first automation a thread's agent adds is an ask the person answers (Allow or Not now); after Allow it adds more
 * within the limits. Only a turn that holds `person` (a person started it, in a thread that is not a subagent: §1.3) may
 * create or start a job or change what one does (`needsPerson`), so no scheduled run, agent message, remote send or
 * subagent can make jobs of its own and no chain of jobs can form. A job an
 * agent creates runs no wider than the agent that made it (its permission mode is recorded on the job, and a later
 * change can only narrow it), ends after the profile's lifetime for such jobs unless a person
 * extends it, and counts against a profile-wide cap. The three limits are settings only a person changes
 * (`schedules.jobLimits`, read at every use, so the tool text and checks follow a change at once; no tool writes
 * them). Offered over MCP only, like the other tools that act on the profile.
 */
/** A private thread's job runs only in that thread or its lineage, never in new threads that are shared. */
const PRIVATE_JOB_REFUSAL = 'This is a private thread: a job that makes a new thread for each run would share that thread with the user\'s other devices. Give threadId (this thread or one of its lineage) so the job runs here.'

export function scheduleTools(host: AppToolHost, engine: RunEngine): MousseTool[] {
  // The profile hands its scheduled jobs over after the registry is built: every use reads them then.
  const schedules = new Proxy({} as AgentScheduleHost, {
    get: (_target, key) => {
      const current = host.schedules
      if (!current) throw new McpToolError('mousse_scope_denied', 'Scheduled jobs are not available in this profile.')
      const value = (current as unknown as Record<PropertyKey, unknown>)[key]
      return typeof value === 'function' ? value.bind(current) : value
    }
  })
  const limitsNow = (): AgentJobLimits => (host.schedules ? host.schedules.jobLimits() : AGENT_JOB_LIMIT_DEFAULTS)
  const allowed = (threadId: string): boolean => {
    try {
      return schedules.threadAllowed(threadId)
    } catch {
      return false
    }
  }
  const projectOf = (job: Pick<ScheduledJob, 'projectId' | 'threadId'>): string | undefined =>
    job.projectId ?? (job.threadId ? host.threadMeta?.(job.threadId)?.projectId : undefined)
  /**
   * Whose jobs the caller makes and sees: its own thread's. A personal bot's are the bot's ("schedule work in your
   * threads"), whichever of its turns made them: they are filed under its chat thread.
   */
  const ownerOf = (ctx: ToolCallContext): string => (ctx.turn.bot ? host.botHomeOf?.(ctx.caller.threadId) ?? ctx.caller.threadId : ctx.caller.threadId)
  /** The jobs an agent may see and change: the ones made through these tools by its own thread. A person's job is never one. */
  const visible = (job: ScheduledJob, ctx: ToolCallContext): boolean => job.createdBy?.threadId === ownerOf(ctx)
  /** The thread that delegated `threadId` as a subagent; undefined for a thread that is no one's subagent (a fork is not one). */
  const subagentParent = (threadId: string): string | undefined => {
    const lineage = engine.delegations.getLineage(threadId)
    return lineage?.relationship === 'subagent' ? lineage.parentThreadId : undefined
  }
  /** Whether a subagent of the caller (or a subagent of one of those) made the job through these tools. */
  const madeBySubagent = (job: ScheduledJob, ctx: ToolCallContext): boolean => {
    let current = job.createdBy?.threadId
    for (let depth = 0; current && depth < SUBAGENT_DEPTH; depth += 1) {
      current = subagentParent(current)
      if (current === ctx.caller.threadId) return true
    }
    return false
  }
  /** Jobs this tool set removed, by job id and by request key, so a repeat or a retry is answered rather than refused. */
  type Removal = { removedBy: string; job: { id: string; name: string } }
  const removal = (key: string): Removal | undefined => {
    const receipt = engine.store.getReceipt(`${SCHEDULE_DELETE_RECEIPT}:${key}`)
    return receipt?.commandKind === SCHEDULE_DELETE_RECEIPT ? (receipt.result as Removal) : undefined
  }
  const remember = (key: string, entry: Removal): void => {
    const clientRequestId = `${SCHEDULE_DELETE_RECEIPT}:${key}`
    if (engine.store.getReceipt(clientRequestId)) return
    engine.store.putReceipt({ clientRequestId, threadId: entry.removedBy, commandKind: SCHEDULE_DELETE_RECEIPT, status: 'accepted', result: entry, createdAt: new Date().toISOString() })
  }
  const findVisible = (id: string, ctx: ToolCallContext): ScheduledJob => {
    const job = schedules.get(id)
    // A job the caller may not see is refused the same way whether it exists or not.
    if (!job || !visible(job, ctx)) throw new McpToolError('mousse_scope_denied', `No scheduled job ${id} that you made.`)
    return job
  }
  /** Every change an agent makes is an `agent.action` event on its own thread, with a row in its transcript. */
  const record = (ctx: ToolCallContext, action: string, job: Pick<ScheduledJob, 'id' | 'name'>, summaryText: string, target: { threadId: string; runId?: string } = { threadId: ctx.caller.threadId, runId: ctx.caller.runId }): void => {
    try {
      host.recordAgentAction?.(
        target,
        { kind: 'agent', threadId: ctx.caller.threadId, runId: ctx.caller.runId, toolCallId: ctx.toolCallId },
        action,
        { jobId: job.id, jobName: job.name.slice(0, 120), summary: summaryText }
      )
    } catch (error) {
      console.warn('a scheduled-job change by an agent could not be recorded', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** A thread a job may be bound to: the caller's own or one in its delegation lineage; never a bot's, never an archived one. */
  const checkTarget = (threadId: string, ctx: ToolCallContext): void => {
    // A personal bot binds a job to one of its owner's threads it may reach (`botThreadReach`), never its own.
    if (ctx.turn.bot) {
      const reach = botThreadReach(host, engine, ctx.caller.threadId, threadId)
      if ('refused' in reach) throw new McpToolError('mousse_scope_denied', reach.refused)
    } else if (threadId !== ctx.caller.threadId && lineageRelation(engine, ctx.caller.threadId, threadId) === null)
      throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is not this thread or one of its lineage; a job can only be bound to those.`)
    const thread = host.threadMeta?.(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    if (thread.archivedAt) throw new Error(`Thread ${threadId} is archived; a job cannot be bound to it.`)
    let role: string | undefined
    try {
      role = host.botRole?.(threadId)
    } catch {
      role = undefined
    }
    if (role) throw new McpToolError('mousse_scope_denied', `Thread ${threadId} belongs to a bot; a job cannot be bound to it.`)
  }
  const summary = (job: ScheduledJob, ctx: ToolCallContext) => ({
    id: job.id,
    name: job.name,
    prompt: job.prompt.length > PROMPT_LIST_CHARS ? job.prompt.slice(0, PROMPT_LIST_CHARS) : job.prompt,
    ...(job.prompt.length > PROMPT_LIST_CHARS ? { promptTruncated: true } : {}),
    schedule: job.schedule,
    enabled: job.enabled,
    state: job.state,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt ?? null,
    lastStatus: job.lastStatus ?? null,
    ...(job.lastError ? { lastError: job.lastError } : {}),
    threadId: job.threadId ?? null,
    projectId: job.projectId ?? null,
    selection: job.selection ?? null,
    workspace: job.workspace ?? null,
    ...(job.repeat ? { repeat: job.repeat } : {}),
    createdByAgent: Boolean(job.createdBy),
    createdByYou: job.createdBy?.threadId === ownerOf(ctx),
    ...(job.createdBy && job.createdBy.threadId !== ownerOf(ctx) ? { createdBySubagent: job.createdBy.threadId } : {}),
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    ...(job.permissionCeiling ? { permissionCeiling: job.permissionCeiling } : {}),
    ...(job.pendingOccurrence ? { pendingRun: job.pendingOccurrence.state } : job.state === 'running' ? { pendingRun: 'running' } : {}),
    recentRuns: (job.runHistory ?? []).slice(-RECENT_RUNS).reverse().map((record) => ({
      runAt: record.runAt,
      status: record.status,
      ...(record.error ? { error: record.error } : {})
    }))
  })

  /** The profile-wide cap on active agent-made jobs, counted from the saved jobs so a restart does not reset it. */
  const assertRoomForAnotherJob = (): void => {
    const active = schedules.list().filter(isActiveAgentJob).length
    const { maxActive } = limitsNow()
    if (active >= maxActive)
      throw new Error(`The profile already has ${active} active jobs made by agents (the limit is ${maxActive}). Pause one with schedule_pause, wait for one to end, or ask the user.`)
  }

  const common = {
    access: 'managesOthers' as const,
    // The central check reads this as a listing. Which jobs the caller may touch is the handler's decision (`visible`):
    // the ones its own thread made.
    target: () => ({}),
    authorize: checkedInHandler('the handlers accept the caller\'s own thread or its lineage only (checkTarget)'),
    offered: () => false,
    listed: () => host.schedules !== undefined,
    available: () => (host.schedules ? true as const : 'Scheduled jobs are not available in this profile.')
  }

  return [
    {
      ...common,
      name: 'schedule_list',
      description:
        'List the scheduled jobs your thread created, and the ones your subagents created (createdBySubagent names the subagent\'s thread: you may remove those with schedule_delete, not change them). Jobs a person made, and jobs other threads made, are not shown and cannot be changed. Each job shows its cadence, state, when it ends, last runs and the limits its runs have.',
      inputSchema: { type: 'object', properties: {} },
      class: 'read',
      handler: (_args, ctx) => {
        const jobs = schedules.list().filter((job) => visible(job, ctx) || madeBySubagent(job, ctx)).map((job) => summary(job, ctx))
        return json({ jobs })
      }
    },
    {
      ...common,
      name: 'schedule_create',
      // Read at every listing: the tool is built once, and a person may change the limits at any time.
      get description() {
        const limits = limitsNow()
        return `Create a scheduled job that runs a prompt later or on a cadence, as a turn in a thread (needs a turn a person started, or a subagent of one: a job, another agent's message or a remote send cannot create jobs; the first time, the person is asked and the job is made only if they allow it; a subagent's every job is asked). The job outlives this run. It runs no wider than you do: its runs get at most your permission mode. It takes your thread's project. Leave threadId out for a new thread per run, or give your own thread or one of your lineage. Not allowed: a prompt that starts with "/", a webhook trigger, a worktree workspace, an interval under ${limits.minIntervalMinutes} minutes. The profile allows ${limits.maxActive} active jobs made by agents in all, and a job ends ${limits.lifetimeDays} days after it is made unless a person extends it. A person sets these limits; you cannot change them. The job is labelled as made by an agent and each change you make is recorded in your thread. Use schedule_run to start it at once.`
      },
      // A personal bot ("schedule work in your threads"): its owner allowed its jobs once, and it names where they run.
      get botDescription() {
        const limits = limitsNow()
        return `Create a scheduled job for your owner that runs a prompt later or on a cadence, as Mousse's Scheduled jobs do: a turn in one of your owner's threads (threadId) or a new thread per run in one of their projects (projectId). Use it when your owner asks for work in their threads on a schedule; for something only you do at a time, use bot_schedule_add. Your owner allowed this, so nothing asks first. Its runs work in Full access (or no wider than the device your owner wrote from). Not allowed: a prompt that starts with "/", a webhook trigger, a worktree workspace, an interval under ${limits.minIntervalMinutes} minutes. The profile allows ${limits.maxActive} active jobs made by agents in all, and a job ends ${limits.lifetimeDays} days after it is made unless your owner extends it. You see and change only the jobs you made. Use schedule_run to start it at once.`
      },
      get botInputSchema() {
        const schema = this.inputSchema as { properties: Record<string, unknown> }
        return {
          ...schema,
          properties: {
            ...schema.properties,
            threadId: { type: 'string', description: 'Run in this thread of your owner\'s (thread_list).' },
            projectId: { type: 'string', description: 'Or a new thread per run in this project of your owner\'s (thread_list\'s projects).' }
          }
        }
      },
      get inputSchema() {
        return {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string', description: 'What the run is asked to do, written for an agent that has none of this conversation.' },
            schedule: scheduleSchema(limitsNow().minIntervalMinutes),
            selection: SELECTION_SCHEMA,
            workspace: WORKSPACE_SCHEMA,
            threadId: { type: 'string', description: 'Run in this thread (yours or one of your lineage); a new thread per run when omitted.' },
            repeat: { type: 'object', properties: { times: { type: 'integer', minimum: 1 } }, description: 'Stop after this many runs.' },
            clientRequestId: CLIENT_REQUEST_ID_SCHEMA
          },
          required: ['name', 'prompt', 'schedule']
        }
      },
      class: 'mutation',
      needsPerson: true,
      handler: (args, ctx) => {
        // A personal bot has no project of its own: a job that starts a new thread per run names the project. Any other
        // caller's job takes its thread's project, so naming one is refused as before.
        const bot = Boolean(ctx.turn.bot)
        const { projectId: _named, ...checkedArgs } = args
        refuseForbidden(bot ? checkedArgs : args)
        if (bot && args.projectId !== undefined && (typeof args.projectId !== 'string' || !args.projectId.trim()))
          throw new Error('projectId must be one of your owner\'s projects (thread_list).')
        const botProject = bot && typeof args.projectId === 'string' ? args.projectId.trim() : undefined
        const owner = ownerOf(ctx)
        const requestKey = `schedule_create:${owner}:${toolRequestId(args, ctx)}`
        // A retry of a call that already made its job returns that job and changes nothing, however many jobs exist.
        const earlier = schedules.list().find((job) => job.createdBy?.requestId === requestKey)
        if (earlier) return json({ job: summary(earlier, ctx), replayed: true })
        // The job this key made was removed since: a stale retry says so and does not make it again.
        const gone = removal(`created:${requestKey}`)
        if (gone) return json({ job: gone.job, replayed: true, removed: true, note: 'This call already made this job, and it was removed since; nothing was made. Use a new clientRequestId to make a new one.' })
        const { projectId: _botProject, ...rest } = args
        const input = asCreateScheduledJobInput(without(rest, 'clientRequestId'))
        const refusal = scheduleRefusal(input.schedule, limitsNow().minIntervalMinutes) ?? promptRefusal(input.prompt)
        if (refusal) throw new Error(refusal)
        if (input.workspace?.kind === 'worktree') throw new Error('A job an agent creates cannot run in an existing worktree.')
        const caller = host.threadMeta?.(ctx.caller.threadId)
        if (!caller) throw new Error(`Thread ${ctx.caller.threadId} was not found.`)
        if (!input.threadId && caller.localOnly === true) throw new Error(PRIVATE_JOB_REFUSAL)
        let projectId = bot ? botProject : caller.projectId
        if (input.threadId) {
          checkTarget(input.threadId, ctx)
          projectId = host.threadMeta?.(input.threadId)?.projectId
        } else if (bot && !botProject) {
          throw new Error('Name where its runs happen: threadId (one of your owner\'s threads) for a turn there, or projectId (one of their projects) for a new thread per run.')
        } else if (bot && !host.listProjects?.().some((project) => project.id === botProject)) {
          throw new Error(`There is no project ${botProject}.`)
        }
        const candidate = { ...(input.threadId ? { threadId: input.threadId } : {}), ...(projectId ? { projectId } : {}), ...(input.selection ? { selection: input.selection } : {}), ...(input.workspace ? { workspace: input.workspace } : {}) }
        const checked = schedules.validate(candidate)
        const limits = schedules.limits(ctx.caller)
        const job = {
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          ...candidate,
          ...(checked.selection ? { selection: checked.selection } : {}),
          ...(input.repeat ? { repeat: input.repeat } : {}),
          createdBy: { threadId: owner, runId: ctx.caller.runId, requestId: requestKey },
          permissionCeiling: limits.permissionCeiling
        }
        // The first time, the person is asked; the job is made only when they allow it, which also lets this thread add more.
        // A personal bot's owner allowed "schedule work in your threads" once: that is their Allow for the bot's jobs.
        // A subagent never gets here: it does not hold `person`.
        if (!bot && !allowed(ctx.caller.threadId)) {
          const ask = schedules.askFirst({ threadId: ctx.caller.threadId, requestKey, job })
          return json({
            waiting: true,
            askId: ask.id,
            message: `Not created yet: the person is asked whether to add "${job.name}" (Allow or Not now). It is made only if they allow it; do not ask again or retry. Tell them it is waiting for their answer in Automations.`
          })
        }
        // Counted from the saved jobs, right before the job is saved, with nothing awaited in between.
        assertRoomForAnotherJob()
        const created = schedules.create({ ...job, expiresAt: agentJobExpiry(limitsNow().lifetimeDays) })
        record(ctx, 'scheduled_job_created', created, `created scheduled job "${created.name}" (${created.id})`)
        return json({ job: summary(created, ctx) })
      }
    },
    {
      ...common,
      name: 'schedule_update',
      description:
        'Change a scheduled job your thread created. Pass jobId and only the fields to change; null clears model, workspace or thread back to the default. Changing anything but the name needs a turn a person started. The rules of schedule_create hold. A change can only narrow the access and permission mode its runs get, to yours at most, and can only shorten how many runs it has; it never lengthens the job\'s life. To pause a job use schedule_pause; resuming or extending one is for a person.',
      get inputSchema() {
        return {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            schedule: scheduleSchema(limitsNow().minIntervalMinutes),
            selection: { ...SELECTION_SCHEMA, type: ['object', 'null'] },
            workspace: { ...WORKSPACE_SCHEMA, type: ['object', 'null'] },
            threadId: { type: ['string', 'null'], description: 'Your thread or one of your lineage; null for a new thread per run.' },
            repeat: { type: ['object', 'null'], properties: { times: { type: 'integer', minimum: 1 } } }
          },
          required: ['jobId']
        }
      },
      class: 'mutation',
      // Changing what a job does; renaming it is for any turn.
      needsPerson: (args) => {
        try {
          return Object.keys(asScheduledJobPatch(without(args, 'jobId'))).some((key) => key !== 'name')
        } catch {
          return false
        }
      },
      handler: (args, ctx) => {
        refuseForbidden(args)
        if (args.enabled !== undefined) throw new Error('schedule_update does not change whether a job is enabled: pause it with schedule_pause; a person resumes it.')
        const job = findVisible(requiredId(args, 'jobId'), ctx)
        const patch = asScheduledJobPatch(without(args, 'jobId'))
        if (Object.keys(patch).length === 0) throw new Error('Pass at least one field to change.')
        const executable = Object.keys(patch).some((key) => key !== 'name')
        if (executable && isWorkflowPrompt(job.prompt)) throw new Error('This job runs a workflow; an agent does not change those.')
        if (patch.repeat === null) throw new Error('A job\'s number of runs cannot be removed; it can only be shortened.')
        if (patch.repeat?.times !== undefined && job.repeat?.times !== undefined && patch.repeat.times > job.repeat.times)
          throw new Error(`A job's number of runs can only be shortened (it has ${job.repeat.times}).`)
        if (patch.prompt !== undefined) {
          const refusal = promptRefusal(patch.prompt)
          if (refusal) throw new Error(refusal)
        }
        if (patch.schedule) {
          const refusal = scheduleRefusal(patch.schedule, limitsNow().minIntervalMinutes)
          if (refusal) throw new Error(refusal)
        }
        if (patch.workspace?.kind === 'worktree') throw new Error('A job an agent changes cannot run in an existing worktree.')
        // The thread the job is bound to follows the project it belongs to; a cleared thread keeps the project it had.
        let projectId = job.projectId
        if (typeof patch.threadId === 'string') {
          checkTarget(patch.threadId, ctx)
          projectId = host.threadMeta?.(patch.threadId)?.projectId
        } else if (patch.threadId === null) {
          if (host.threadMeta?.(ctx.caller.threadId)?.localOnly === true) throw new Error(PRIVATE_JOB_REFUSAL)
          projectId = projectOf(job)
        }
        const merged = {
          threadId: patch.threadId === undefined ? job.threadId : patch.threadId ?? undefined,
          projectId,
          selection: patch.selection === undefined ? job.selection : patch.selection ?? undefined,
          workspace: patch.workspace === undefined ? job.workspace : patch.workspace ?? undefined
        }
        const touchesOptions = ['selection', 'workspace', 'threadId'].some((key) => (patch as Record<string, unknown>)[key] !== undefined)
        const checked = touchesOptions ? schedules.validate(merged) : {}
        const limits = executable ? schedules.limits(ctx.caller) : undefined
        const changes: Partial<ScheduledJob> = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
          ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
          ...(patch.threadId !== undefined ? { threadId: patch.threadId ?? undefined, projectId } : {}),
          ...(patch.selection !== undefined ? { selection: patch.selection === null ? undefined : checked.selection ?? patch.selection } : {}),
          ...(patch.workspace !== undefined ? { workspace: patch.workspace ?? undefined } : {}),
          ...(patch.repeat !== undefined && patch.repeat !== null ? { repeat: { times: patch.repeat.times, completed: job.repeat?.completed ?? 0 } } : {}),
          // Whatever mode the job could run in before, it can run in no wider one now: the narrower of what it had and what
          // this caller holds. It is never raised.
          ...(limits ? permissionFieldsAfterAgentEdit(job, limits.permissionCeiling) : {})
        }
        const updated = schedules.update(job.id, changes)
        if (!updated) throw new Error(`Job ${job.id} no longer exists.`)
        record(ctx, 'scheduled_job_updated', updated, `changed ${Object.keys(patch).join(', ')} of scheduled job "${updated.name}" (${updated.id})`)
        return json({ job: summary(updated, ctx) })
      }
    },
    {
      ...common,
      name: 'schedule_pause',
      description:
        'Pause a scheduled job your thread created, so it starts no further runs. A run in progress finishes. Only a person resumes a paused job.',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string' }, reason: { type: 'string', description: 'Shown next to the paused job.' } },
        required: ['jobId']
      },
      class: 'mutation',
      handler: (args, ctx) => {
        const job = findVisible(requiredId(args, 'jobId'), ctx)
        if (args.reason !== undefined && typeof args.reason !== 'string') throw new Error('reason must be a string')
        const reason = `Paused by an agent${typeof args.reason === 'string' && args.reason.trim() ? `: ${args.reason.trim()}` : ''}`.slice(0, 512)
        const paused = schedules.pause(job.id, reason)
        if (!paused) throw new Error(`Job ${job.id} no longer exists.`)
        record(ctx, 'scheduled_job_paused', paused, `paused scheduled job "${paused.name}" (${paused.id})`)
        return json({ job: summary(paused, ctx) })
      }
    },
    {
      ...common,
      name: 'schedule_run',
      description:
        'Start a scheduled job your thread created now, as Run now does (needs a turn a person started: a job cannot start another). It starts within seconds, runs under the limits recorded on the job, and is refused while the job is running, waits in a queue, is paused, or has ended (a person resumes or extends it). The result is in the job\'s run history: read it with schedule_list.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      class: 'mutation',
      needsPerson: true,
      handler: (args, ctx) => {
        const job = findVisible(requiredId(args, 'jobId'), ctx)
        if (isWorkflowPrompt(job.prompt)) return { text: 'This job runs a workflow; an agent does not start those.', isError: true }
        const refusal = runNowRefusal(job)
        if (refusal) return { text: refusal, isError: true }
        // Starting a job also resumes it; a person's pause is not undone by an agent's run.
        if (!job.enabled || job.state === 'paused') return { text: `Job ${job.name} is paused; only a person resumes it.`, isError: true }
        // A finished job (a one-time job that ran, a job that ran out of runs or time) is not brought back.
        if (job.state === 'completed' || isExpired(job)) return { text: `Job ${job.name} has ended; only a person extends or recreates it.`, isError: true }
        const started = schedules.trigger(job.id)
        if (!started) throw new Error(`Job ${job.id} no longer exists.`)
        // Run now starts within seconds: the scheduler ticks now instead of at the next minute.
        schedules.wake()
        record(ctx, 'scheduled_job_run', started, `started scheduled job "${started.name}" (${started.id})`)
        return json({ job: summary(started, ctx), started: true })
      }
    },
    {
      ...common,
      name: 'schedule_delete',
      description:
        'Remove a scheduled job your thread created, or one your subagents created, for good: it leaves Automations and schedule_list and starts no further runs. A run that already started, or already waits in its thread\'s queue, still runs and finishes in that thread; its result is not recorded on any job. A person\'s job and another thread\'s job are never removed. A subagent removes the jobs it made, as its parent does. Any turn of your thread may remove one, so a job bound to your thread can remove itself when its work is done. The removal is recorded in your thread with the job\'s name. A repeat for a job already removed, or a retry with the same clientRequestId, says it is gone and changes nothing.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, clientRequestId: CLIENT_REQUEST_ID_SCHEMA }, required: ['jobId'] },
      class: 'mutation',
      handler: (args, ctx) => {
        const id = requiredId(args, 'jobId')
        const requestKey = `schedule_delete:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`
        const replay = removal(requestKey)
        if (replay) return json({ removed: true, alreadyRemoved: true, replayed: true, job: replay.job })
        const job = schedules.get(id)
        if (!job || !(visible(job, ctx) || madeBySubagent(job, ctx))) {
          // A job this thread removed before is gone, not refused; anything else is refused the same way whether it exists or not.
          const earlier = removal(`job:${id}`)
          if (!job && earlier?.removedBy === ctx.caller.threadId) return json({ removed: true, alreadyRemoved: true, job: earlier.job })
          throw new McpToolError(
            'mousse_scope_denied',
            `No scheduled job ${id} that you or your subagents made. A thread removes only the jobs it made and the ones its subagents made; a person's job and another thread's job are not removed by an agent. A job you removed already is gone: schedule_list shows the ones you can remove.`
          )
        }
        const entry = { removedBy: ctx.caller.threadId, job: { id: job.id, name: job.name } }
        // The deletion Automations' Delete makes. False: someone removed it in between, which is the same outcome.
        if (!schedules.remove(job.id)) return json({ removed: true, alreadyRemoved: true, job: entry.job })
        remember(`job:${job.id}`, entry)
        remember(requestKey, entry)
        if (job.createdBy?.requestId) remember(`created:${job.createdBy.requestId}`, entry)
        const summaryText = `removed scheduled job "${job.name}" (${job.id})`
        record(ctx, 'scheduled_job_deleted', job, summaryText)
        // A subagent's job: its own thread shows the removal too, by whom.
        const creator = job.createdBy!.threadId
        if (creator !== ctx.caller.threadId) record(ctx, 'scheduled_job_deleted', job, `${summaryText}, which this thread made; removed by thread ${ctx.caller.threadId}`, { threadId: creator })
        const started = job.state === 'running' || job.pendingOccurrence !== undefined
        return json({
          removed: true,
          job: entry.job,
          ...(started ? { runInProgress: 'A run of this job had started or was waiting in its thread\'s queue; it still runs and finishes there, and its result is not recorded on any job.' } : {})
        })
      }
    }
  ]
}
