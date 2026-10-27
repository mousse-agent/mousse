import type { CreateScheduledJobInput, JobSchedule, ScheduledJob, ScheduledJobWorkspace } from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagBool, flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { closeMmsContext, openMms } from '../mmsContext'
import { SCHEDULE_HELP } from '../help'

export async function runSchedule(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(SCHEDULE_HELP)
    return
  }

  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    switch (subcommand) {
      case 'list': {
        const res = await client.request<{ jobs: ScheduledJob[] }>('scheduled.list')
        const jobs = res.jobs
        writeOutput(globals.mode, jobs, (data) => {
          const rows = data as ScheduledJob[]
          if (rows.length === 0) return 'No scheduled jobs.'
          return formatTable([
            ['ID', 'NAME', 'ENABLED', 'STATE', 'MODEL', 'NEXT'],
            ...rows.map((job: ScheduledJob) => [
              job.id.slice(0, 8),
              job.name,
              String(job.enabled),
              // An admitted occurrence that has not ended is shown as queued, whatever the job's own state.
              job.pendingOccurrence ? 'queued' : job.state,
              job.selection ? `${job.selection.instanceId ?? job.selection.llmProvider}/${job.selection.model}` : '-',
              job.nextRunAt ?? '-'
            ])
          ])
        })
        break
      }
      case 'add': {
        const name = flagString(flags, 'name') ?? positional[0]
        const prompt = flagString(flags, 'prompt') ?? positional[1]
        if (!name || !prompt) {
          exitWithError('schedule add requires --name and --prompt.', globals.mode)
        }
        const schedule = parseSchedule(flags, globals.mode)
        let input: CreateScheduledJobInput
        try {
          input = buildScheduleAddInput(name, prompt, schedule, flags)
        } catch (error) {
          exitWithError(error instanceof Error ? error.message : String(error), globals.mode)
        }
        const res = await client.request<{ job: ScheduledJob }>('scheduled.create', { input })
        writeOutput(globals.mode, res.job)
        break
      }
      case 'remove': {
        const id = positional[0]
        if (!id) exitWithError('schedule remove requires a job id.', globals.mode)
        const res = await client.request<{ ok: boolean }>('scheduled.delete', { id })
        if (!res.ok) exitWithError(`Job not found: ${id}`, globals.mode)
        writeOutput(globals.mode, { removed: id })
        break
      }
      case 'run': {
        const id = positional[0]
        if (!id) exitWithError('schedule run requires a job id.', globals.mode)
        const res = await client.request<{ job: ScheduledJob | null }>('scheduled.run', {
          id
        })
        if (!res.job) exitWithError(`Job not found: ${id}`, globals.mode)
        writeOutput(globals.mode, res.job)
        break
      }
      case 'enable': {
        const id = positional[0]
        if (!id) exitWithError('schedule enable requires a job id.', globals.mode)
        await client.request('scheduled.update', { id, patch: { enabled: true } })
        const res = await client.request<{ job: ScheduledJob }>('scheduled.resume', { id })
        writeOutput(globals.mode, res.job)
        break
      }
      case 'disable': {
        const id = positional[0]
        if (!id) exitWithError('schedule disable requires a job id.', globals.mode)
        const res = await client.request<{ job: ScheduledJob }>('scheduled.update', {
          id,
          patch: { enabled: false }
        })
        writeOutput(globals.mode, res.job)
        break
      }
      default:
        exitWithError(`Unknown schedule subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

/**
 * The `scheduled.create` input for `schedule add`. The selection names the instance and model only: the
 * profile fills in the provider when it resolves them. `--mode` is also the global output format
 * (`text|json`), so only `agent` and `plan` are the job's mode.
 */
export function buildScheduleAddInput(
  name: string,
  prompt: string,
  schedule: JobSchedule,
  flags: ParsedArgs['flags']
): CreateScheduledJobInput {
  const input: CreateScheduledJobInput = { name, prompt, schedule }
  const instance = flagString(flags, 'instance')
  const model = flagString(flags, 'model')
  if (instance || model) {
    if (!instance || !model) throw new Error('--instance and --model go together.')
    input.selection = { instanceId: instance, model } as CreateScheduledJobInput['selection']
  }
  const mode = flagString(flags, 'mode')
  if (mode !== undefined && mode !== 'text' && mode !== 'json') {
    if (mode !== 'agent' && mode !== 'plan') throw new Error('--mode must be agent or plan.')
    input.mode = mode
  }
  const workspace = flagString(flags, 'workspace')
  if (workspace !== undefined) input.workspace = parseWorkspace(workspace)
  const project = flagString(flags, 'project')
  if (project) input.projectId = project
  const thread = flagString(flags, 'thread')
  if (thread) input.threadId = thread
  return input
}

/** `project`, `new-worktree`, or the path of an existing worktree. */
function parseWorkspace(value: string): ScheduledJobWorkspace {
  if (value === 'project') return { kind: 'project' }
  if (value === 'new-worktree') return { kind: 'newWorktree' }
  return { kind: 'worktree', path: value }
}

function parseSchedule(
  flags: ParsedArgs['flags'],
  mode: ParsedArgs['globals']['mode']
): JobSchedule {
  const cron = flagString(flags, 'cron')
  const every = flagString(flags, 'every')
  if (flagBool(flags, 'manual')) return { kind: 'manual' }
  if (cron) return { kind: 'cron', expr: cron }
  if (every) {
    const minutes = Number(every)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      exitWithError('--every must be a positive number of minutes.', mode)
    }
    return { kind: 'interval', minutes }
  }
  exitWithError('Provide --cron, --every or --manual for schedule.', mode)
  return { kind: 'interval', minutes: 60 }
}
