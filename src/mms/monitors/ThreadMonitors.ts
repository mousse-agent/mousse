import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { BackgroundJobService, JobInputError, type JobEnd, type JobFinal, type JobInfo, type JobOwner, type JobSocket } from '../background/BackgroundJobService'
import { MAX_WATCHER_MINUTES } from '../bots/watchers'
import { atomicWriteFile } from '../integrations/atomicWrite'
import type { MonitorEnd, MonitorEventPayload, MonitorKind } from '../run/types'

export {
  MONITOR_BATCH_MAX_MS,
  MONITOR_BATCH_MS,
  MONITOR_CHATTY_EVENTS_PER_MINUTE,
  MONITOR_CHATTY_NOTICES_PER_MINUTE,
  MONITOR_CONNECT_TIMEOUT_MS,
  MONITOR_EVENT_CHARS,
  MONITOR_EXIT_DRAIN_MS,
  MONITOR_KILL_GRACE_MS,
  MONITOR_MESSAGE_BYTES,
  MONITOR_NOTICE_CHARS,
  JOB_TAIL_CHARS as BACKGROUND_TAIL_CHARS
} from '../background/BackgroundJobService'

/**
 * What a thread's agent leaves running in the background while it keeps working (issue #1605):
 *
 * - a monitor (`monitor_start`): a shell script whose every printed line is an event, or a WebSocket whose every message
 *   is one. Events that come within `MONITOR_BATCH_MS` of each other reach the agent as one notice;
 * - a background command (`background_run`): one command whose end the agent is told once, with its exit code and the
 *   end of its output;
 * - a `keep_working` hold: nothing runs, the thread only shows as Working until it ends.
 *
 * Each one keeps its thread Working while it runs, and its end always reaches the agent as a notice: the script exited
 * or the socket closed (with the code), it could not start, its time ran out, it printed too much, the agent stopped
 * it, its thread was stopped, or the daemon restarted (told on the next start, from a small record kept per profile).
 * A hold ends quietly unless its time runs out. Notices go to the thread's inbox (`post`), the path agents' notes take.
 * Every limit is named; nothing caps how many run at once. The processes, sockets, batches and output are the shared
 * `BackgroundJobService`'s (a bot's background commands run there too); this keeps what is a thread's: its tools'
 * input, its Working state, its notices and the record a restart reads.
 */

/** A monitor's time limit unless the agent sets one, and the most it may set. */
export const MONITOR_DEFAULT_MINUTES = 10
export const MONITOR_MAX_MINUTES = 30
/** A background command's, as a bot's background commands (`watch_start`). */
export const BACKGROUND_DEFAULT_MINUTES = 30
export const BACKGROUND_MAX_MINUTES = MAX_WATCHER_MINUTES
/** A `keep_working` hold's. */
export const KEEP_WORKING_DEFAULT_MINUTES = 30
export const KEEP_WORKING_MAX_MINUTES = 6 * 60
/** How often at most a new latest line alone tells the app (the composer's status row); a start or an end tells it at once. */
export const MONITOR_CHANGE_THROTTLE_MS = 2_000
/** Most characters of a description, a command and a URL. */
export const MONITOR_DESCRIPTION_CHARS = 120
export const MONITOR_COMMAND_CHARS = 8_000
export const MONITOR_URL_CHARS = 2_000
/** Request keys remembered for retries (`clientRequestId`). */
const REMEMBERED_REQUESTS = 500

export class MonitorInputError extends Error {}

/** How a thread's monitors end on a stop: `silent` tells nobody (the thread is gone, or the agent stopped it). */
type Attention = MonitorEventPayload['attention'] | 'silent'

/** One thing a thread runs in the background, as the tools and the running list show it. */
export interface MonitorView {
  id: string
  threadId: string
  kind: MonitorKind
  description: string
  command?: string
  url?: string
  startedAt: string
  until: string
  /** Events it reported so far (a monitor's lines or messages). */
  events: number
  /** Its last line of output or message, cut. */
  latest?: string
  pid?: number
}

/** A thread's background work at a glance (the composer's status row): counts and the latest event. */
export interface MonitorSummary {
  monitors: number
  commands: number
  keepWorking: number
  latest?: { id: string; line: string; at: string }
}

/** What a socket must do for a URL monitor: `ws`'s client. */
export type MonitorSocket = JobSocket

export interface ThreadMonitorsDeps {
  /** Puts a notice in the thread's inbox; `key` names it, so the same notice is never posted twice. */
  post(threadId: string, payload: MonitorEventPayload, key: string): void
  /** Whether the thread has anything running here, so it shows as Working (`ThreadRuntimeManager.setPendingMonitors`). */
  working?(threadId: string, active: boolean): void
  /** What the thread runs changed (one started or ended, or a new latest line): the app is told (`thread.backgroundWork`). */
  changed?(threadId: string): void
  /** Where the running ones are recorded, so a restart can tell their threads they ended. */
  recordFile?: string
  /** Whether a thread still exists (a leftover of a deleted one gets no notice). */
  threadExists?(threadId: string): boolean
  /** A script's whole environment, chosen by the caller: nothing is taken from this process. */
  env: () => NodeJS.ProcessEnv
  /** The shared background jobs; tests and a lone caller get their own. */
  jobs?: BackgroundJobService
  spawn?: (command: string, options: SpawnOptions) => ChildProcess
  connect?: (url: string) => MonitorSocket
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
}

interface RecordRow {
  id: string
  threadId: string
  kind: MonitorKind
  description: string
}

/**
 * The environment a monitor's script runs with: `env` with the login shell's PATH entries after its own (as the agent's
 * shell commands find them, `sharedShellPath`), so `gh`, `npm` or a Homebrew tool is found when Mousse was opened from
 * the desktop with a short PATH.
 */
export function withShellPath(env: NodeJS.ProcessEnv, entries: readonly string[], platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (!entries.length) return env
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? (platform === 'win32' ? 'Path' : 'PATH')
  const separator = platform === 'win32' ? ';' : ':'
  const own = (env[key] ?? '').split(separator).filter(Boolean)
  return { ...env, [key]: [...new Set([...own, ...entries])].join(separator) }
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Clamps a number of minutes to [1, max]; anything that is not a number is the default. */
export function monitorMinutes(value: unknown, fallback: number, max: number): number {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(minutes, 1), max)
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Why `raw` cannot be a URL monitor's address, or undefined: `wss://` anywhere, `ws://` only on this computer. */
export function monitorUrlProblem(raw: string): string | undefined {
  if (raw.length > MONITOR_URL_CHARS) return `Keep url to ${MONITOR_URL_CHARS} characters.`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'url is not a valid URL.'
  }
  if (url.protocol === 'wss:') return undefined
  if (url.protocol === 'ws:') return loopback(url.hostname) ? undefined : 'ws:// is allowed only for this computer (localhost, 127.0.0.1, [::1]); use wss:// for any other host.'
  return 'url must start with wss:// (or ws:// for localhost).'
}

export class ThreadMonitors {
  private readonly jobs: BackgroundJobService
  /** What this keeps of each job running: the thread's own ones of the shared service. */
  private readonly entries = new Set<string>()
  private readonly requests = new Map<string, MonitorView>()
  /** Threads whose latest line changed and whose app update waits for the throttle. */
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** What the record held when this process started: the previous one's, not told yet. */
  private leftovers: RecordRow[] = []
  private readonly loaded: Promise<void>
  private writing: Promise<void>
  private closed = false

  constructor(private readonly deps: ThreadMonitorsDeps) {
    this.jobs = deps.jobs ?? new BackgroundJobService({
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.connect ? { connect: deps.connect } : {}),
      ...(deps.kill ? { kill: deps.kill } : {}),
      ...(deps.platform ? { platform: deps.platform } : {})
    })
    // Read now, without waiting: a write never runs before it, so it never drops what the last run left.
    this.loaded = deps.recordFile
      ? readFile(deps.recordFile, 'utf8').then((text) => { this.leftovers = parseRecord(text) }, () => undefined)
      : Promise.resolve()
    this.writing = this.loaded
  }

  // ---------------------------------------------------------------- starting

  /** Starts a monitor: a script (`command`) or a WebSocket (`url`). Throws `MonitorInputError` for bad input. */
  startMonitor(input: { threadId: string; description: string; command?: string; url?: string; cwd?: string; timeoutMinutes?: unknown; requestKey?: string }): MonitorView & { replayed?: true } {
    const replay = this.replayed(input.requestKey)
    if (replay) return replay
    const description = this.description(input.description)
    const command = input.command?.trim()
    const url = input.url?.trim()
    if (Boolean(command) === Boolean(url)) throw new MonitorInputError('Give either command or url.')
    const minutes = monitorMinutes(input.timeoutMinutes, MONITOR_DEFAULT_MINUTES, MONITOR_MAX_MINUTES)
    if (command) {
      if (command.length > MONITOR_COMMAND_CHARS) throw new MonitorInputError(`Keep command to ${MONITOR_COMMAND_CHARS} characters.`)
      if (!input.cwd) throw new MonitorInputError('A command monitor needs a project folder, and this thread has none.')
      return this.start({ threadId: input.threadId, kind: 'command', description, command, cwd: input.cwd, minutes }, input.requestKey)
    }
    const problem = monitorUrlProblem(url!)
    if (problem) throw new MonitorInputError(problem)
    return this.start({ threadId: input.threadId, kind: 'url', description, url: url!, minutes }, input.requestKey)
  }

  /** Runs a command in the background; the agent is told once, when it ends. */
  startBackground(input: { threadId: string; description: string; command: string; cwd?: string; timeoutMinutes?: unknown; requestKey?: string }): MonitorView & { replayed?: true } {
    const replay = this.replayed(input.requestKey)
    if (replay) return replay
    const description = this.description(input.description)
    const command = input.command?.trim()
    if (!command) throw new MonitorInputError('A command is required.')
    if (command.length > MONITOR_COMMAND_CHARS) throw new MonitorInputError(`Keep command to ${MONITOR_COMMAND_CHARS} characters.`)
    if (!input.cwd) throw new MonitorInputError('background_run needs a project folder, and this thread has none.')
    const minutes = monitorMinutes(input.timeoutMinutes, BACKGROUND_DEFAULT_MINUTES, BACKGROUND_MAX_MINUTES)
    return this.start({ threadId: input.threadId, kind: 'background', description, command, cwd: input.cwd, minutes }, input.requestKey)
  }

  /** Keeps the thread showing as Working for `minutes`, for `reason`. */
  keepWorking(input: { threadId: string; reason: string; minutes?: unknown; requestKey?: string }): MonitorView & { replayed?: true } {
    const replay = this.replayed(input.requestKey)
    if (replay) return replay
    const description = this.description(input.reason, 'reason')
    const minutes = monitorMinutes(input.minutes, KEEP_WORKING_DEFAULT_MINUTES, KEEP_WORKING_MAX_MINUTES)
    return this.start({ threadId: input.threadId, kind: 'keep_working', description, minutes }, input.requestKey)
  }

  private description(value: string, name = 'description'): string {
    const text = (value ?? '').replace(/\s+/g, ' ').trim()
    if (!text) throw new MonitorInputError(`A short ${name} is required: the user sees it.`)
    return cut(text, MONITOR_DESCRIPTION_CHARS)
  }

  private replayed(requestKey: string | undefined): (MonitorView & { replayed: true }) | undefined {
    const known = requestKey ? this.requests.get(requestKey) : undefined
    if (!known) return undefined
    const running = this.jobs.get(known.id)
    return { ...(running ? this.view(running) : known), replayed: true }
  }

  private start(input: { threadId: string; kind: MonitorKind; description: string; command?: string; url?: string; cwd?: string; minutes: number }, requestKey: string | undefined): MonitorView {
    if (this.closed) throw new MonitorInputError('Mousse is shutting down.')
    let job: JobInfo
    let ended = false
    try {
      job = this.jobs.start({
        idPrefix: input.kind === 'background' ? 'bg' : input.kind === 'keep_working' ? 'kw' : 'mon',
        owner: { kind: 'thread', threadId: input.threadId },
        kind: input.kind,
        label: input.description,
        // The thread's environment, as its caller chose it; the service never falls back to this process's.
        ...(input.command ? { command: input.command, cwd: input.cwd, env: this.deps.env?.() } : {}),
        ...(input.url ? { url: input.url } : {}),
        stream: input.kind === 'command' || input.kind === 'url',
        limitMs: input.minutes * 60_000,
        holdsOwner: true,
        sink: {
          events: (info, batch) => this.post(info, batch.events, batch.dropped, batch.notice, 'needed'),
          latest: () => this.changedLater(input.threadId),
          end: (info, end, final, tag) => {
            ended = true
            this.ended(info, end, final, (tag as Attention | undefined) ?? 'needed')
          }
        }
      })
    } catch (error) {
      if (error instanceof JobInputError) throw new MonitorInputError(error.message)
      throw error
    }
    if (ended) return this.view(job)
    this.entries.add(job.id)
    const view = this.view(job)
    if (requestKey) {
      this.requests.set(requestKey, view)
      if (this.requests.size > REMEMBERED_REQUESTS) this.requests.delete(this.requests.keys().next().value!)
    }
    this.deps.working?.(input.threadId, true)
    this.changed(input.threadId)
    this.persist()
    return view
  }

  // ---------------------------------------------------------------- notices

  private post(job: JobInfo, events: string[], dropped: number, notice: number, attention: MonitorEventPayload['attention'], end?: MonitorEnd, tail?: string): void {
    const threadId = threadOf(job)
    const payload: MonitorEventPayload = {
      kind: 'monitor_event',
      monitorId: job.id,
      monitorKind: job.kind as MonitorKind,
      description: job.label,
      events,
      ...(dropped ? { droppedEvents: dropped } : {}),
      ...(end ? { end } : {}),
      ...(end && job.kind === 'background' ? { tail: tail ?? '' } : {}),
      attention
    }
    try {
      this.deps.post(threadId, payload, `monitor:${job.id}:${notice}`)
    } catch (error) {
      console.warn('a monitor notice could not be posted', { monitorId: job.id, threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * It ended, once. Its last notice carries what it reported since the one before and how it ended (`silent`: none, for
   * a thread that is gone or a stop the agent made); a hold is told only when its time runs out.
   */
  private ended(job: JobInfo, end: JobEnd, final: JobFinal & { notice: number }, attention: Attention): void {
    const threadId = threadOf(job)
    const wasRunning = this.entries.delete(job.id)
    // A thread's monitors carry no match, so their ends are a monitor's.
    const told = attention !== 'silent' && (job.kind !== 'keep_working' || end.reason === 'timeout')
    if (told) this.post(job, final.events, final.dropped, final.notice, attention, end as MonitorEnd, final.tail)
    if (!wasRunning) return
    this.deps.working?.(threadId, this.has(threadId))
    this.changed(threadId)
    this.persist()
  }

  /** Tells the app now, and drops a throttled update still waiting for the thread. */
  private changed(threadId: string): void {
    const timer = this.changeTimers.get(threadId)
    if (timer) clearTimeout(timer)
    this.changeTimers.delete(threadId)
    try {
      this.deps.changed?.(threadId)
    } catch (error) {
      console.warn('a change of background work could not be reported', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A new latest line: the app is told at most every `MONITOR_CHANGE_THROTTLE_MS`. */
  private changedLater(threadId: string): void {
    if (!this.deps.changed || this.changeTimers.has(threadId)) return
    const timer = setTimeout(() => {
      this.changeTimers.delete(threadId)
      if (this.has(threadId)) this.changed(threadId)
    }, MONITOR_CHANGE_THROTTLE_MS)
    timer.unref?.()
    this.changeTimers.set(threadId, timer)
  }

  // ---------------------------------------------------------------- stopping

  /**
   * Stops one of the thread's own (`background_stop`). The agent learns it from the tool's result, so no notice follows:
   * the result carries what it reported since its last notice, and a background command's last output. Undefined when it
   * is not running.
   */
  stop(threadId: string, id: string): (MonitorView & { unreported?: string[]; droppedEvents?: number; tail?: string }) | undefined {
    if (!this.entries.has(id)) return undefined
    const stopped = this.jobs.stop({ kind: 'thread', threadId }, id, { tag: 'silent' })
    if (!stopped) return undefined
    return {
      ...this.view(stopped.info),
      ...(stopped.events.length ? { unreported: stopped.events } : {}),
      ...(stopped.dropped ? { droppedEvents: stopped.dropped } : {}),
      ...(stopped.info.kind === 'background' && stopped.tail.trim() ? { tail: stopped.tail } : {})
    }
  }

  /**
   * The person stopped one from the app: it ends, and the agent is told with its next turn (never woken for it).
   * Undefined when it is not running.
   */
  stopByPerson(threadId: string, id: string): MonitorView | undefined {
    if (!this.entries.has(id)) return undefined
    const stopped = this.jobs.stop({ kind: 'thread', threadId }, id, { tag: 'none' })
    return stopped ? this.view(stopped.info) : undefined
  }

  /** Ends the thread's `keep_working` holds; how many. */
  release(threadId: string): number {
    const holds = this.own(threadId).filter((job) => job.kind === 'keep_working')
    for (const hold of holds) this.jobs.stop({ kind: 'thread', threadId }, hold.id, { tag: 'silent' })
    return holds.length
  }

  /**
   * The thread was stopped: everything it runs ends, and it is told with its next turn (never woken for it). `notify`
   * false: the thread is gone, nobody is told, and none of its output is kept.
   */
  stopThread(threadId: string, notify = true): number {
    return this.jobs.stopOwner({ kind: 'thread', threadId }, { end: { reason: 'thread_stopped' }, tag: notify ? 'none' : 'silent', forget: !notify }).length
  }

  /** Mousse is closing: everything ends untold; the record stays, so the next start tells each thread. */
  close(): void {
    this.closed = true
    for (const timer of this.changeTimers.values()) clearTimeout(timer)
    this.changeTimers.clear()
    this.entries.clear()
    this.jobs.closeWhere((owner) => owner.kind === 'thread')
  }

  /** After the daemon is ready: tells each thread whose monitors the last run left that they ended. */
  async recoverOnBoot(): Promise<number> {
    await this.loaded
    const leftovers = this.leftovers
    this.leftovers = []
    let told = 0
    for (const row of leftovers) {
      if (this.deps.threadExists && !this.deps.threadExists(row.threadId)) continue
      const payload: MonitorEventPayload = { kind: 'monitor_event', monitorId: row.id, monitorKind: row.kind, description: row.description, events: [], end: { reason: 'restart' }, attention: 'needed' }
      try {
        this.deps.post(row.threadId, payload, `monitor:${row.id}:restart`)
        told += 1
      } catch (error) {
        console.warn('a monitor\'s restart notice could not be posted', { monitorId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (leftovers.length) this.persist()
    return told
  }

  // ---------------------------------------------------------------- reading

  /** The thread's (or every thread's) jobs running now, oldest first. */
  private own(threadId?: string): JobInfo[] {
    return this.jobs.list(threadId ? { kind: 'thread', threadId } : 'thread').filter((job) => this.entries.has(job.id))
  }

  has(threadId: string): boolean {
    return this.own(threadId).length > 0
  }

  /** What runs now, of one thread or all, oldest first. */
  list(threadId?: string): MonitorView[] {
    return this.own(threadId).map((job) => this.view(job))
  }

  /** The thread's background work at a glance: how many of each run, and the latest event of any. */
  summary(threadId: string): MonitorSummary {
    const own = this.own(threadId)
    const latest = own.filter((job) => job.latest).sort((a, b) => b.latest!.at - a.latest!.at)[0]
    return {
      monitors: own.filter((job) => job.kind === 'command' || job.kind === 'url').length,
      commands: own.filter((job) => job.kind === 'background').length,
      keepWorking: own.filter((job) => job.kind === 'keep_working').length,
      ...(latest ? { latest: { id: latest.id, line: latest.latest!.line, at: new Date(latest.latest!.at).toISOString() } } : {})
    }
  }

  /** The scripts and commands that run now, with their process and folder: the running list (`RunningRegistry`). */
  processes(): Array<{ id: string; threadId: string; label: string; command: string; pid?: number; cwd: string; startedAt: number; output: string }> {
    return this.own().filter((job) => job.command && job.cwd).map((job) => ({
      id: job.id,
      threadId: threadOf(job),
      label: `${job.kind === 'background' ? 'Background command' : 'Monitor'} ${job.id}: ${job.label}`,
      command: job.command!,
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      cwd: job.cwd!,
      startedAt: job.startedAt,
      output: job.kind === 'background' ? job.tail : job.latest?.line ?? ''
    }))
  }

  private view(job: JobInfo): MonitorView {
    return {
      id: job.id,
      threadId: threadOf(job),
      kind: job.kind as MonitorKind,
      description: job.label,
      ...(job.command ? { command: job.command } : {}),
      ...(job.url ? { url: job.url } : {}),
      startedAt: new Date(job.startedAt).toISOString(),
      until: new Date(job.startedAt + job.limitMs).toISOString(),
      events: job.events,
      ...(job.latest ? { latest: job.latest.line } : {}),
      ...(job.pid !== undefined ? { pid: job.pid } : {})
    }
  }

  // ---------------------------------------------------------------- the record

  /** Writes what runs now (and what the last run left, until it is told), after any write before it. */
  private persist(): void {
    const file = this.deps.recordFile
    if (!file) return
    // What runs now, taken when asked: a write that waits behind another still writes what ran then, never what a
    // `close()` in between left (nothing), so a restart still tells those threads.
    const running: RecordRow[] = this.own().filter((job) => job.kind !== 'keep_working').map((job) => ({ id: job.id, threadId: threadOf(job), kind: job.kind as MonitorKind, description: job.label }))
    this.writing = this.writing.then(async () => {
      // The last run's leftovers are read only once the old record is loaded, which every write waits for.
      const rows: RecordRow[] = [...this.leftovers, ...running]
      try {
        await atomicWriteFile(file, `${JSON.stringify({ version: 1, monitors: rows })}\n`)
      } catch (error) {
        console.warn('the monitors record could not be written', { error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  /** Resolves once every write asked for so far is done (tests, shutdown). */
  settled(): Promise<void> {
    return this.writing
  }
}

const threadOf = (job: JobInfo): string => (job.owner as Extract<JobOwner, { kind: 'thread' }>).threadId

const KINDS: ReadonlySet<string> = new Set<MonitorKind>(['command', 'url', 'background'])

function parseRecord(text: string): RecordRow[] {
  try {
    const parsed = JSON.parse(text) as { monitors?: unknown }
    if (!Array.isArray(parsed.monitors)) return []
    return parsed.monitors.flatMap((row): RecordRow[] => {
      const value = row as Partial<RecordRow> | null
      if (!value || typeof value.id !== 'string' || typeof value.threadId !== 'string' || typeof value.kind !== 'string' || !KINDS.has(value.kind)) return []
      return [{ id: value.id, threadId: value.threadId, kind: value.kind, description: typeof value.description === 'string' ? value.description : '' }]
    })
  } catch {
    return []
  }
}
