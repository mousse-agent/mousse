import type { PermissionMode } from '../../../../shared/permissionMode'
import { isWorkflowPrompt, permissionsAfterEdit } from '../../../scheduled/jobPermission'
import { narrowAgentAccess } from '../../../../shared/settings'
import type { JobSchedule, ScheduledJob } from '../../../../shared/types'
import { AGENT_JOB_LIFETIME_DAYS, AGENT_JOB_MAX_ACTIVE, AGENT_JOB_MIN_INTERVAL_MINUTES, agentJobExpiry, isActiveAgentJob, isExpired } from '../../../scheduled/agentJobLimits'
import { runNowRefusal } from '../../../scheduled/runNowRefusal'
import { cronProblem } from '../../../scheduled/computeNextRun'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../../../protocol/validators'
import type { RunEngine } from '../../RunEngine'
import type { AgentScheduleHost, AppToolHost } from './host'
import { lineageRelation } from './thread'
import { CLIENT_REQUEST_ID_SCHEMA, json, McpToolError, type MousseTool, type ToolCallContext } from './types'

const MIN_MINUTES = AGENT_JOB_MIN_INTERVAL_MINUTES
/** The prompt `schedule_list` returns is cut to this many characters. */
const PROMPT_LIST_CHARS = 2000
/** Run records `schedule_list` returns per job. */
const RECENT_RUNS = 3

const SCHEDULE_SCHEMA = {
  type: 'object',
  description: `When the job runs. kind "interval": minutes (at least ${MIN_MINUTES}). kind "cron": expr with exactly five fields whose minute field is a fixed list such as "0" or "15,45", at least ${MIN_MINUTES} minutes apart. kind "once": runAt, an ISO date. kind "manual": no clock; a person's turn starts it with schedule_run.`,
  properties: {
    kind: { type: 'string', enum: ['once', 'interval', 'cron', 'manual'] },
    minutes: { type: 'integer', minimum: MIN_MINUTES },
    expr: { type: 'string' },
    runAt: { type: 'string' }
  },
  required: ['kind']
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
  createThread: 'createThread is not available to agents: leave threadId out for a thread per run.'
}

function refuseForbidden(args: Record<string, unknown>): void {
  for (const [key, reason] of Object.entries(FORBIDDEN_INPUTS)) if (args[key] !== undefined) throw new Error(reason)
}

/**
 * The cadence rules for jobs an agent makes: nothing more often than every `AGENT_JOB_MIN_INTERVAL_MINUTES`. A cron
 * expression has exactly five fields and a fixed list of minutes that far apart (`*` and steps in the minute field would
 * fire every minute).
 */
export function scheduleRefusal(schedule: JobSchedule): string | undefined {
  if (schedule.kind === 'interval' && (schedule.minutes ?? 0) < MIN_MINUTES)
    return `An interval of less than ${MIN_MINUTES} minutes is not allowed for an agent's job.`
  if (schedule.kind !== 'cron') return undefined
  const fields = (schedule.expr ?? '').trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) return 'A cron expression needs exactly five fields: minute hour day-of-month month day-of-week.'
  if (!/^\d{1,2}(,\d{1,2})*$/.test(fields[0])) return 'The minute field of a cron expression must be a fixed list of minutes such as "0" or "15,45"; "*", ranges and steps are not allowed.'
  const minutes = [...new Set(fields[0].split(',').map(Number))].sort((a, b) => a - b)
  if (minutes.some((minute) => minute > 59)) return 'The minute field of a cron expression must be between 0 and 59.'
  const gaps = minutes.map((minute, index) => (index === 0 ? minutes[0] + 60 - minutes[minutes.length - 1] : minute - minutes[index - 1]))
  if (minutes.length > 1 && Math.min(...gaps) < MIN_MINUTES)
    return `The minutes of a cron expression must be at least ${MIN_MINUTES} apart.`
  return cronProblem(schedule.expr ?? '')
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
 * `schedule_list`, `schedule_create`, `schedule_update`, `schedule_pause` and `schedule_run`: an agent's hand on the jobs
 * its own thread made (docs/run-engine/SPEC.md §15.1). Every tool needs the `manage` agent access level and
 * `scheduled.agentJobs` to be on. Only a turn a person started may create or start a job or change what one does, so
 * no scheduled run, agent message, subagent or channel can make jobs of its own and no chain of jobs can form. A job an
 * agent creates runs no wider than the agent that made it (its access level and permission mode are recorded on the
 * job, and a later change can only narrow them), ends after `AGENT_JOB_LIFETIME_DAYS` days unless a person extends it,
 * and counts against a profile-wide cap. Offered over MCP only, like the other tools that act on the profile.
 */
export function scheduleTools(host: AppToolHost, engine: RunEngine): MousseTool[] {
  const schedules = host.schedules
  if (!schedules) return []
  const enabled = (): boolean => {
    try {
      return schedules.enabled()
    } catch {
      return false
    }
  }
  const switchedOff = 'Agents may not use scheduled jobs here: a person turns on "Agents may create jobs" on the Scheduled page.'
  const projectOf = (job: Pick<ScheduledJob, 'projectId' | 'threadId'>): string | undefined =>
    job.projectId ?? (job.threadId ? host.threadMeta?.(job.threadId)?.projectId : undefined)
  /** The jobs an agent may see and change: the ones made through these tools by its own thread. A person's job is never one. */
  const visible = (job: ScheduledJob, ctx: ToolCallContext): boolean => job.createdBy?.threadId === ctx.caller.threadId
  const findVisible = (id: string, ctx: ToolCallContext): ScheduledJob => {
    const job = schedules.get(id)
    // A job the caller may not see is refused the same way whether it exists or not.
    if (!job || !visible(job, ctx)) throw new McpToolError('mousse_scope_denied', `No scheduled job ${id} that you made.`)
    return job
  }
  /** Creating or starting a job, and changing what one does, is for a turn a person started. Everything else is refused. */
  const requirePerson = (ctx: ToolCallContext, what: string): void => {
    let person = false
    try {
      person = schedules.startedByPerson(ctx.caller)
    } catch {
      person = false
    }
    if (!person)
      throw new McpToolError(
        'mousse_scope_denied',
        `${what} is only for a turn a person started. This run was started by a job, an agent's message, a subagent, a wake, a continuation, a bot or a channel, or its origin cannot be read; ask from the person's own turn.`
      )
  }
  /** Every change an agent makes is an `agent.action` event on its own thread, with a row in its transcript. */
  const record = (ctx: ToolCallContext, action: string, job: Pick<ScheduledJob, 'id' | 'name'>, summaryText: string): void => {
    try {
      host.recordAgentAction?.(
        { threadId: ctx.caller.threadId, runId: ctx.caller.runId },
        { kind: 'agent', threadId: ctx.caller.threadId, runId: ctx.caller.runId, toolCallId: ctx.toolCallId },
        action,
        { jobId: job.id, jobName: job.name.slice(0, 120), summary: summaryText }
      )
    } catch (error) {
      console.warn('a scheduled-job change by an agent could not be recorded', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const planOnly = (ctx: ToolCallContext): boolean => ctx.caller.modeCeiling === 'plan' || ctx.turn.modeCeiling === 'plan'
  /** A thread a job may be bound to: the caller's own or one in its delegation lineage; never a bot's, never an archived one. */
  const checkTarget = (threadId: string, ctx: ToolCallContext): void => {
    if (threadId !== ctx.caller.threadId && lineageRelation(engine, ctx.caller.threadId, threadId) === null)
      throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is not this thread or one of its lineage; a job can only be bound to those.`)
    const thread = host.threadMeta?.(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    if (thread.settledAt) throw new Error(`Thread ${threadId} is archived; a job cannot be bound to it.`)
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
    mode: job.mode ?? null,
    selection: job.selection ?? null,
    workspace: job.workspace ?? null,
    ...(job.repeat ? { repeat: job.repeat } : {}),
    createdByAgent: Boolean(job.createdBy),
    createdByYou: job.createdBy?.threadId === ctx.caller.threadId,
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
    ...(job.accessCap ? { accessCap: job.accessCap } : {}),
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
    if (active >= AGENT_JOB_MAX_ACTIVE)
      throw new Error(`The profile already has ${active} active jobs made by agents (the limit is ${AGENT_JOB_MAX_ACTIVE}). Pause one with schedule_pause, wait for one to end, or ask the user.`)
  }

  const common = {
    access: 'managesOthers' as const,
    minLevel: 'manage' as const,
    // The central check reads this as a listing: it needs the manage level and nothing else. Which jobs the caller may
    // touch is the handler's decision (`visible`): the ones its own thread made.
    target: () => ({}),
    threadArgChecked: 'the handlers accept the caller\'s own thread or its lineage only (checkTarget)',
    offered: () => false,
    listed: () => enabled(),
    available: () => (enabled() ? true : switchedOff)
  }

  return [
    {
      ...common,
      name: 'schedule_list',
      description:
        'List the scheduled jobs your thread created (needs the manage agent access level and "Agents may create jobs" turned on). Jobs a person made, and jobs other threads made, are not shown and cannot be changed. Each job shows its cadence, state, when it ends, last runs and the limits its runs have.',
      inputSchema: { type: 'object', properties: {} },
      class: 'read',
      handler: (_args, ctx) => {
        const jobs = schedules.list().filter((job) => visible(job, ctx)).map((job) => summary(job, ctx))
        return json({ jobs })
      }
    },
    {
      ...common,
      name: 'schedule_create',
      description: `Create a scheduled job that runs a prompt later or on a cadence, as a turn in a thread (needs the manage agent access level, "Agents may create jobs" turned on, and a turn a person started: a job, another agent, a subagent or a channel cannot create jobs). The job outlives this run. It runs no wider than you do: its runs get at most your access level and permission mode. It takes your thread's project. Leave threadId out for a new thread per run, or give your own thread or one of your lineage. Not allowed: a prompt that starts with "/", a webhook trigger, a worktree workspace, an interval under ${MIN_MINUTES} minutes. The profile allows ${AGENT_JOB_MAX_ACTIVE} active jobs made by agents in all, and a job ends ${AGENT_JOB_LIFETIME_DAYS} days after it is made unless a person extends it. The job is labelled as made by an agent and each change you make is recorded in your thread. Use schedule_run to start it at once.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'What the run is asked to do, written for an agent that has none of this conversation.' },
          schedule: SCHEDULE_SCHEMA,
          mode: { type: 'string', enum: ['agent', 'plan'], description: 'Defaults to agent; plan only under a plan ceiling.' },
          selection: SELECTION_SCHEMA,
          workspace: WORKSPACE_SCHEMA,
          threadId: { type: 'string', description: 'Run in this thread (yours or one of your lineage); a new thread per run when omitted.' },
          repeat: { type: 'object', properties: { times: { type: 'integer', minimum: 1 } }, description: 'Stop after this many runs.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['name', 'prompt', 'schedule']
      },
      class: 'mutation',
      handler: (args, ctx) => {
        if (!enabled()) return { text: switchedOff, isError: true }
        requirePerson(ctx, 'schedule_create')
        refuseForbidden(args)
        const requestKey = `schedule_create:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`
        // A retry of a call that already made its job returns that job and changes nothing, however many jobs exist.
        const earlier = schedules.list().find((job) => job.createdBy?.requestId === requestKey)
        if (earlier) return json({ job: summary(earlier, ctx), replayed: true })
        const input = asCreateScheduledJobInput(without(args, 'clientRequestId'))
        const refusal = scheduleRefusal(input.schedule) ?? promptRefusal(input.prompt)
        if (refusal) throw new Error(refusal)
        if (input.workspace?.kind === 'worktree') throw new Error('A job an agent creates cannot run in an existing worktree.')
        let mode = input.mode
        if (planOnly(ctx)) {
          if (mode === 'agent') throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller can only create plan jobs.')
          mode = 'plan'
        }
        const caller = host.threadMeta?.(ctx.caller.threadId)
        if (!caller) throw new Error(`Thread ${ctx.caller.threadId} was not found.`)
        let projectId = caller.projectId
        if (input.threadId) {
          checkTarget(input.threadId, ctx)
          projectId = host.threadMeta?.(input.threadId)?.projectId
        }
        const candidate = { ...(input.threadId ? { threadId: input.threadId } : {}), ...(projectId ? { projectId } : {}), ...(input.selection ? { selection: input.selection } : {}), ...(mode ? { mode } : {}), ...(input.workspace ? { workspace: input.workspace } : {}) }
        const checked = schedules.validate(candidate)
        const limits = schedules.limits(ctx.caller)
        // Counted from the saved jobs, right before the job is saved, with nothing awaited in between.
        assertRoomForAnotherJob()
        const job = schedules.create({
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          ...candidate,
          ...(checked.selection ? { selection: checked.selection } : {}),
          ...(input.repeat ? { repeat: input.repeat } : {}),
          createdBy: { threadId: ctx.caller.threadId, runId: ctx.caller.runId, requestId: requestKey },
          accessCap: limits.accessCap,
          permissionCeiling: limits.permissionCeiling,
          expiresAt: agentJobExpiry()
        })
        record(ctx, 'scheduled_job_created', job, `created scheduled job "${job.name}" (${job.id})`)
        return json({ job: summary(job, ctx) })
      }
    },
    {
      ...common,
      name: 'schedule_update',
      description:
        'Change a scheduled job your thread created (needs the manage agent access level and "Agents may create jobs" turned on). Pass jobId and only the fields to change; null clears model, workspace, thread or mode back to the default. Changing anything but the name needs a turn a person started. The rules of schedule_create hold. A change can only narrow the access and permission mode its runs get, to yours at most, and can only shorten how many runs it has; it never lengthens the job\'s life. To pause a job use schedule_pause; resuming or extending one is for a person.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          schedule: SCHEDULE_SCHEMA,
          mode: { type: ['string', 'null'], enum: ['agent', 'plan', null] },
          selection: { ...SELECTION_SCHEMA, type: ['object', 'null'] },
          workspace: { ...WORKSPACE_SCHEMA, type: ['object', 'null'] },
          threadId: { type: ['string', 'null'], description: 'Your thread or one of your lineage; null for a new thread per run.' },
          repeat: { type: ['object', 'null'], properties: { times: { type: 'integer', minimum: 1 } } }
        },
        required: ['jobId']
      },
      class: 'mutation',
      handler: (args, ctx) => {
        if (!enabled()) return { text: switchedOff, isError: true }
        refuseForbidden(args)
        if (args.enabled !== undefined) throw new Error('schedule_update does not change whether a job is enabled: pause it with schedule_pause; a person resumes it.')
        const job = findVisible(requiredId(args, 'jobId'), ctx)
        const patch = asScheduledJobPatch(without(args, 'jobId'))
        if (Object.keys(patch).length === 0) throw new Error('Pass at least one field to change.')
        const executable = Object.keys(patch).some((key) => key !== 'name')
        if (executable) {
          requirePerson(ctx, 'schedule_update of anything but the name')
          if (isWorkflowPrompt(job.prompt)) throw new Error('This job runs a workflow; an agent does not change those.')
        }
        if (patch.repeat === null) throw new Error('A job\'s number of runs cannot be removed; it can only be shortened.')
        if (patch.repeat?.times !== undefined && job.repeat?.times !== undefined && patch.repeat.times > job.repeat.times)
          throw new Error(`A job's number of runs can only be shortened (it has ${job.repeat.times}).`)
        if (patch.prompt !== undefined) {
          const refusal = promptRefusal(patch.prompt)
          if (refusal) throw new Error(refusal)
        }
        if (patch.schedule) {
          const refusal = scheduleRefusal(patch.schedule)
          if (refusal) throw new Error(refusal)
        }
        if (patch.workspace?.kind === 'worktree') throw new Error('A job an agent changes cannot run in an existing worktree.')
        if (planOnly(ctx)) {
          // A plan ceiling reads and plans: it neither changes a job that can act nor makes one that can.
          if ((job.mode ?? 'agent') !== 'plan') throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot change a job that runs in agent mode.')
          if (patch.mode !== 'plan' && patch.mode !== undefined) throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller can only keep a job in plan mode.')
        }
        // The thread the job is bound to follows the project it belongs to; a cleared thread keeps the project it had.
        let projectId = job.projectId
        if (typeof patch.threadId === 'string') {
          checkTarget(patch.threadId, ctx)
          projectId = host.threadMeta?.(patch.threadId)?.projectId
        } else if (patch.threadId === null) projectId = projectOf(job)
        const merged = {
          threadId: patch.threadId === undefined ? job.threadId : patch.threadId ?? undefined,
          projectId,
          selection: patch.selection === undefined ? job.selection : patch.selection ?? undefined,
          mode: patch.mode === undefined ? job.mode : patch.mode ?? undefined,
          workspace: patch.workspace === undefined ? job.workspace : patch.workspace ?? undefined
        }
        const touchesOptions = ['selection', 'mode', 'workspace', 'threadId'].some((key) => (patch as Record<string, unknown>)[key] !== undefined)
        const checked = touchesOptions ? schedules.validate(merged) : {}
        const limits = executable ? schedules.limits(ctx.caller) : undefined
        const changes: Partial<ScheduledJob> = {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
          ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
          ...(patch.threadId !== undefined ? { threadId: patch.threadId ?? undefined, projectId } : {}),
          ...(patch.selection !== undefined ? { selection: patch.selection === null ? undefined : checked.selection ?? patch.selection } : {}),
          ...(patch.mode !== undefined ? { mode: patch.mode ?? undefined } : {}),
          ...(patch.workspace !== undefined ? { workspace: patch.workspace ?? undefined } : {}),
          ...(patch.repeat !== undefined && patch.repeat !== null ? { repeat: { times: patch.repeat.times, completed: job.repeat?.completed ?? 0 } } : {}),
          // Whatever the job could do before, it can do no more now: its limits are the narrower of what it had (a job
          // with none reads as the narrowest access) and what this caller holds. They are never raised.
          ...(limits
            ? {
                accessCap: narrowAgentAccess(job.accessCap ?? 'lineage', limits.accessCap) ?? 'lineage',
                ...permissionFieldsAfterAgentEdit(job, limits.permissionCeiling)
              }
            : {})
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
        'Pause a scheduled job your thread created, so it starts no further runs (needs the manage agent access level and "Agents may create jobs" turned on). A run in progress finishes. Only a person resumes a paused job.',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string' }, reason: { type: 'string', description: 'Shown next to the paused job.' } },
        required: ['jobId']
      },
      class: 'mutation',
      handler: (args, ctx) => {
        if (!enabled()) return { text: switchedOff, isError: true }
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
        'Start a scheduled job your thread created now, as Run now does (needs the manage agent access level, "Agents may create jobs" turned on, and a turn a person started: a job cannot start another). It starts within seconds, runs under the limits recorded on the job, and is refused while the job is running, waits in a queue, is paused, or has ended (a person resumes or extends it). The result is in the job\'s run history: read it with schedule_list.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      class: 'mutation',
      handler: (args, ctx) => {
        if (!enabled()) return { text: switchedOff, isError: true }
        requirePerson(ctx, 'schedule_run')
        const job = findVisible(requiredId(args, 'jobId'), ctx)
        if (isWorkflowPrompt(job.prompt)) return { text: 'This job runs a workflow; an agent does not start those.', isError: true }
        if (planOnly(ctx) && (job.mode ?? 'agent') !== 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start a job that runs in agent mode.')
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
    }
  ]
}
