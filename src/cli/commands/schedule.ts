import type { JobSchedule, ScheduledJob } from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { openMms } from '../mmsContext'
import { SCHEDULE_HELP } from '../help'

export async function runSchedule(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(SCHEDULE_HELP)
    return
  }

  const { mms } = await openMms(globals)

  try {
    switch (subcommand) {
      case 'list': {
        const jobs = mms.scheduled.listJobs()
        writeOutput(globals.mode, jobs, (data) => {
          const rows = data as ReturnType<typeof mms.scheduled.listJobs>
          if (rows.length === 0) return 'No scheduled jobs.'
          return formatTable([
            ['ID', 'NAME', 'ENABLED', 'STATE', 'NEXT'],
            ...rows.map((job: ScheduledJob) => [
              job.id.slice(0, 8),
              job.name,
              String(job.enabled),
              job.state,
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
        const job = mms.scheduled.createJob({ name, prompt, schedule })
        writeOutput(globals.mode, job)
        break
      }
      case 'remove': {
        const id = positional[0]
        if (!id) exitWithError('schedule remove requires a job id.', globals.mode)
        const deleted = mms.scheduled.deleteJob(id)
        if (!deleted) exitWithError(`Job not found: ${id}`, globals.mode)
        writeOutput(globals.mode, { removed: id })
        break
      }
      case 'run': {
        const id = positional[0]
        if (!id) exitWithError('schedule run requires a job id.', globals.mode)
        const job = mms.scheduled.triggerJob(id)
        if (!job) exitWithError(`Job not found: ${id}`, globals.mode)
        writeOutput(globals.mode, job)
        break
      }
      case 'enable': {
        const id = positional[0]
        if (!id) exitWithError('schedule enable requires a job id.', globals.mode)
        const job = mms.scheduled.updateJob(id, { enabled: true })
        if (!job) exitWithError(`Job not found: ${id}`, globals.mode)
        mms.scheduled.resumeJob(id)
        writeOutput(globals.mode, job)
        break
      }
      case 'disable': {
        const id = positional[0]
        if (!id) exitWithError('schedule disable requires a job id.', globals.mode)
        const job = mms.scheduled.updateJob(id, { enabled: false })
        if (!job) exitWithError(`Job not found: ${id}`, globals.mode)
        writeOutput(globals.mode, job)
        break
      }
      default:
        exitWithError(`Unknown schedule subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await mms.stop()
  }
}

function parseSchedule(
  flags: Map<string, string | boolean>,
  mode: ParsedArgs['globals']['mode']
): JobSchedule {
  const every = flags.get('every')
  const cron = flags.get('cron')
  const at = flags.get('at')

  if (typeof every === 'string') {
    return { kind: 'interval', minutes: Number(every) }
  }
  if (typeof cron === 'string') {
    return { kind: 'cron', expr: cron }
  }
  if (typeof at === 'string') {
    return { kind: 'once', runAt: at }
  }

  exitWithError('schedule add requires --every, --cron, or --at', mode)
}
