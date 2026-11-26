import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { MonitorEnd } from '../../shared/backgroundWork'
import { trackChildProcess } from '../diagnostics/liveCounts'
import { killProcessTree } from '../execution/processTree'
import { countLineBreaks } from '../terminals/terminalText'

/**
 * Everything an agent or a bot leaves running in the background, in one service: a thread's monitors, background
 * commands and `keep_working` holds (`ThreadMonitors`), and a bot's background commands (`BotWatchers`). Those two keep
 * their tools, their records and where their ends go; this owns what they share:
 *
 * - starting a command in a shell, in its own process group where there is one, and ending its whole tree (SIGTERM,
 *   then SIGKILL after a grace), or opening a WebSocket. On macOS and Linux only the group is signalled, and only while
 *   it is known to be alive (its leader not reaped yet, or a process still in it), so a reused process id is never hit;
 * - when a command that exits by itself counts as ended, and whether what it left running ends with it (`leftBehind`);
 * - the environment: a command runs with exactly the one its caller gives (`JobSpec.env`), never this process's own;
 *   a command started without one is refused;
 * - reading its output: a line that matches `match` ends it; with `stream`, every line (or socket message) is an event,
 *   and events close together reach the owner as one batch, with a stop for a job that is too chatty;
 * - keeping its output (the last `JOB_OUTPUT_CHARS`, and how many lines fell out, which `terminalPage` pages) and the
 *   end of it (`JOB_TAIL_CHARS`), while it runs and for `ENDED_JOB_KEEP_MS` after it ended (the last
 *   `MAX_ENDED_JOBS_PER_OWNER` of each owner); an ended job's output goes when its time is up, read or not;
 * - its time limit, and a stop that hands back what it printed since its last batch (the stop tail).
 *
 * Who it belongs to (`JobOwner`) decides one thing here: only a thread's job may keep its owner Working (`holdsOwner`).
 * A bot's job never does: the bot's chat has one slot, and a command that held it would stop the owner's next message
 * being answered, so a bot's job is always detached and its end comes back as a wake.
 */

/** Events this close to each other are one batch; a stream that never pauses is still sent this often. */
export const MONITOR_BATCH_MS = 200
export const MONITOR_BATCH_MAX_MS = 2_000
/** Characters of one event (a line or a message), and of all events in one batch; the rest are counted, not shown. */
export const MONITOR_EVENT_CHARS = 1_000
export const MONITOR_NOTICE_CHARS = 4_000
/** A streaming job is over-chatty, and stopped, past this many events or batches in a minute. */
export const MONITOR_CHATTY_EVENTS_PER_MINUTE = 600
export const MONITOR_CHATTY_NOTICES_PER_MINUTE = 30
/** How long a WebSocket may take to open, and the largest message it takes. */
export const MONITOR_CONNECT_TIMEOUT_MS = 15_000
export const MONITOR_MESSAGE_BYTES = 1_000_000
/** How long a stopped command has to end before its tree is killed outright. */
export const MONITOR_KILL_GRACE_MS = 3_000
/**
 * How long after a command exits its output may still arrive before it counts as ended (something it left holds the
 * pipe), for a job whose leftovers end with it (`leftBehind: 'ended'`).
 */
export const MONITOR_EXIT_DRAIN_MS = 1_000
/** The end of a command's output that its end carries. */
export const JOB_TAIL_CHARS = 4_000
/** All of a command's output that stays readable (`page`): its last characters. */
export const JOB_OUTPUT_CHARS = 256_000
/** A job that ended stays readable this long, the last few of each owner. */
export const ENDED_JOB_KEEP_MS = 6 * 60 * 60 * 1000
export const MAX_ENDED_JOBS_PER_OWNER = 5
/** Most characters of a match, and of a line tested against it. */
export const MAX_MATCH_CHARS = 200
const MATCH_LINE_CHARS = 500
const LATEST_CHARS = 200
const CHATTY_WINDOW_MS = 60_000

export class JobInputError extends Error {}

export type JobOwner = { kind: 'thread'; threadId: string } | { kind: 'bot'; botId: string }
/** A thread's monitor, background command or hold (`MonitorKind`), or a bot's background command. */
export type JobKind = 'command' | 'url' | 'background' | 'keep_working' | 'watcher'
/** How a job ended: a monitor's ends, and a line that matched. */
export type JobEnd = MonitorEnd | { reason: 'match'; line: string }

/** What a job printed and was not sent yet, and the end of its output. */
export interface JobFinal {
  events: string[]
  dropped: number
  tail: string
}

export interface JobInfo {
  id: string
  owner: JobOwner
  kind: JobKind
  label: string
  command?: string
  url?: string
  cwd?: string
  match?: string
  startedAt: number
  limitMs: number
  /** Events reported so far (a streaming job's lines or messages). */
  events: number
  /** Its last line of output or message, cut. */
  latest?: { line: string; at: number }
  pid?: number
  tail: string
}

/** Where a job's events and its end go: the caller's own sink (a thread's inbox, a bot's wake). */
export interface JobSink {
  /** A batch of a streaming job's events; `notice` counts the batches and the end, from 1. */
  events?(job: JobInfo, batch: { events: string[]; dropped: number; notice: number }): void
  /** A new latest line (throttle it yourself). */
  latest?(job: JobInfo): void
  /**
   * Once, when it ends for any reason but `closeWhere`. `final` carries what it printed since its last batch; `tag` is
   * what `stop` was given, so a caller tells its own stops apart.
   */
  end(job: JobInfo, end: JobEnd, final: JobFinal & { notice: number }, tag?: string): void
}

export interface JobSpec {
  /** Its id, when the caller keeps one (a bot's wake id); otherwise `<idPrefix>-<random>`. */
  id?: string
  idPrefix?: string
  owner: JobOwner
  kind: JobKind
  label: string
  /** A command run in a shell from `cwd`, or a WebSocket at `url`; neither for a hold. */
  command?: string
  url?: string
  cwd?: string
  /** A command's whole environment. Required for a command: nothing is taken from this process. */
  env?: NodeJS.ProcessEnv
  /** A regular expression (`matchProblem`): the first line of output it matches ends the job. */
  match?: string
  /** Every line or message is an event, sent in batches. */
  stream?: boolean
  limitMs: number
  /** Keeps its owner Working while it runs (its caller shows it, from `holds`). A thread's only. */
  holdsOwner?: boolean
  /**
   * A command that exits by itself. `ended` (the default; a thread's): output that arrives within
   * `MONITOR_EXIT_DRAIN_MS` of its exit still counts, then the job ends and so does what it left in its process group
   * (`tail -f x &`). `kept` (a bot's): the job ends once its output closes (or at its time limit), and what it left
   * running with its output elsewhere (a daemon it started) keeps running.
   */
  leftBehind?: 'ended' | 'kept'
  sink: JobSink
}

/** What a socket must do for a URL job: `ws`'s client. */
export interface JobSocket {
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  terminate(): void
}

export interface BackgroundJobServiceDeps {
  spawn?: (command: string, options: SpawnOptions) => ChildProcess
  connect?: (url: string) => JobSocket
  /** Signals a command's tree: on macOS and Linux its process group (`-pid`) only; on Windows its tree from `pid`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Whether a process is still in the process group `pid` leads (macOS and Linux). */
  groupAlive?: (pid: number) => boolean
  platform?: NodeJS.Platform
  now?: () => number
  /** The time-limit timer (tests drive it). */
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
}

interface Job extends JobInfo {
  spec: JobSpec
  child?: ChildProcess
  socket?: JobSocket
  pattern?: RegExp
  partial: { out: string; err: string }
  output: string
  droppedLines: number
  batch: string[]
  batchChars: number
  dropped: number
  batchStarted: number
  batchTimer?: ReturnType<typeof setTimeout>
  eventTimes: number[]
  noticeTimes: number[]
  notices: number
  timer?: { clear(): void }
  ended: boolean
}

interface Ended {
  info: JobInfo
  end: JobEnd
  endedAt: number
  output: string
  droppedLines: number
}

/** A kept job's output: running or ended, and how many lines fell out of what is kept. */
export interface JobOutput {
  info: JobInfo
  end?: JobEnd
  endedAt?: number
  output: string
  droppedLines: number
}

const sameOwner = (a: JobOwner, b: JobOwner): boolean => a.kind === b.kind && (a.kind === 'thread' ? a.threadId === (b as { threadId: string }).threadId : a.botId === (b as { botId: string }).botId)
const ownerKey = (owner: JobOwner): string => (owner.kind === 'thread' ? `thread:${owner.threadId}` : `bot:${owner.botId}`)
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Why a pattern can't be a job's match, or undefined when it can: it must compile, be short, and have no nested or
 * repeated quantifier on a group and no back-reference, so a line of output can never make it run for long.
 */
export function matchProblem(pattern: string): string | undefined {
  if (pattern.length > MAX_MATCH_CHARS) return `Keep match to ${MAX_MATCH_CHARS} characters.`
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

function messageText(data: unknown, isBinary: boolean): string {
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(String(data))
  return isBinary ? `[binary message, ${buffer.length} bytes]` : buffer.toString('utf8')
}

function defaultConnect(url: string): JobSocket {
  return new WebSocket(url, { handshakeTimeout: MONITOR_CONNECT_TIMEOUT_MS, maxPayload: MONITOR_MESSAGE_BYTES, followRedirects: false })
}

/** On macOS and Linux only the group: the bare pid may be another process's once the command was reaped. */
function signalTree(pid: number, signal: NodeJS.Signals, windows: boolean): void {
  if (windows) killProcessTree(pid, signal)
  else process.kill(-pid, signal)
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultTimer(fn: () => void, ms: number): { clear(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { clear: () => clearTimeout(timer) }
}

/** Keeps `times` to the last minute, adds `now`, and says whether that is more than `limit`. */
function overLimit(times: number[], now: number, limit: number): boolean {
  times.push(now)
  while (times.length && now - times[0]! >= CHATTY_WINDOW_MS) times.shift()
  return times.length > limit
}

const CHILD_KINDS: Record<JobKind, string> = { command: 'thread_monitor', url: 'thread_monitor', background: 'thread_background', keep_working: 'thread_monitor', watcher: 'bot_watcher' }

export class BackgroundJobService {
  private readonly running = new Map<string, Job>()
  /** Jobs that ended (stopped ones included), oldest first. */
  private ended: Ended[] = []
  /** Drops the oldest ended job's output when its time is up. */
  private pruneTimer: { clear(): void } | undefined

  constructor(private readonly deps: BackgroundJobServiceDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ---------------------------------------------------------------- starting

  /** Starts a job. Throws `JobInputError` when it can't (no environment for a command, a bad match, the shell missing). */
  start(spec: JobSpec): JobInfo {
    const known = spec.id ? this.running.get(spec.id) : undefined
    if (known) return this.info(known)
    if (spec.holdsOwner && spec.owner.kind !== 'thread') throw new JobInputError("A bot's background command never holds its chat: it runs detached and its end comes back as a wake.")
    if (spec.command && spec.url) throw new JobInputError('Give either command or url.')
    // Fail closed: a command without the environment its caller chose would get this process's, secrets and all.
    if (spec.command && (!spec.env || typeof spec.env !== 'object')) throw new JobInputError('A background command needs the environment it runs with.')
    const problem = spec.match ? matchProblem(spec.match) : undefined
    if (problem) throw new JobInputError(problem)
    const job: Job = {
      id: spec.id ?? `${spec.idPrefix ?? 'job'}-${randomUUID().slice(0, 8)}`,
      owner: spec.owner,
      kind: spec.kind,
      label: spec.label,
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.url ? { url: spec.url } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.match ? { match: spec.match, pattern: new RegExp(spec.match) } : {}),
      startedAt: this.now(),
      limitMs: spec.limitMs,
      events: 0,
      tail: '',
      spec,
      partial: { out: '', err: '' },
      output: '',
      droppedLines: 0,
      batch: [],
      batchChars: 0,
      dropped: 0,
      batchStarted: 0,
      eventTimes: [],
      noticeTimes: [],
      notices: 0,
      ended: false
    }
    this.running.set(job.id, job)
    try {
      if (spec.command) this.spawn(job)
      else if (spec.url) this.connect(job)
    } catch (error) {
      this.running.delete(job.id)
      throw new JobInputError(`It could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (job.ended) return this.info(job)
    job.timer = (this.deps.setTimer ?? defaultTimer)(() => this.end(job, { reason: 'timeout', minutes: job.limitMs / 60_000 }), job.limitMs)
    return this.info(job)
  }

  private spawn(job: Job): void {
    const windows = (this.deps.platform ?? process.platform) === 'win32'
    const child = (this.deps.spawn ?? nodeSpawn)(job.command!, {
      cwd: job.cwd,
      env: job.spec.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a stop ends everything it started.
      detached: !windows
    })
    job.child = child
    if (child.pid !== undefined) {
      job.pid = child.pid
      trackChildProcess(child, CHILD_KINDS[job.kind])
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk: Buffer | string) => this.received(job, 'out', String(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => this.received(job, 'err', String(chunk)))
    child.once('error', (error) => this.end(job, { reason: 'failed', message: error.message }))
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
      // A last line with no newline still counts.
      for (const stream of ['out', 'err'] as const) {
        if (job.partial[stream]) this.line(job, job.partial[stream])
        job.partial[stream] = ''
      }
      this.end(job, { reason: 'exit', code, ...(signal ? { signal } : {}) })
    }
    child.once('close', exited)
    // A process it left running (`tail -f x &`) keeps its output open, so `close` would wait for it: the command's exit
    // counts once its last output had time to arrive, and the end then stops what it left. A job that keeps what it
    // left waits for its output to close instead, so a result printed late is never lost.
    if (job.spec.leftBehind === 'kept') return
    child.once('exit', (code, signal) => {
      const drain = setTimeout(() => exited(code, signal), MONITOR_EXIT_DRAIN_MS)
      drain.unref?.()
    })
  }

  private connect(job: Job): void {
    const socket = (this.deps.connect ?? defaultConnect)(job.url!)
    job.socket = socket
    socket.on('message', (data, isBinary) => this.event(job, messageText(data, isBinary)))
    socket.on('error', (error) => this.end(job, { reason: 'failed', message: error.message || 'the connection failed' }))
    socket.on('close', (code, reason) => {
      const detail = reason?.length ? cut(reason.toString('utf8'), 200) : ''
      this.end(job, { reason: 'closed', code, ...(detail ? { detail } : {}) })
    })
  }

  // ---------------------------------------------------------------- output

  private received(job: Job, stream: 'out' | 'err', text: string): void {
    if (job.ended) return
    job.tail = (job.tail + text).slice(-JOB_TAIL_CHARS)
    const all = job.output + text
    if (all.length > JOB_OUTPUT_CHARS) {
      job.droppedLines += countLineBreaks(all.slice(0, all.length - JOB_OUTPUT_CHARS))
      job.output = all.slice(-JOB_OUTPUT_CHARS)
    } else job.output = all
    if (!job.spec.stream && !job.pattern) {
      // Nothing reads its lines: only the latest one is shown.
      const last = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
      if (last) this.latest(job, last)
      return
    }
    const lines = (job.partial[stream] + text).split(/\r?\n/)
    job.partial[stream] = (lines.pop() ?? '').slice(-MONITOR_EVENT_CHARS * 4)
    for (const line of lines) {
      this.line(job, line)
      if (job.ended) return
    }
  }

  private latest(job: Job, line: string): void {
    job.latest = { line: cut(line.replace(/\s+/g, ' ').trim(), LATEST_CHARS), at: this.now() }
    try {
      job.spec.sink.latest?.(this.info(job))
    } catch (error) {
      console.warn('a background job\'s latest line could not be reported', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** One whole line of a command's output: an event of a streaming job, tested against the match. */
  private line(job: Job, raw: string): void {
    if (job.ended) return
    if (job.spec.stream) {
      this.event(job, raw)
      if (job.ended) return
    } else if (raw.trim()) this.latest(job, raw)
    const line = raw.slice(0, MATCH_LINE_CHARS)
    if (job.pattern?.test(line)) this.end(job, { reason: 'match', line })
  }

  private event(job: Job, raw: string): void {
    if (job.ended || !raw.trim()) return
    const now = this.now()
    const text = cut(raw.replace(/\s+$/, ''), MONITOR_EVENT_CHARS)
    job.events += 1
    this.latest(job, text)
    if (job.batch.length === 0 && job.dropped === 0) job.batchStarted = now
    if (job.batch.length && job.batchChars + text.length > MONITOR_NOTICE_CHARS) job.dropped += 1
    else {
      job.batch.push(text)
      job.batchChars += text.length + 1
    }
    if (overLimit(job.eventTimes, now, MONITOR_CHATTY_EVENTS_PER_MINUTE)) {
      this.end(job, { reason: 'chatty', limit: `more than ${MONITOR_CHATTY_EVENTS_PER_MINUTE} events in a minute` })
      return
    }
    if (job.batchTimer) clearTimeout(job.batchTimer)
    job.batchTimer = undefined
    if (now - job.batchStarted >= MONITOR_BATCH_MAX_MS) {
      this.flush(job)
      return
    }
    job.batchTimer = setTimeout(() => this.flush(job), MONITOR_BATCH_MS)
    job.batchTimer.unref?.()
  }

  /** Sends what the job reported since its last batch. */
  private flush(job: Job): void {
    if (job.batchTimer) clearTimeout(job.batchTimer)
    job.batchTimer = undefined
    if (job.ended || (!job.batch.length && !job.dropped)) return
    if (overLimit(job.noticeTimes, this.now(), MONITOR_CHATTY_NOTICES_PER_MINUTE)) {
      this.end(job, { reason: 'chatty', limit: `more than ${MONITOR_CHATTY_NOTICES_PER_MINUTE} notices in a minute` })
      return
    }
    const batch = this.take(job)
    job.notices += 1
    try {
      job.spec.sink.events?.(this.info(job), { ...batch, notice: job.notices })
    } catch (error) {
      console.warn('a background job\'s events could not be sent', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private take(job: Job): { events: string[]; dropped: number } {
    const batch = { events: job.batch, dropped: job.dropped }
    job.batch = []
    job.batchChars = 0
    job.dropped = 0
    return batch
  }

  // ---------------------------------------------------------------- ending

  /** Ends it once: what it printed since its last batch and the end of its output go to its sink with how it ended. */
  private end(job: Job, end: JobEnd, tag?: string): JobFinal | undefined {
    if (job.ended) return undefined
    job.ended = true
    job.timer?.clear()
    if (job.batchTimer) clearTimeout(job.batchTimer)
    job.batchTimer = undefined
    this.running.delete(job.id)
    const final: JobFinal = { ...this.take(job), tail: job.tail }
    job.notices += 1
    this.ended.push({ info: this.info(job), end, endedAt: this.now(), output: job.output, droppedLines: job.droppedLines })
    this.pruneEnded()
    try {
      job.spec.sink.end(this.info(job), end, { ...final, notice: job.notices }, tag)
    } catch (error) {
      console.warn('a background job\'s end could not be handled', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
    }
    // Even after a command exits on its own, what it left in its process group (`tail -f x &`) ends with it, unless its
    // caller keeps what it leaves (a bot's daemon).
    if (!(end.reason === 'exit' && job.spec.leftBehind === 'kept')) this.kill(job)
    return final
  }

  private kill(job: Job): void {
    if (job.socket) {
      try { job.socket.terminate() } catch { /* closed already */ }
    }
    const child = job.child
    const pid = child?.pid
    if (!child || pid === undefined) return
    const running = (): boolean => child.exitCode === null && child.signalCode === null
    const windows = (this.deps.platform ?? process.platform) === 'win32'
    // On macOS and Linux the command leads its own process group, which outlives it when it leaves something behind:
    // the group is signalled whatever ended the command, SIGTERM and then SIGKILL after the grace, each only while the
    // group is known to be alive (its leader not reaped yet, or a process still in it). On Windows a tree is found from
    // its live root only.
    const alive = windows ? running : (): boolean => running() || (this.deps.groupAlive ?? groupAlive)(pid)
    const kill = this.deps.kill ?? ((target: number, signal: NodeJS.Signals) => signalTree(target, signal, windows))
    if (!alive()) return
    try { kill(pid, 'SIGTERM') } catch { /* gone */ }
    const timer = setTimeout(() => {
      if (!alive()) return
      try { kill(pid, 'SIGKILL') } catch { /* gone */ }
    }, MONITOR_KILL_GRACE_MS)
    timer.unref?.()
  }

  /**
   * Stops a running job of `owner`. Its sink is told with `tag` (a caller's own reason, such as a stop nobody is told
   * of), and the result is the stop tail: what it printed since its last batch, and the end of its output. Undefined
   * when it is not running.
   */
  stop(owner: JobOwner, id: string, options: { end?: JobEnd; tag?: string } = {}): (JobFinal & { info: JobInfo }) | undefined {
    const job = this.running.get(id)
    if (!job || !sameOwner(job.owner, owner)) return undefined
    const info = this.info(job)
    const final = this.end(job, options.end ?? { reason: 'stopped' }, options.tag)
    return final ? { ...final, info } : undefined
  }

  /** Stops every running job of `owner`; their ids. `forget`: their kept output goes too. */
  stopOwner(owner: JobOwner, options: { end?: JobEnd; tag?: string; forget?: boolean } = {}): string[] {
    const ids = this.list(owner).map((job) => job.id)
    for (const id of ids) this.stop(owner, id, options)
    if (options.forget) this.ended = this.ended.filter((entry) => !sameOwner(entry.info.owner, owner))
    return ids
  }

  /**
   * Mousse is closing: the jobs `which` picks end and nobody is told (their callers tell their owners at the next start).
   * Their kept output goes too.
   */
  closeWhere(which: (owner: JobOwner) => boolean): void {
    for (const job of [...this.running.values()]) {
      if (!which(job.owner)) continue
      job.ended = true
      job.timer?.clear()
      if (job.batchTimer) clearTimeout(job.batchTimer)
      this.running.delete(job.id)
      this.kill(job)
    }
    this.ended = this.ended.filter((entry) => !which(entry.info.owner))
  }

  // ---------------------------------------------------------------- reading

  has(id: string): boolean {
    return this.running.has(id)
  }

  /** Whether `owner` has a job running that keeps it Working. */
  holds(owner: JobOwner): boolean {
    for (const job of this.running.values()) if (job.spec.holdsOwner && sameOwner(job.owner, owner)) return true
    return false
  }

  get(id: string): JobInfo | undefined {
    const job = this.running.get(id)
    return job ? this.info(job) : undefined
  }

  /** The jobs running now, of one owner, of one kind of owner, or all, oldest first. */
  list(owner?: JobOwner | JobOwner['kind']): JobInfo[] {
    return [...this.running.values()]
      .filter((job) => !owner || (typeof owner === 'string' ? job.owner.kind === owner : sameOwner(job.owner, owner)))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((job) => this.info(job))
  }

  /** All of one of `owner`'s jobs' kept output, while it runs and for a while after it ended; undefined when gone. */
  output(owner: JobOwner, id: string): JobOutput | undefined {
    this.pruneEnded()
    const running = this.running.get(id)
    if (running) return sameOwner(running.owner, owner) ? { info: this.info(running), output: running.output, droppedLines: running.droppedLines } : undefined
    const ended = this.ended.find((entry) => entry.info.id === id && sameOwner(entry.info.owner, owner))
    return ended ? { info: ended.info, end: ended.end, endedAt: ended.endedAt, output: ended.output, droppedLines: ended.droppedLines } : undefined
  }

  /** How many ended jobs' output is kept now, and its characters (diagnostics). */
  keptOutput(): { jobs: number; chars: number } {
    return { jobs: this.ended.length, chars: this.ended.reduce((sum, entry) => sum + entry.output.length, 0) }
  }

  private pruneEnded(): void {
    const now = this.now()
    this.ended = this.ended.filter((entry) => now - entry.endedAt < ENDED_JOB_KEEP_MS)
    const perOwner = new Map<string, number>()
    for (let index = this.ended.length - 1; index >= 0; index--) {
      const key = ownerKey(this.ended[index]!.info.owner)
      const count = (perOwner.get(key) ?? 0) + 1
      perOwner.set(key, count)
      if (count > MAX_ENDED_JOBS_PER_OWNER) this.ended.splice(index, 1)
    }
    // The oldest kept output goes when its time is up, even if nothing ends or is read meanwhile.
    this.pruneTimer?.clear()
    this.pruneTimer = undefined
    const oldest = this.ended.reduce<number | undefined>((at, entry) => (at === undefined || entry.endedAt < at ? entry.endedAt : at), undefined)
    if (oldest === undefined) return
    // Its own timer, not the time-limit one tests drive: nothing waits for it.
    this.pruneTimer = defaultTimer(() => {
      this.pruneTimer = undefined
      this.pruneEnded()
    }, Math.max(1_000, oldest + ENDED_JOB_KEEP_MS - now))
  }

  private info(job: Job): JobInfo {
    return {
      id: job.id,
      owner: job.owner,
      kind: job.kind,
      label: job.label,
      ...(job.command ? { command: job.command } : {}),
      ...(job.url ? { url: job.url } : {}),
      ...(job.cwd ? { cwd: job.cwd } : {}),
      ...(job.match ? { match: job.match } : {}),
      startedAt: job.startedAt,
      limitMs: job.limitMs,
      events: job.events,
      ...(job.latest ? { latest: { ...job.latest } } : {}),
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      tail: job.tail
    }
  }
}
