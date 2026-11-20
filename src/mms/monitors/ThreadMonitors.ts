import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'
import { MAX_WATCHER_MINUTES } from '../bots/watchers'
import { trackChildProcess } from '../diagnostics/liveCounts'
import { killProcessTree } from '../execution/processTree'
import { atomicWriteFile } from '../integrations/atomicWrite'
import type { MonitorEnd, MonitorEventPayload, MonitorKind } from '../run/types'

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
 * Every limit below is named; nothing caps how many run at once.
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
/** Events this close to each other are one notice; a stream that never pauses is still told this often. */
export const MONITOR_BATCH_MS = 200
export const MONITOR_BATCH_MAX_MS = 2_000
/** Characters of one event (a line or a message), and of all events in one notice; the rest are counted, not shown. */
export const MONITOR_EVENT_CHARS = 1_000
export const MONITOR_NOTICE_CHARS = 4_000
/** A monitor is over-chatty, and stopped, past this many events or notices in a minute. */
export const MONITOR_CHATTY_EVENTS_PER_MINUTE = 600
export const MONITOR_CHATTY_NOTICES_PER_MINUTE = 30
/** The end of a background command's output its end notice shows. */
export const BACKGROUND_TAIL_CHARS = 4_000
/** Most characters of a description, a command and a URL. */
export const MONITOR_DESCRIPTION_CHARS = 120
export const MONITOR_COMMAND_CHARS = 8_000
export const MONITOR_URL_CHARS = 2_000
/** How long a WebSocket may take to open, and the largest message it takes. */
export const MONITOR_CONNECT_TIMEOUT_MS = 15_000
export const MONITOR_MESSAGE_BYTES = 1_000_000
/** How long a stopped script has to end before its tree is killed outright. */
export const MONITOR_KILL_GRACE_MS = 3_000

const CHATTY_WINDOW_MS = 60_000
const LATEST_CHARS = 200
/** Request keys remembered for retries (`clientRequestId`). */
const REMEMBERED_REQUESTS = 500

export class MonitorInputError extends Error {}

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
export interface MonitorSocket {
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  terminate(): void
}

export interface ThreadMonitorsDeps {
  /** Puts a notice in the thread's inbox; `key` names it, so the same notice is never posted twice. */
  post(threadId: string, payload: MonitorEventPayload, key: string): void
  /** Whether the thread has anything running here, so it shows as Working (`ThreadRuntimeManager.setPendingMonitors`). */
  working?(threadId: string, active: boolean): void
  /** Where the running ones are recorded, so a restart can tell their threads they ended. */
  recordFile?: string
  /** Whether a thread still exists (a leftover of a deleted one gets no notice). */
  threadExists?(threadId: string): boolean
  /** A script's environment; default this process's. */
  env?: () => NodeJS.ProcessEnv
  spawn?: (command: string, options: SpawnOptions) => ChildProcess
  connect?: (url: string) => MonitorSocket
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
}

interface Entry {
  id: string
  threadId: string
  kind: MonitorKind
  description: string
  command?: string
  url?: string
  cwd?: string
  startedAt: number
  minutes: number
  child?: ChildProcess
  socket?: MonitorSocket
  /** An unfinished last line of each stream. */
  partial: { out: string; err: string }
  /** A background command's last output. */
  tail: string
  batch: string[]
  batchChars: number
  dropped: number
  batchStarted: number
  batchTimer?: ReturnType<typeof setTimeout>
  eventTimes: number[]
  noticeTimes: number[]
  timer?: ReturnType<typeof setTimeout>
  ended: boolean
  seq: number
  events: number
  latest?: { line: string; at: number }
}

interface RecordRow {
  id: string
  threadId: string
  kind: MonitorKind
  description: string
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

function messageText(data: unknown, isBinary: boolean): string {
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(String(data))
  return isBinary ? `[binary message, ${buffer.length} bytes]` : buffer.toString('utf8')
}

function defaultConnect(url: string): MonitorSocket {
  return new WebSocket(url, { handshakeTimeout: MONITOR_CONNECT_TIMEOUT_MS, maxPayload: MONITOR_MESSAGE_BYTES, followRedirects: false })
}

export class ThreadMonitors {
  private readonly entries = new Map<string, Entry>()
  private readonly requests = new Map<string, MonitorView>()
  /** What the record held when this process started: the previous one's, not told yet. */
  private leftovers: RecordRow[] = []
  private readonly loaded: Promise<void>
  private writing: Promise<void>
  private closed = false

  constructor(private readonly deps: ThreadMonitorsDeps) {
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
      const entry = this.entry({ threadId: input.threadId, kind: 'command', description, command, cwd: input.cwd, minutes })
      return this.started(entry, input.requestKey, () => this.spawn(entry))
    }
    const problem = monitorUrlProblem(url!)
    if (problem) throw new MonitorInputError(problem)
    const entry = this.entry({ threadId: input.threadId, kind: 'url', description, url: url!, minutes })
    return this.started(entry, input.requestKey, () => this.connect(entry))
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
    const entry = this.entry({ threadId: input.threadId, kind: 'background', description, command, cwd: input.cwd, minutes })
    return this.started(entry, input.requestKey, () => this.spawn(entry))
  }

  /** Keeps the thread showing as Working for `minutes`, for `reason`. */
  keepWorking(input: { threadId: string; reason: string; minutes?: unknown; requestKey?: string }): MonitorView & { replayed?: true } {
    const replay = this.replayed(input.requestKey)
    if (replay) return replay
    const description = this.description(input.reason, 'reason')
    const minutes = monitorMinutes(input.minutes, KEEP_WORKING_DEFAULT_MINUTES, KEEP_WORKING_MAX_MINUTES)
    const entry = this.entry({ threadId: input.threadId, kind: 'keep_working', description, minutes })
    return this.started(entry, input.requestKey, () => undefined)
  }

  private description(value: string, name = 'description'): string {
    const text = (value ?? '').replace(/\s+/g, ' ').trim()
    if (!text) throw new MonitorInputError(`A short ${name} is required: the user sees it.`)
    return cut(text, MONITOR_DESCRIPTION_CHARS)
  }

  private replayed(requestKey: string | undefined): (MonitorView & { replayed: true }) | undefined {
    const known = requestKey ? this.requests.get(requestKey) : undefined
    if (!known) return undefined
    const running = this.entries.get(known.id)
    return { ...(running ? this.view(running) : known), replayed: true }
  }

  private entry(input: Pick<Entry, 'threadId' | 'kind' | 'description' | 'command' | 'url' | 'cwd' | 'minutes'>): Entry {
    const prefix = input.kind === 'background' ? 'bg' : input.kind === 'keep_working' ? 'kw' : 'mon'
    return {
      ...input,
      id: `${prefix}-${randomUUID().slice(0, 8)}`,
      startedAt: Date.now(),
      partial: { out: '', err: '' },
      tail: '',
      batch: [],
      batchChars: 0,
      dropped: 0,
      batchStarted: 0,
      eventTimes: [],
      noticeTimes: [],
      ended: false,
      seq: 0,
      events: 0
    }
  }

  private started(entry: Entry, requestKey: string | undefined, run: () => void): MonitorView {
    if (this.closed) throw new MonitorInputError('Mousse is shutting down.')
    this.entries.set(entry.id, entry)
    try {
      run()
    } catch (error) {
      this.entries.delete(entry.id)
      throw new MonitorInputError(`It could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (entry.ended) return this.view(entry)
    const timer = setTimeout(() => this.end(entry, { reason: 'timeout', minutes: entry.minutes }, 'needed'), entry.minutes * 60_000)
    timer.unref?.()
    entry.timer = timer
    const view = this.view(entry)
    if (requestKey) {
      this.requests.set(requestKey, view)
      if (this.requests.size > REMEMBERED_REQUESTS) this.requests.delete(this.requests.keys().next().value!)
    }
    this.deps.working?.(entry.threadId, true)
    this.persist()
    return view
  }

  private spawn(entry: Entry): void {
    const windows = (this.deps.platform ?? process.platform) === 'win32'
    const child = (this.deps.spawn ?? nodeSpawn)(entry.command!, {
      cwd: entry.cwd,
      env: this.deps.env?.() ?? process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a stop ends everything it started.
      detached: !windows
    })
    entry.child = child
    if (child.pid !== undefined) trackChildProcess(child, entry.kind === 'background' ? 'thread_background' : 'thread_monitor')
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk: Buffer | string) => this.output(entry, 'out', String(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => this.output(entry, 'err', String(chunk)))
    child.once('error', (error) => this.end(entry, { reason: 'failed', message: error.message }, 'needed'))
    child.once('close', (code, signal) => {
      // A monitor's last line with no newline still counts.
      for (const stream of ['out', 'err'] as const) {
        if (entry.partial[stream] && entry.kind !== 'background') this.event(entry, entry.partial[stream])
        entry.partial[stream] = ''
      }
      this.end(entry, { reason: 'exit', code, ...(signal ? { signal } : {}) }, 'needed')
    })
  }

  private connect(entry: Entry): void {
    const socket = (this.deps.connect ?? defaultConnect)(entry.url!)
    entry.socket = socket
    socket.on('message', (data, isBinary) => this.event(entry, messageText(data, isBinary)))
    socket.on('error', (error) => this.end(entry, { reason: 'failed', message: error.message || 'the connection failed' }, 'needed'))
    socket.on('close', (code, reason) => {
      const detail = reason?.length ? cut(reason.toString('utf8'), 200) : ''
      this.end(entry, { reason: 'closed', code, ...(detail ? { detail } : {}) }, 'needed')
    })
  }

  // ---------------------------------------------------------------- events

  private output(entry: Entry, stream: 'out' | 'err', text: string): void {
    if (entry.ended) return
    if (entry.kind === 'background') {
      entry.tail = (entry.tail + text).slice(-BACKGROUND_TAIL_CHARS)
      const last = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
      if (last) entry.latest = { line: cut(last, LATEST_CHARS), at: Date.now() }
      return
    }
    const lines = (entry.partial[stream] + text).split(/\r?\n/)
    entry.partial[stream] = (lines.pop() ?? '').slice(-MONITOR_EVENT_CHARS * 4)
    for (const line of lines) {
      this.event(entry, line)
      if (entry.ended) return
    }
  }

  private event(entry: Entry, raw: string): void {
    if (entry.ended || !raw.trim()) return
    const now = Date.now()
    const text = cut(raw.replace(/\s+$/, ''), MONITOR_EVENT_CHARS)
    entry.events += 1
    entry.latest = { line: cut(text.replace(/\s+/g, ' ').trim(), LATEST_CHARS), at: now }
    if (entry.batch.length === 0 && entry.dropped === 0) entry.batchStarted = now
    if (entry.batch.length && entry.batchChars + text.length > MONITOR_NOTICE_CHARS) entry.dropped += 1
    else {
      entry.batch.push(text)
      entry.batchChars += text.length + 1
    }
    if (overLimit(entry.eventTimes, now, MONITOR_CHATTY_EVENTS_PER_MINUTE)) {
      this.end(entry, { reason: 'chatty', limit: `more than ${MONITOR_CHATTY_EVENTS_PER_MINUTE} events in a minute` }, 'needed')
      return
    }
    if (entry.batchTimer) clearTimeout(entry.batchTimer)
    entry.batchTimer = undefined
    if (now - entry.batchStarted >= MONITOR_BATCH_MAX_MS) {
      this.flush(entry)
      return
    }
    entry.batchTimer = setTimeout(() => this.flush(entry), MONITOR_BATCH_MS)
    entry.batchTimer.unref?.()
  }

  /** Sends what the monitor reported since its last notice. */
  private flush(entry: Entry): void {
    if (entry.batchTimer) clearTimeout(entry.batchTimer)
    entry.batchTimer = undefined
    if (entry.ended || (!entry.batch.length && !entry.dropped)) return
    if (overLimit(entry.noticeTimes, Date.now(), MONITOR_CHATTY_NOTICES_PER_MINUTE)) {
      this.end(entry, { reason: 'chatty', limit: `more than ${MONITOR_CHATTY_NOTICES_PER_MINUTE} notices in a minute` }, 'needed')
      return
    }
    this.post(entry, 'needed')
  }

  private post(entry: Entry, attention: MonitorEventPayload['attention'], end?: MonitorEnd): void {
    const payload: MonitorEventPayload = {
      kind: 'monitor_event',
      monitorId: entry.id,
      monitorKind: entry.kind,
      description: entry.description,
      events: entry.batch,
      ...(entry.dropped ? { droppedEvents: entry.dropped } : {}),
      ...(end ? { end } : {}),
      ...(end && entry.kind === 'background' ? { tail: entry.tail } : {}),
      attention
    }
    entry.batch = []
    entry.batchChars = 0
    entry.dropped = 0
    entry.seq += 1
    try {
      this.deps.post(entry.threadId, payload, `monitor:${entry.id}:${entry.seq}`)
    } catch (error) {
      console.warn('a monitor notice could not be posted', { monitorId: entry.id, threadId: entry.threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ---------------------------------------------------------------- ending

  /**
   * Ends it once. Its last notice carries what it reported since the one before and how it ended (`silent`: none, for a
   * thread that is gone); a hold is told only when its time runs out.
   */
  private end(entry: Entry, end: MonitorEnd, attention: MonitorEventPayload['attention'] | 'silent'): void {
    if (entry.ended) return
    entry.ended = true
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.batchTimer) clearTimeout(entry.batchTimer)
    entry.batchTimer = undefined
    const wasRunning = this.entries.delete(entry.id)
    const told = attention !== 'silent' && (entry.kind !== 'keep_working' || end.reason === 'timeout')
    if (told) this.post(entry, attention, end)
    if (end.reason !== 'exit') this.kill(entry)
    if (!wasRunning) return
    this.deps.working?.(entry.threadId, this.has(entry.threadId))
    this.persist()
  }

  private kill(entry: Entry): void {
    if (entry.socket) {
      try { entry.socket.terminate() } catch { /* closed already */ }
    }
    const child = entry.child
    const pid = child?.pid
    if (!child || pid === undefined || child.exitCode !== null) return
    const kill = this.deps.kill ?? killProcessTree
    try { kill(pid, 'SIGTERM') } catch { /* gone */ }
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
    }, MONITOR_KILL_GRACE_MS)
    timer.unref?.()
  }

  /** Stops one of the thread's own; its end notice waits for the thread's next turn. Undefined when it is not running. */
  stop(threadId: string, id: string): MonitorView | undefined {
    const entry = this.entries.get(id)
    if (!entry || entry.threadId !== threadId) return undefined
    const view = this.view(entry)
    this.end(entry, { reason: 'stopped' }, 'none')
    return view
  }

  /** Ends the thread's `keep_working` holds; how many. */
  release(threadId: string): number {
    const holds = [...this.entries.values()].filter((entry) => entry.threadId === threadId && entry.kind === 'keep_working')
    for (const hold of holds) this.end(hold, { reason: 'stopped' }, 'none')
    return holds.length
  }

  /**
   * The thread was stopped: everything it runs ends, and it is told with its next turn (never woken for it). `notify`
   * false: the thread is gone, nobody is told.
   */
  stopThread(threadId: string, notify = true): number {
    const own = [...this.entries.values()].filter((entry) => entry.threadId === threadId)
    for (const entry of own) this.end(entry, { reason: 'thread_stopped' }, notify ? 'none' : 'silent')
    return own.length
  }

  /** Mousse is closing: everything ends untold; the record stays, so the next start tells each thread. */
  close(): void {
    this.closed = true
    for (const entry of [...this.entries.values()]) {
      entry.ended = true
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.batchTimer) clearTimeout(entry.batchTimer)
      this.entries.delete(entry.id)
      this.kill(entry)
    }
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

  has(threadId: string): boolean {
    for (const entry of this.entries.values()) if (entry.threadId === threadId) return true
    return false
  }

  /** What runs now, of one thread or all, oldest first. */
  list(threadId?: string): MonitorView[] {
    return [...this.entries.values()].filter((entry) => !threadId || entry.threadId === threadId).sort((a, b) => a.startedAt - b.startedAt).map((entry) => this.view(entry))
  }

  /** The thread's background work at a glance: how many of each run, and the latest event of any. */
  summary(threadId: string): MonitorSummary {
    const own = [...this.entries.values()].filter((entry) => entry.threadId === threadId)
    const latest = own.filter((entry) => entry.latest).sort((a, b) => b.latest!.at - a.latest!.at)[0]
    return {
      monitors: own.filter((entry) => entry.kind === 'command' || entry.kind === 'url').length,
      commands: own.filter((entry) => entry.kind === 'background').length,
      keepWorking: own.filter((entry) => entry.kind === 'keep_working').length,
      ...(latest ? { latest: { id: latest.id, line: latest.latest!.line, at: new Date(latest.latest!.at).toISOString() } } : {})
    }
  }

  /** The scripts and commands that run now, with their process and folder: the running list (`RunningRegistry`). */
  processes(): Array<{ id: string; threadId: string; label: string; command: string; pid?: number; cwd: string; startedAt: number; output: string }> {
    return [...this.entries.values()].filter((entry) => entry.child && entry.cwd).map((entry) => ({
      id: entry.id,
      threadId: entry.threadId,
      label: `${entry.kind === 'background' ? 'Background command' : 'Monitor'} ${entry.id}: ${entry.description}`,
      command: entry.command!,
      ...(entry.child!.pid !== undefined ? { pid: entry.child!.pid } : {}),
      cwd: entry.cwd!,
      startedAt: entry.startedAt,
      output: entry.kind === 'background' ? entry.tail : entry.latest?.line ?? ''
    }))
  }

  private view(entry: Entry): MonitorView {
    return {
      id: entry.id,
      threadId: entry.threadId,
      kind: entry.kind,
      description: entry.description,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      startedAt: new Date(entry.startedAt).toISOString(),
      until: new Date(entry.startedAt + entry.minutes * 60_000).toISOString(),
      events: entry.events,
      ...(entry.latest ? { latest: entry.latest.line } : {}),
      ...(entry.child?.pid !== undefined ? { pid: entry.child.pid } : {})
    }
  }

  // ---------------------------------------------------------------- the record

  /** Writes what runs now (and what the last run left, until it is told), after any write before it. */
  private persist(): void {
    const file = this.deps.recordFile
    if (!file) return
    this.writing = this.writing.then(async () => {
      const rows: RecordRow[] = [
        ...this.leftovers,
        ...[...this.entries.values()].filter((entry) => entry.kind !== 'keep_working').map((entry) => ({ id: entry.id, threadId: entry.threadId, kind: entry.kind, description: entry.description }))
      ]
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

/** Keeps `times` to the last minute, adds `now`, and says whether that is more than `limit`. */
function overLimit(times: number[], now: number, limit: number): boolean {
  times.push(now)
  while (times.length && now - times[0]! >= CHATTY_WINDOW_MS) times.shift()
  return times.length > limit
}

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
