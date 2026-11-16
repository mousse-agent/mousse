import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { killProcessTree } from '../execution/processTree'
import { trackChildProcess } from '../diagnostics/liveCounts'

/**
 * A bot's background watchers (`watch_start`): a command that runs on its own, beside the bot, until it exits, prints a
 * line that matches, or reaches its time limit; then it wakes the bot in its chat with what happened (`BotEngine` keeps
 * each one as a wake on a `watcher` event, so the wake's limits hold). Here: the processes only. They live in this
 * process: a restart ends them (the engine tells the bot). Each runs in a shell, in its own process group where there is
 * one, and is ended with its whole tree.
 */

/** How long a watcher runs unless the bot says otherwise, and the most it may. */
export const DEFAULT_WATCHER_MINUTES = 60
export const MAX_WATCHER_MINUTES = 6 * 60
/** Most characters of the command and the match. */
export const MAX_WATCHER_COMMAND_CHARS = 2_000
export const MAX_WATCHER_MATCH_CHARS = 200
/** Output kept for the wake: its last characters, and only this much of a line is matched or kept. */
const TAIL_CHARS = 4_000
const LINE_CHARS = 500
/** How long a stopped command has to end before its tree is killed outright. */
const KILL_GRACE_MS = 3_000

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

interface Running {
  spec: WatcherSpec
  child: ChildProcess
  startedAt: number
  tail: string
  partial: string
  lastLine?: string
  pattern?: RegExp
  timer: { clear(): void }
  ended: boolean
}

export interface BotWatchersDeps {
  /** Called once per watcher, when it ends for any reason, with the end of its output. */
  onEnd(spec: WatcherSpec, end: WatcherEnd, tail: string): void
  spawn?: (command: string, options: SpawnOptions) => ChildProcess
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
  /** Ends a process tree (tests); default `killProcessTree`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
}

/**
 * Why a pattern can't be a watcher's match, or undefined when it can: it must compile, be short, and have no nested or
 * repeated quantifier on a group and no back-reference, so a line of output can never make it run for long.
 */
export function watcherMatchProblem(pattern: string): string | undefined {
  if (pattern.length > MAX_WATCHER_MATCH_CHARS) return `Keep match to ${MAX_WATCHER_MATCH_CHARS} characters.`
  try {
    new RegExp(pattern)
  } catch (error) {
    return `match is not a regular expression: ${error instanceof Error ? error.message : String(error)}`
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'match may not use back-references.'
  // A group that holds a quantifier and is itself quantified: "(a+)+", "(.*x)*", "(\d{2,})+".
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(pattern)) return 'match may not repeat a group that repeats itself, such as (a+)+.'
  return undefined
}

export class BotWatchers {
  private readonly running = new Map<string, Running>()

  constructor(private readonly deps: BotWatchersDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  has(id: string): boolean {
    return this.running.has(id)
  }

  /** How many run now, of every bot. */
  get size(): number {
    return this.running.size
  }

  /** The watchers running now, of one bot or all, oldest first. */
  list(botId?: string): WatcherView[] {
    return [...this.running.values()]
      .filter((entry) => !botId || entry.spec.botId === botId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => ({
        id: entry.spec.id,
        botId: entry.spec.botId,
        title: entry.spec.title,
        command: entry.spec.command,
        ...(entry.spec.match ? { match: entry.spec.match } : {}),
        startedAt: new Date(entry.startedAt).toISOString(),
        until: new Date(entry.startedAt + entry.spec.limitMs).toISOString(),
        ...(entry.lastLine ? { lastLine: entry.lastLine } : {})
      }))
  }

  /** Starts `spec`'s command. Throws when it can't start (the shell is missing); then `onEnd` is never called. */
  start(spec: WatcherSpec): void {
    if (this.running.has(spec.id)) return
    const windows = (this.deps.platform ?? process.platform) === 'win32'
    const child = (this.deps.spawn ?? nodeSpawn)(spec.command, {
      cwd: spec.cwd,
      env: spec.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so Stop ends everything it started.
      detached: !windows
    })
    if (child.pid !== undefined) trackChildProcess(child, 'bot_watcher')
    const entry: Running = {
      spec,
      child,
      startedAt: this.now(),
      tail: '',
      partial: '',
      ...(spec.match ? { pattern: new RegExp(spec.match) } : {}),
      timer: (this.deps.setTimer ?? defaultTimer)(() => this.end(spec.id, { kind: 'time_limit' }), spec.limitMs),
      ended: false
    }
    this.running.set(spec.id, entry)
    const read = (chunk: Buffer | string) => this.output(entry, typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.once('error', (error) => this.end(spec.id, { kind: 'failed', message: error.message }))
    child.once('close', (code, signal) => {
      // A last line with no newline still counts.
      if (entry.partial) this.line(entry, entry.partial)
      entry.partial = ''
      this.end(spec.id, { kind: 'exit', code, ...(signal ? { signal } : {}) })
    })
  }

  /** Stops a watcher; no wake follows. False when it was not running. */
  stop(id: string): boolean {
    if (!this.running.has(id)) return false
    this.end(id, { kind: 'stopped' })
    return true
  }

  /** Stops every watcher of a bot; their ids. */
  stopBot(botId: string): string[] {
    const ids = [...this.running.values()].filter((entry) => entry.spec.botId === botId).map((entry) => entry.spec.id)
    for (const id of ids) this.stop(id)
    return ids
  }

  /** Mousse is closing: every watcher stops, and none wakes its bot (the next start tells it). */
  close(): void {
    for (const entry of [...this.running.values()]) {
      entry.ended = true
      entry.timer.clear()
      this.running.delete(entry.spec.id)
      this.kill(entry)
    }
  }

  private output(entry: Running, text: string): void {
    if (entry.ended) return
    entry.tail = (entry.tail + text).slice(-TAIL_CHARS)
    const lines = (entry.partial + text).split(/\r?\n/)
    entry.partial = (lines.pop() ?? '').slice(-LINE_CHARS * 4)
    for (const line of lines) {
      this.line(entry, line)
      if (entry.ended) return
    }
  }

  private line(entry: Running, raw: string): void {
    const line = raw.slice(0, LINE_CHARS)
    if (line.trim()) entry.lastLine = line.trim().slice(0, 200)
    if (entry.pattern?.test(line)) this.end(entry.spec.id, { kind: 'match', line })
  }

  private end(id: string, end: WatcherEnd): void {
    const entry = this.running.get(id)
    if (!entry || entry.ended) return
    entry.ended = true
    entry.timer.clear()
    this.running.delete(id)
    // A command that ended by itself has nothing left to kill.
    if (end.kind !== 'exit') this.kill(entry)
    try {
      this.deps.onEnd(entry.spec, end, entry.tail)
    } catch (error) {
      console.warn('a bot watcher\'s end could not be handled', { watcherId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private kill(entry: Running): void {
    const pid = entry.child.pid
    if (pid === undefined) return
    const kill = this.deps.kill ?? killProcessTree
    try {
      kill(pid, 'SIGTERM')
    } catch {
      // Gone already.
    }
    if (entry.child.exitCode !== null) return
    const timer = setTimeout(() => {
      if (entry.child.exitCode === null) {
        try { kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
  }
}

function defaultTimer(fn: () => void, ms: number): { clear(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { clear: () => clearTimeout(timer) }
}
