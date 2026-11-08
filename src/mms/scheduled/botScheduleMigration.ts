import type { BotStore } from '../bots/store/BotStore'
import type { ScheduledJob } from '../../shared/types'
import { botJobId, botJobName, botJobThreadGuard, jobScheduleOf } from './botJobs'
import { computeNextRun } from './computeNextRun'
import type { ScheduledJobStore } from './ScheduledJobStore'

/**
 * The one-time move of bots' schedules from `bots.db` (`bot_schedules`, where earlier builds kept them and ticked them
 * with their own scheduler) into the shared scheduled-job store, as automations whose Who is the bot.
 *
 * - Each schedule that is not removed becomes the job `<botId>--<scheduleId>`, keeping its schedule id, its prompt,
 *   who added it, when it was made and its next run as the old scheduler had it. A time edited since its last tick
 *   starts from now, as the old scheduler would have done.
 * - The row in `bots.db` is marked with the job it became (`migrated_at`, `migrated_job_id`), never deleted.
 * - It is idempotent and safe to stop at any point: a job that is already there is never made twice (its id is fixed),
 *   and a row is marked only after its job is saved, so a move cut short is finished by the next one.
 */

/** What the move needs from the shared store: the store itself, or the service over it. */
export interface BotScheduleMoveTarget {
  listJobs(): ScheduledJob[]
  createJob: ScheduledJobStore['createJob']
  deleteJob(id: string): boolean
}

/** The spec the old bot scheduler kept beside each next run: a time edited since then starts from now. */
function oldSpec(when: { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string }): string {
  return when.kind === 'interval' ? JSON.stringify({ kind: 'interval', minutes: when.minutes }) : JSON.stringify({ kind: 'cron', expr: when.expr })
}

export interface BotScheduleMoveResult {
  /** Jobs made now. */
  moved: string[]
  /** Rows whose job was there already (a move cut short, or run again): only marked. */
  marked: string[]
  /** Rows that could not be moved now, with why; they stay as they were and the next start tries again. */
  failed: Array<{ botId: string; scheduleId: string; error: string }>
}

export function migrateBotSchedules(input: { bots: BotStore; jobs: BotScheduleMoveTarget; now?: () => Date }): BotScheduleMoveResult {
  const now = input.now ?? (() => new Date())
  const result: BotScheduleMoveResult = { moved: [], marked: [], failed: [] }
  const rows = input.bots.unmigratedSchedules()
  if (!rows.length) return result
  const states = new Map<string, ReturnType<BotStore['scheduleStates']>>()
  const existing = new Set(input.jobs.listJobs().map((job) => job.id))
  for (const row of rows) {
    const jobId = botJobId(row.botId, row.id)
    try {
      if (!existing.has(jobId)) {
        if (!states.has(row.botId)) states.set(row.botId, input.bots.scheduleStates(row.botId))
        const state = states.get(row.botId)!.find((entry) => entry.scheduleId === row.id)
        const schedule = jobScheduleOf(row.when)
        const kept = state && state.spec === oldSpec(row.when) ? state.nextRunAt : undefined
        input.jobs.createJob({
          name: botJobName(row.prompt),
          prompt: row.prompt,
          schedule,
          threadId: botJobThreadGuard(row.botId),
          bot: { botId: row.botId, scheduleId: row.id, createdBy: row.createdBy }
        }, { id: jobId, nextRunAt: kept ?? computeNextRun(schedule, null, now()), createdAt: row.createdAt })
        existing.add(jobId)
        result.moved.push(jobId)
      } else {
        result.marked.push(jobId)
      }
      input.bots.markScheduleMigrated(row.botId, row.id, jobId, now().toISOString())
    } catch (error) {
      result.failed.push({ botId: row.botId, scheduleId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * Undoes the move: every job a move made is taken out of the shared store and its row in `bots.db` is unmarked, so a
 * build that reads `bot_schedules` has them again. Edits made to those jobs after the move are not copied back (the
 * row keeps the schedule as it was moved). For a downgrade to a build that cannot open a v5 `bots.db`, restore its
 * `bots.db.pre-v5` copy instead.
 */
export function unmigrateBotSchedules(input: { bots: BotStore; jobs: BotScheduleMoveTarget }): string[] {
  const present = new Set(input.jobs.listJobs().map((job) => job.id))
  const undone: string[] = []
  for (const row of input.bots.migratedSchedules()) {
    const jobId = row.migratedJobId ?? botJobId(row.botId, row.id)
    if (present.has(jobId)) input.jobs.deleteJob(jobId)
    input.bots.clearScheduleMigrated(row.botId, row.id)
    undone.push(jobId)
  }
  return undone
}
