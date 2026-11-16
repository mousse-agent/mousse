import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { BOT_RUNNING_TOOL } from '../../shared/bots/personal/manifest'
import { commandScript } from '../harness/stopProcesses'
import { readListeningPorts, readProcessTable, readWorkingFolders, type ListeningPort, type ProcessRow } from './snapshot'

/**
 * What runs now for a thread's or a bot's folder, so an agent reuses a dev server that is already up instead of
 * starting a second copy on a busy port. Built only when asked (at the start of a turn, and by `running_list`) from:
 *
 * - Mousse's terminals with a command running in them (a quick action's, or one the person typed);
 * - the commands agents left running after their tool call ended (a background shell), noted as threads run them;
 * - bots' background commands (`watch_start`);
 * - any other process that listens on a port and works in the folder (macOS and Linux, which tell a process's folder).
 *
 * Each one's address is the port its processes listen on, or the local address it printed when no port could be read.
 */

/** Who started something that runs. */
export type RunningStarter =
  | { kind: 'person'; via: 'quick_action' | 'terminal' }
  | { kind: 'thread'; threadId: string }
  | { kind: 'bot'; botId: string }
  /** Under Mousse, but no thread is known for it. */
  | { kind: 'agent' }
  | { kind: 'outside' }

export interface RunningEntry {
  /** `terminal:<ptyId>`, `command:<threadId>:<callId>`, `watcher:<id>` or `process:<pid>`. */
  id: string
  /** A quick action's or a background command's label; absent: the command is its name. */
  label?: string
  command: string
  pid: number
  startedBy: RunningStarter
  startedAt?: number
  /** Where it works, when known. */
  folder?: string
  /** Local addresses, the one it printed first: `http://localhost:5173/`. */
  addresses: string[]
}

export interface RunningTerminal {
  ptyId: string
  /** The shell's pid. */
  pid?: number
  threadId: string
  cwd: string
  /** The quick action that opened the terminal. */
  label?: string
}

export interface RunningWatcher {
  id: string
  botId: string
  title: string
  command: string
  pid?: number
  cwd: string
  startedAt: number
  /** The end of its output. */
  output: string
}

export interface RunningThreadInfo {
  title?: string
  projectId?: string
  /** A personal bot's thread: its bot. */
  botId?: string
  parentThreadId?: string
}

export interface RunningSources {
  terminals(): RunningTerminal[]
  /** The end of a terminal's output. */
  terminalOutput(ptyId: string): string
  watchers(): RunningWatcher[]
  thread(threadId: string): RunningThreadInfo | undefined
  botName?(botId: string): string | undefined
}

/** What a list is for: a thread (its folder, its project) or a bot (its folders). */
export interface RunningScope {
  threadId?: string
  /** The folders it works in, its own first. */
  folders: string[]
  projectId?: string
  botId?: string
}

export interface RunningSystem {
  processes(): Promise<ProcessRow[] | undefined>
  listeners(): Promise<ListeningPort[] | undefined>
  workingFolders(pids: readonly number[]): Promise<Map<number, string>>
  /** This service's own process: what it started is Mousse's. */
  selfPid: number
  now(): number
  platform: NodeJS.Platform
}

interface NotedCommand {
  threadId: string
  callId: string
  command: string
  folder?: string
  notedAt: number
  /** When its tool call ended: from then on a process of it still running is a background command. */
  endedAt?: number
}

/** A noted command whose process is no longer found is dropped this long after its call ended. */
const COMMAND_GRACE_MS = 10_000
/** Start times are read to the second: a process may seem to start this much before its call. */
const START_SLACK_MS = 2_000
const MAX_NOTED_PER_THREAD = 40
/** Most addresses shown for one entry. */
const MAX_ADDRESSES = 3
const CONSOLE_HOSTS = /(^|[\\/])(conhost|OpenConsole)\.exe/i
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d+)?(?:\/[^\s'"`<>)\]]*)?/gi
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function defaultRunningSystem(): RunningSystem {
  return {
    processes: () => readProcessTable(),
    listeners: () => readListeningPorts(),
    workingFolders: (pids) => readWorkingFolders(pids),
    selfPid: process.pid,
    now: () => Date.now(),
    platform: process.platform
  }
}

export class RunningRegistry {
  private readonly noted = new Map<string, NotedCommand>()
  /** The read in progress: lists asked for while it runs (several turns starting together) share it. */
  private reading: Promise<Snapshot> | undefined

  constructor(private readonly sources: RunningSources, private readonly system: RunningSystem = defaultRunningSystem()) {}

  /**
   * A command a thread's agent runs (from its tool call), and whether that call has ended. Called as the call's row
   * is written; only the latest state counts.
   */
  noteCommand(input: { threadId: string; callId: string; command: string; folder?: string; ended: boolean }): void {
    const command = input.command.trim()
    if (!command || comparable(commandScript(command)).length < 3) return
    const key = `${input.threadId}:${input.callId}`
    const known = this.noted.get(key)
    const now = this.system.now()
    if (known) {
      known.command = command
      if (input.folder) known.folder = input.folder
      if (input.ended) known.endedAt ??= now
      return
    }
    this.noted.set(key, { threadId: input.threadId, callId: input.callId, command, ...(input.folder ? { folder: input.folder } : {}), notedAt: now, ...(input.ended ? { endedAt: now } : {}) })
    const ofThread = [...this.noted.entries()].filter(([, entry]) => entry.threadId === input.threadId)
    for (const [oldKey] of ofThread.slice(0, Math.max(0, ofThread.length - MAX_NOTED_PER_THREAD))) this.noted.delete(oldKey)
  }

  /** A thread was deleted: what it ran is no longer told as its. */
  forgetThread(threadId: string): void {
    for (const [key, entry] of this.noted) if (entry.threadId === threadId) this.noted.delete(key)
  }

  /** What runs now for `scope`, oldest first. */
  async list(scope: RunningScope): Promise<RunningEntry[]> {
    const folders = scope.folders.map(canonical)
    const inFolders = (folder: string | undefined): boolean => Boolean(folder) && folders.some((root) => isInside(root, canonical(folder!)))
    const threadInScope = (threadId: string, folder: string | undefined): boolean => {
      if (threadId === scope.threadId) return true
      const info = this.sources.thread(threadId)
      if (scope.projectId && info?.projectId === scope.projectId) return true
      if (scope.botId && info?.botId === scope.botId) return true
      return inFolders(folder)
    }
    // Where no process's working folder can be read (Windows), whether anything can be listed for the scope is known
    // before the process table is read: a terminal, a bot's background command or an ended agent command of the scope.
    // With none, the list is empty, and every turn's start is spared the table's read (about half a second there).
    if (this.system.platform === 'win32') {
      const possible =
        this.sources.terminals().some((terminal) => terminal.pid && (terminal.threadId !== '__unbound__' ? threadInScope(terminal.threadId, terminal.cwd) : inFolders(terminal.cwd))) ||
        this.sources.watchers().some((watcher) => watcher.pid && (watcher.botId === scope.botId || inFolders(watcher.cwd))) ||
        [...this.noted.values()].some((command) => command.endedAt !== undefined && threadInScope(command.threadId, command.folder))
      if (!possible) return []
    }
    const snapshot = await this.read()
    if (!snapshot.processes) return []
    const tree = processTree(snapshot.processes)
    const claimed = new Set<number>()
    const entries: RunningEntry[] = []
    const claim = (root: number): void => {
      for (const pid of tree.subtree(root)) claimed.add(pid)
    }
    const now = this.system.now()
    const ours = new Set(tree.subtree(this.system.selfPid))

    // What each candidate is, before any folder is read.
    const terminals = this.sources.terminals()
    const terminalJobs = terminals.flatMap((terminal) => terminal.pid ? terminalJobsOf(tree, terminal.pid, this.system.platform, snapshot.listeners).map((job) => ({ terminal, job })) : [])
    // A terminal's shell and its prompt's helpers are never anything else's: an agent's command or a listener.
    for (const terminal of terminals) if (terminal.pid) claimed.add(terminal.pid)
    for (const { job } of terminalJobs) claim(job.pid)
    const watchers = this.sources.watchers()
    for (const watcher of watchers) if (watcher.pid) claim(watcher.pid)
    const noted = [...this.noted.entries()].sort(([, a], [, b]) => b.notedAt - a.notedAt)
    const commandCandidates = new Map(noted.map(([key, command]) => [key, command.endedAt === undefined ? [] : commandCandidatesOf(tree, this.system.selfPid, command, ours, claimed)]))
    const listening = snapshot.listeners
      ? [...new Set(snapshot.listeners.map((listener) => listener.pid))].filter((pid) => pid !== this.system.selfPid && tree.row(pid) && !tree.isAncestorOf(pid, this.system.selfPid))
      : []
    // Where each one really works, read once for all of them (macOS and Linux; Windows does not tell).
    const cwds = await this.system.workingFolders([...new Set([
      ...terminalJobs.map(({ job }) => job.pid),
      ...[...commandCandidates.values()].flat().map((row) => row.pid),
      ...listening
    ])])

    // Terminals: the command in the foreground of each one's shell, and any other job in it that listens on a port. Its
    // folder is where it runs now (a shell may have changed folder since it opened), else where the terminal opened.
    for (const { terminal, job } of terminalJobs) {
      const folder = cwds.get(job.pid)
      const owner = terminal.threadId === '__unbound__' ? undefined : terminal.threadId
      const inScope = folder !== undefined ? inFolders(folder) || (owner === scope.threadId && owner !== undefined) : owner ? threadInScope(owner, terminal.cwd) : inFolders(terminal.cwd)
      if (!inScope) continue
      entries.push(this.entry(snapshot, tree, job, {
        id: job.pid === terminalJobs.find((entry) => entry.terminal === terminal)?.job.pid ? `terminal:${terminal.ptyId}` : `terminal:${terminal.ptyId}:${job.pid}`,
        ...(terminal.label ? { label: terminal.label } : {}),
        startedBy: { kind: 'person', via: terminal.label ? 'quick_action' : 'terminal' },
        folder: folder ?? terminal.cwd,
        output: () => this.sources.terminalOutput(terminal.ptyId)
      }))
    }

    // Bots' background commands.
    for (const watcher of watchers) {
      if (!watcher.pid || !tree.row(watcher.pid)) continue
      if (watcher.botId !== scope.botId && !inFolders(watcher.cwd)) continue
      entries.push(this.entry(snapshot, tree, tree.row(watcher.pid)!, {
        id: `watcher:${watcher.id}`,
        label: watcher.title,
        command: watcher.command,
        startedBy: { kind: 'bot', botId: watcher.botId },
        folder: watcher.cwd,
        startedAt: watcher.startedAt,
        output: () => watcher.output
      }))
    }

    // Commands agents left running: a process under this service that runs the command, started while its call ran,
    // and working in the call's folder where that can be read. The newest call takes the newest such process, so two
    // threads that run the same command each get their own.
    for (const [key, command] of noted) {
      const found = (commandCandidates.get(key) ?? [])
        .filter((row) => !claimed.has(row.pid))
        .filter((row) => {
          const folder = cwds.get(row.pid)
          return !folder || !command.folder || isInside(canonical(command.folder), canonical(folder))
        })
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
      if (!found) {
        if (command.endedAt !== undefined && now - command.endedAt > COMMAND_GRACE_MS) this.noted.delete(key)
        continue
      }
      claim(found.pid)
      const folder = cwds.get(found.pid) ?? command.folder
      if (!threadInScope(command.threadId, folder)) continue
      entries.push(this.entry(snapshot, tree, found, {
        id: `command:${key}`,
        command: command.command,
        startedBy: { kind: 'thread', threadId: command.threadId },
        ...(folder ? { folder } : {})
      }))
    }

    // Anything else that listens on a port and works in one of the folders.
    if (folders.length) {
      const unclaimed = listening.filter((pid) => !claimed.has(pid))
      // One entry per tree: a listening process whose parent also listens belongs to that parent.
      const listeningSet = new Set(unclaimed)
      for (const pid of unclaimed) {
        if (tree.ancestors(pid).some((ancestor) => listeningSet.has(ancestor) && inFolders(cwds.get(ancestor)))) continue
        const folder = cwds.get(pid)
        if (!inFolders(folder)) continue
        entries.push(this.entry(snapshot, tree, tree.row(pid)!, {
          id: `process:${pid}`,
          startedBy: ours.has(pid) ? { kind: 'agent' } : { kind: 'outside' },
          folder: folder!
        }))
      }
    }
    return entries.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  private entry(snapshot: Snapshot, tree: ProcessTree, row: ProcessRow, input: {
    id: string
    label?: string
    command?: string
    startedBy: RunningStarter
    folder?: string
    startedAt?: number
    output?: () => string
  }): RunningEntry {
    const pids = new Set(tree.subtree(row.pid))
    const ports = snapshot.listeners?.filter((listener) => pids.has(listener.pid)) ?? []
    return {
      id: input.id,
      ...(input.label ? { label: input.label } : {}),
      command: input.command ?? shortCommand(row.command),
      pid: row.pid,
      startedBy: input.startedBy,
      ...((input.startedAt ?? row.startedAt) !== undefined ? { startedAt: input.startedAt ?? row.startedAt } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
      addresses: addressesOf(ports, snapshot.listeners, input.output?.() ?? '')
    }
  }

  private read(): Promise<Snapshot> {
    if (this.reading) return this.reading
    const reading = Promise.all([this.system.processes(), this.system.listeners()])
      .then(([processes, listeners]) => ({ processes, listeners }))
      .finally(() => { if (this.reading === reading) this.reading = undefined })
    this.reading = reading
    return reading
  }
}

interface Snapshot {
  processes: ProcessRow[] | undefined
  /** Undefined when the ports could not be read. */
  listeners: ListeningPort[] | undefined
}

// ------------------------------------------------------------------ the process tree

export interface ProcessTree {
  row(pid: number): ProcessRow | undefined
  children(pid: number): ProcessRow[]
  /** `pid` and everything below it. */
  subtree(pid: number): number[]
  ancestors(pid: number): number[]
  isAncestorOf(ancestor: number, pid: number): boolean
}

export function processTree(rows: readonly ProcessRow[]): ProcessTree {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const ancestors = (pid: number): number[] => {
    const out: number[] = []
    const seen = new Set([pid])
    let current = byPid.get(pid)?.ppid
    while (current !== undefined && current > 0 && !seen.has(current) && byPid.has(current)) {
      out.push(current)
      seen.add(current)
      current = byPid.get(current)?.ppid
    }
    return out
  }
  return {
    row: (pid) => byPid.get(pid),
    children: (pid) => children.get(pid) ?? [],
    subtree: (pid) => {
      if (!byPid.has(pid)) return []
      const out = [pid]
      const seen = new Set(out)
      for (let index = 0; index < out.length; index += 1) {
        for (const child of children.get(out[index]!) ?? []) {
          if (seen.has(child.pid)) continue
          seen.add(child.pid)
          out.push(child.pid)
        }
      }
      return out
    },
    ancestors,
    isAncestorOf: (ancestor, pid) => ancestors(pid).includes(ancestor)
  }
}

/**
 * The command a terminal's shell runs in its foreground, or undefined while it waits at its prompt. POSIX: the
 * processes of the terminal's foreground group (`tpgid`), when that is not the shell's own; the topmost of them. A
 * prompt's helpers run in groups of their own and never count. Windows has no groups: the shell's first child that is
 * not its console host.
 */
export function foregroundJob(tree: ProcessTree, shellPid: number, platform: NodeJS.Platform): ProcessRow | undefined {
  const shell = tree.row(shellPid)
  if (!shell) return undefined
  if (platform === 'win32') return tree.children(shellPid).find((child) => !CONSOLE_HOSTS.test(child.command))
  if (shell.tpgid === undefined || shell.tpgid <= 0) return undefined
  if (shell.tpgid === shell.pgid) return undefined
  const job = tree.subtree(shellPid).map((pid) => tree.row(pid)!).filter((row) => row.pid !== shellPid && row.pgid === shell.tpgid)
  const inJob = new Set(job.map((row) => row.pid))
  return job.find((row) => !inJob.has(row.ppid))
}

/**
 * What runs in a terminal: its foreground command, then each other job of its shell that listens on a port (started
 * with `&`), the topmost process of each. A prompt's helpers run in groups of their own but listen on nothing.
 */
export function terminalJobsOf(tree: ProcessTree, shellPid: number, platform: NodeJS.Platform, listeners: readonly ListeningPort[] | undefined): ProcessRow[] {
  const jobs: ProcessRow[] = []
  const foreground = foregroundJob(tree, shellPid, platform)
  if (foreground) jobs.push(foreground)
  const shell = tree.row(shellPid)
  if (!shell || platform === 'win32' || !listeners?.length) return jobs
  const listening = new Set(listeners.map((listener) => listener.pid))
  const rows = tree.subtree(shellPid).map((pid) => tree.row(pid)!).filter((row) => row.pid !== shellPid)
  const groups = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pgid === undefined || row.pgid === shell.pgid || row.pgid === foreground?.pgid) continue
    const group = groups.get(row.pgid) ?? []
    group.push(row)
    groups.set(row.pgid, group)
  }
  for (const group of groups.values()) {
    if (!group.some((row) => listening.has(row.pid))) continue
    const inGroup = new Set(group.map((row) => row.pid))
    const top = group.find((row) => !inGroup.has(row.ppid))
    if (top) jobs.push(top)
  }
  return jobs
}

/**
 * The processes that may run `command` under this service: the topmost of each branch whose command line holds the
 * command's script and that started while its call ran, and that is not already told as something else.
 */
function commandCandidatesOf(tree: ProcessTree, selfPid: number, command: NotedCommand, ours: Set<number>, claimed: Set<number>): ProcessRow[] {
  const script = comparable(commandScript(command.command))
  const from = command.notedAt - START_SLACK_MS
  const until = (command.endedAt ?? Number.POSITIVE_INFINITY) + START_SLACK_MS
  const queue = tree.children(selfPid).map((row) => row.pid)
  const seen = new Set<number>()
  const found: ProcessRow[] = []
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid) || claimed.has(pid) || !ours.has(pid)) continue
    seen.add(pid)
    const row = tree.row(pid)
    if (!row) continue
    const started = row.startedAt
    if (comparable(row.command).includes(script) && started !== undefined && started >= from && started <= until) {
      found.push(row)
      continue
    }
    for (const child of tree.children(pid)) queue.push(child.pid)
  }
  return found
}

// ------------------------------------------------------------------ addresses

function hostForUrl(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1') return 'localhost'
  return host.includes(':') ? `[${host}]` : host
}

function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

/** The local addresses a command printed, last one first (`Local: http://localhost:5173/`). */
export function printedAddresses(output: string): string[] {
  const found = output.replace(ANSI, '').match(LOCAL_URL) ?? []
  const out: string[] = []
  for (const url of found.reverse()) {
    const clean = url.replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost').replace('://127.0.0.1', '://localhost').replace(/:\/\/\[::1?\]/, '://localhost')
    if (!out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * The addresses of something that runs: each port its processes listen on, as `http://localhost:<port>`, with what it
 * printed for that port in its place (`http://localhost:5173/app/`). When no port could be read at all, what it printed.
 */
export function addressesOf(own: readonly ListeningPort[], all: readonly ListeningPort[] | undefined, output: string): string[] {
  const printed = output ? printedAddresses(output) : []
  if (!all) return printed.slice(0, MAX_ADDRESSES)
  const ports = new Map<number, string>()
  for (const listener of [...own].sort((a, b) => a.port - b.port)) {
    if (!ports.has(listener.port)) ports.set(listener.port, `http://${hostForUrl(listener.host)}:${listener.port}`)
  }
  const out: string[] = []
  // A printed address counts when something listens on its port: its own process, or one it handed the port to.
  for (const url of printed) {
    const port = portOf(url)
    if (port === undefined || out.some((known) => portOf(known) === port)) continue
    if (ports.has(port) || all.some((listener) => listener.port === port)) out.push(url)
  }
  for (const [port, url] of ports) if (!out.some((known) => portOf(known) === port)) out.push(url)
  return out.slice(0, MAX_ADDRESSES)
}

// ------------------------------------------------------------------ the note

const MAX_NOTE_ENTRIES = 6
const MAX_COMMAND_CHARS = 120

/** The app tool that returns the list (`runningTools`); a bot has it always (`BOT_RUNNING_TOOL`). */
export const RUNNING_LIST_TOOL = BOT_RUNNING_TOOL

function shortCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_COMMAND_CHARS ? `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…` : flat
}

/** How long something has run, in a few words. */
export function uptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return `${Math.floor(hours / 24)} days`
}

export interface RunningViewer {
  threadId?: string
  botId?: string
  /** The viewer's own folder, which needs no mention. */
  folder?: string
}

function starterText(entry: RunningEntry, viewer: RunningViewer, sources: Pick<RunningSources, 'thread' | 'botName'>): string {
  const by = entry.startedBy
  switch (by.kind) {
    case 'person':
      return `started by ${personOf(viewer)} ${by.via === 'quick_action' ? 'with a quick action' : 'in a terminal'}`
    case 'thread': {
      if (by.threadId === viewer.threadId) return 'started by this thread'
      const own = viewer.threadId ? sources.thread(viewer.threadId) : undefined
      const info = sources.thread(by.threadId)
      if (own?.parentThreadId === by.threadId) return 'started by your parent thread'
      if (info?.parentThreadId === viewer.threadId && viewer.threadId) return `started by your subagent "${info?.title ?? by.threadId}"`
      return `started by thread "${info?.title ?? by.threadId}" (mousse://thread/${by.threadId})`
    }
    case 'bot':
      if (by.botId === viewer.botId) return 'started by you (watch_start)'
      return `started by bot "${sources.botName?.(by.botId) ?? by.botId}"`
    case 'agent':
      return 'started by an agent in Mousse'
    case 'outside':
      return 'started outside Mousse'
  }
}

/** One line per entry: `Dev server (`npm run dev`), started by …, up 12 min, at http://localhost:5173/`. */
export function runningLine(entry: RunningEntry, viewer: RunningViewer, sources: Pick<RunningSources, 'thread' | 'botName'>, now: number, detail = false): string {
  // A label that already holds the command (a bot's title often does) is not followed by it again.
  const name = entry.label && !entry.label.includes(entry.command) ? `${entry.label} (\`${entry.command}\`)` : entry.label ?? `\`${entry.command}\``
  const parts = [name, starterText(entry, viewer, sources)]
  if (entry.startedAt !== undefined) parts.push(`up ${uptime(Math.max(0, now - entry.startedAt))}`)
  if (entry.addresses.length) parts.push(`at ${entry.addresses.join(', ')}`)
  const folder = entry.folder && (!viewer.folder || canonical(entry.folder) !== canonical(viewer.folder)) ? entry.folder : undefined
  if (folder) parts.push(`in ${folder}`)
  if (detail) parts.push(`pid ${entry.pid}`)
  return `- ${parts.join(', ')}`
}

/** Who the person is to the viewer: a bot's owner, or a thread's user. */
function personOf(viewer: RunningViewer): string {
  return viewer.botId ? 'your owner' : 'the user'
}

function reuseAdvice(viewer: RunningViewer): string {
  return `Reuse a running server and its address instead of starting another copy; restart one only when ${personOf(viewer)} asks or when it has to (it stopped answering, or a change needs a restart it does not do by itself).`
}

/** The turn's note, or empty when nothing runs. */
export function runningNote(entries: readonly RunningEntry[], viewer: RunningViewer, sources: Pick<RunningSources, 'thread' | 'botName'>, now: number): string {
  if (!entries.length) return ''
  const shown = entries.slice(0, MAX_NOTE_ENTRIES).map((entry) => runningLine(entry, viewer, sources, now))
  const more = entries.length > MAX_NOTE_ENTRIES ? [`- and ${entries.length - MAX_NOTE_ENTRIES} more (${RUNNING_LIST_TOOL} lists them all)`] : []
  return [`Already running for your folder, as of this turn's start. ${reuseAdvice(viewer)} ${RUNNING_LIST_TOOL} shows the current list.`, ...shown, ...more].join('\n')
}

/** `running_list`'s answer. */
export function runningListText(entries: readonly RunningEntry[], viewer: RunningViewer, sources: Pick<RunningSources, 'thread' | 'botName'>, now: number): string {
  if (!entries.length) return 'Nothing Mousse can see is running for your folder: no quick action, terminal command, background command, or other process listening on a port there.'
  return [`Running now for your folder. ${reuseAdvice(viewer)}`, ...entries.map((entry) => runningLine(entry, viewer, sources, now, true))].join('\n')
}

// ------------------------------------------------------------------ paths and text

/** Letters and digits only: a command compares the same however a shell or `ps` quoted and escaped it. */
function comparable(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

const canonicalCache = new Map<string, string>()
function canonical(path: string): string {
  const absolute = resolve(path)
  const cached = canonicalCache.get(absolute)
  if (cached) return cached
  let out = absolute
  try { out = realpathSync.native(absolute) } catch { /* gone: compare as given */ }
  if (canonicalCache.size > 500) canonicalCache.clear()
  canonicalCache.set(absolute, out)
  return out
}

function isInside(root: string, path: string): boolean {
  const between = relative(root, path)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const loose = relative(root.toLowerCase(), path.toLowerCase())
    if (loose === '' || (!loose.startsWith('..') && !isAbsolute(loose))) return true
  }
  return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}
