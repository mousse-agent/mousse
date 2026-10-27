import type {
  CreateScheduledJobInput,
  JobSchedule,
  ScheduledJob,
  ScheduledJobWorkspace,
  ScheduledWebhookDelivery
} from '../../shared/types'
import { isPermissionMode } from '../../shared/permissionMode'
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
            ['ID', 'NAME', 'ENABLED', 'STATE', 'MODEL', 'BY', 'NEXT'],
            ...rows.map((job: ScheduledJob) => [
              job.id.slice(0, 8),
              job.name,
              String(job.enabled),
              // An admitted occurrence that has not ended is shown as queued, whatever the job's own state.
              job.pendingOccurrence ? 'queued' : job.state,
              job.selection ? `${job.selection.instanceId ?? job.selection.llmProvider}/${job.selection.model}` : '-',
              // A job an agent created says so (`createdBy`).
              job.createdBy ? 'agent' : '-',
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
      case 'extend': {
        const id = positional[0]
        if (!id) exitWithError('schedule extend requires a job id.', globals.mode)
        const days = flagString(flags, 'days')
        const res = await client.request<{ job: ScheduledJob }>('scheduled.extend', { id, ...(days ? { days: Number(days) } : {}) })
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
      case 'webhook': {
        const action = positional[0]
        const id = positional[1]
        if (!action || !id) exitWithError('schedule webhook requires an action (enable, rotate, disable or deliveries) and a job id.', globals.mode)
        switch (action) {
          case 'enable': {
            const port = flagString(flags, 'port')
            const res = await client.request<WebhookSecretResult>('scheduled.webhook.enable', { id, ...(port ? { port: Number(port) } : {}) })
            writeOutput(globals.mode, webhookSecretOutput(res), (data) => formatWebhookSecret(data as WebhookSecretOutput, 'enabled'))
            break
          }
          case 'rotate': {
            const res = await client.request<WebhookSecretResult>('scheduled.webhook.rotate', { id })
            writeOutput(globals.mode, webhookSecretOutput(res), (data) => formatWebhookSecret(data as WebhookSecretOutput, 'rotated'))
            break
          }
          case 'disable': {
            await client.request('scheduled.webhook.disable', { id })
            writeOutput(globals.mode, { disabled: id })
            break
          }
          case 'deliveries': {
            const res = await client.request<{ deliveries: ScheduledWebhookDelivery[] }>('scheduled.webhook.deliveries', { id })
            writeOutput(globals.mode, res.deliveries, (data) => {
              const rows = data as ScheduledWebhookDelivery[]
              if (rows.length === 0) return 'No webhook requests yet.'
              return formatTable([
                ['RECEIVED', 'OUTCOME', 'BYTES', 'DETAIL'],
                ...rows.map((row) => [row.receivedAt, row.outcome, String(row.bodyBytes), row.error ?? ''])
              ])
            })
            break
          }
          default:
            exitWithError(`Unknown schedule webhook action: ${action}`, globals.mode)
        }
        break
      }
      default:
        exitWithError(`Unknown schedule subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

interface WebhookSecretResult {
  job: ScheduledJob
  /** Absent when the webhook already existed and only the listener's port moved. */
  secret?: string
  url: string
  listening?: boolean
  error?: string
  warning?: string
}

type WebhookSecretOutput = { id: string; url: string; secret?: string; listening?: boolean; error?: string; warning?: string }

/** What `webhook enable|rotate` prints: the secret appears here and nowhere else. */
function webhookSecretOutput(res: WebhookSecretResult): WebhookSecretOutput {
  return {
    id: res.job.id,
    url: res.url,
    ...(res.secret ? { secret: res.secret } : {}),
    ...(res.listening === undefined ? {} : { listening: res.listening }),
    ...(res.error ? { error: res.error } : {}),
    ...(res.warning ? { warning: res.warning } : {})
  }
}

function formatWebhookSecret(out: WebhookSecretOutput, verb: string): string {
  return [
    out.secret ? `Webhook ${verb} for job ${out.id}.` : `Webhook listener updated for job ${out.id}; its secret is unchanged.`,
    `URL:    ${out.url}`,
    ...(out.secret
      ? [
          `Secret: ${out.secret}`,
          'This is the only time the secret is shown; store it now. Sign "<unix seconds>.<raw body>" with HMAC-SHA256 and send',
          'X-Mousse-Timestamp: <unix seconds> and X-Mousse-Signature: sha256=<hex> (see docs/CLI.md).'
        ]
      : []),
    ...(out.listening === false ? [`The listener is not running: ${out.error ?? 'unknown error'}`] : []),
    ...(out.warning ? [out.warning] : [])
  ].join('\n')
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
  const permission = flagString(flags, 'permission')
  if (permission !== undefined) {
    if (!isPermissionMode(permission)) throw new Error('--permission must be ask, accept_edits or full.')
    input.permissionMode = permission
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
