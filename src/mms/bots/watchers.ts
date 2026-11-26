import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  BackgroundJobService,
  ENDED_JOB_KEEP_MS,
  JOB_OUTPUT_CHARS,
  MAX_ENDED_JOBS_PER_OWNER,
  MAX_MATCH_CHARS,
  matchProblem,
  type JobEnd,
  type JobInfo
} from '../background/BackgroundJobService'

/**
 * A bot's background watchers (`watch_start`): a command that runs on its own, beside the bot, until it exits, prints a
 * line that matches, or reaches its time limit; then it wakes the bot in its chat with what happened (`BotEngine` keeps
 * each one as a wake on a `watcher` event, so the wake's limits hold). Here: the bot's view of its processes, which run
 * in the shared `BackgroundJobService` beside threads' background commands, in exactly the environment the engine gives
 * (`WatcherSpec.env`). A bot's command is always detached: it never holds the bot's chat, and its end comes back as a
 * wake. They live in this process: a restart ends them (the engine tells the bot).
 */

/** How long a watcher runs unless the bot says otherwise, and the most it may. */
export const DEFAULT_WATCHER_MINUTES = 60
export const MAX_WATCHER_MINUTES = 6 * 60
/** Most characters of the command and the match. */
export const MAX_WATCHER_COMMAND_CHARS = 2_000
export const MAX_WATCHER_MATCH_CHARS = MAX_MATCH_CHARS
/** All of a command's output the bot can read (`watch_list` with its id): its last characters. */
export const WATCHER_OUTPUT_CHARS = JOB_OUTPUT_CHARS
/** A command that ended stays readable this long, the last few of each bot. */
export const ENDED_WATCHER_KEEP_MS = ENDED_JOB_KEEP_MS
export const MAX_ENDED_WATCHERS_PER_BOT = MAX_ENDED_JOBS_PER_OWNER

/** How a watcher ended. `stopped`: by the bot, the owner, or the bot going (no wake follows). */
export type WatcherEnd =
  | { kind: 'exit'; code: number | null; signal?: string }
  | { kind: 'match'; line: string }
  | { kind: 'time_limit' }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }

export interface WatcherSpec {
  /** The wake it fires (`bot_reminders.id`). */
  id: string
  botId: string
  title: string
  command: string
  /** A regular expression a line of its output is tested against. */
  match?: string
  limitMs: number
  cwd: string
  /** Its whole environment (`lockedEnv`): nothing else is taken from Mousse's own. */
  env: NodeJS.ProcessEnv
}

export interface WatcherView {
  id: string
  botId: string
  title: string
  command: string
  match?: string
  startedAt: string
  until: string
  /** Its last line of output, cut. */
  lastLine?: string
}

/** A command's output as the bot reads it: running or ended, and how many lines fell out of the kept output. */
export interface WatcherOutput {
  id: string
  title: string
  command: string
  startedAt: string
  /** Absent while it runs. */
  end?: WatcherEnd
  endedAt?: string
  output: string
  droppedLines: number
}

export interface BotWatchersDeps {
  /** Called once per watcher, when it ends for any reason, with the end of its output. */
  onEnd(spec: WatcherSpec, end: WatcherEnd, tail: string): void
  /** The shared background jobs; tests and a lone engine get their own. */
  jobs?: BackgroundJobService
  spawn?: (command: string, options: SpawnOptions) => ChildProcess
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
  /** Ends a process tree (tests); default `killProcessTree`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
}

/** Why a pattern can't be a watcher's match, or undefined when it can (`matchProblem`). */
export const watcherMatchProblem = matchProblem

/** A job's end as a watcher's: a bot's command has no socket and streams nothing, so it never closes or is chatty. */
function watcherEnd(end: JobEnd): WatcherEnd {
  switch (end.reason) {
    case 'exit': return { kind: 'exit', code: end.code, ...(end.signal ? { signal: end.signal } : {}) }
    case 'match': return { kind: 'match', line: end.line }
    case 'timeout': return { kind: 'time_limit' }
    case 'failed': return { kind: 'failed', message: end.message }
    case 'closed': return { kind: 'failed', message: `closed with code ${end.code}` }
    case 'chatty': return { kind: 'failed', message: end.limit }
    default: return { kind: 'stopped' }
  }
}

export class BotWatchers {
  private readonly jobs: BackgroundJobService
  /** Each running watcher's spec, as the engine gave it. */
  private readonly specs = new Map<string, WatcherSpec>()

  constructor(private readonly deps: BotWatchersDeps) {
    this.jobs = deps.jobs ?? new BackgroundJobService({
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.kill ? { kill: deps.kill } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {})
    })
  }

  has(id: string): boolean {
    return this.specs.has(id) && this.jobs.has(id)
  }

  /** How many run now, of every bot. */
  get size(): number {
    return this.own().length
  }

  private own(botId?: string): JobInfo[] {
    return this.jobs.list(botId ? { kind: 'bot', botId } : 'bot').filter((job) => this.specs.has(job.id))
  }

  /** The watchers running now, of one bot or all, oldest first. */
  list(botId?: string): WatcherView[] {
    return this.own(botId).map((job) => {
      const spec = this.specs.get(job.id)!
      return {
        id: spec.id,
        botId: spec.botId,
        title: spec.title,
        command: spec.command,
        ...(spec.match ? { match: spec.match } : {}),
        startedAt: new Date(job.startedAt).toISOString(),
        until: new Date(job.startedAt + job.limitMs).toISOString(),
        ...(job.latest ? { lastLine: job.latest.line } : {})
      }
    })
  }

  /** The watchers running now with their process, folder and the end of their output: the running list (`RunningRegistry`). */
  processes(): Array<{ id: string; botId: string; title: string; command: string; pid?: number; cwd: string; startedAt: number; output: string }> {
    return this.own().map((job) => {
      const spec = this.specs.get(job.id)!
      return { id: spec.id, botId: spec.botId, title: spec.title, command: spec.command, ...(job.pid !== undefined ? { pid: job.pid } : {}), cwd: spec.cwd, startedAt: job.startedAt, output: job.tail }
    })
  }

  /** Starts `spec`'s command, detached. Throws when it can't start (the shell is missing); then `onEnd` is never called. */
  start(spec: WatcherSpec): void {
    if (this.jobs.has(spec.id)) return
    this.specs.set(spec.id, spec)
    try {
      this.jobs.start({
        id: spec.id,
        owner: { kind: 'bot', botId: spec.botId },
        kind: 'watcher',
        label: spec.title,
        command: spec.command,
        cwd: spec.cwd,
        env: spec.env,
        ...(spec.match ? { match: spec.match } : {}),
        limitMs: spec.limitMs,
        // Never `holdsOwner`: the bot's chat has one slot, and a command must not keep it.
        sink: { end: (_job, end, final) => this.ended(spec, watcherEnd(end), final.tail) }
      })
    } catch (error) {
      this.specs.delete(spec.id)
      throw error
    }
  }

  private ended(spec: WatcherSpec, end: WatcherEnd, tail: string): void {
    this.specs.delete(spec.id)
    try {
      this.deps.onEnd(spec, end, tail)
    } catch (error) {
      console.warn("a bot watcher's end could not be handled", { watcherId: spec.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Stops a watcher; no wake follows. False when it was not running. */
  stop(id: string): boolean {
    const spec = this.specs.get(id)
    return Boolean(spec && this.jobs.stop({ kind: 'bot', botId: spec.botId }, id))
  }

  /** Stops every watcher of a bot, and forgets the output of its ended ones; their ids. */
  stopBot(botId: string): string[] {
    return this.jobs.stopOwner({ kind: 'bot', botId }, { forget: true })
  }

  /** All of one of the bot's commands' kept output, while it runs and for a while after it ended; undefined when gone. */
  output(botId: string, id: string): WatcherOutput | undefined {
    const kept = this.jobs.output({ kind: 'bot', botId }, id)
    if (!kept || kept.info.kind !== 'watcher') return undefined
    return {
      id,
      title: kept.info.label,
      command: kept.info.command ?? '',
      startedAt: new Date(kept.info.startedAt).toISOString(),
      ...(kept.end ? { end: watcherEnd(kept.end), endedAt: new Date(kept.endedAt!).toISOString() } : {}),
      output: kept.output,
      droppedLines: kept.droppedLines
    }
  }

  /** Mousse is closing: every watcher stops, and none wakes its bot (the next start tells it). */
  close(): void {
    this.specs.clear()
    this.jobs.closeWhere((owner) => owner.kind === 'bot')
  }
}
