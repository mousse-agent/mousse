/**
 * The processes of a Git command that was stopped (`runGitProcess` under a cancellation).
 *
 * They are killed once, at the stop, through what Mousse owns for certain: off Windows the command's own process group
 * (Mousse made it, and its id cannot be given to another group while a member of it lives), on Windows `taskkill /T`
 * from the command and the command's own process handle, both while the command still runs. Nothing is killed after
 * that.
 *
 * The command is known by its pid and when it was created, which must fall within {@link SPAWN_ANCHOR_SLACK_MS} of when
 * Mousse started it (the anchor): a pid the system gave to another program since is never taken for it. A creation time
 * that cannot be read cannot disprove it: such a process is taken for the command (and watched by its pid alone), so
 * the lock is kept and the command still killed. Its
 * descendants are the processes whose parent is in the tree (same pid and creation time) and that were created after
 * that parent; Windows keeps a child's parent pid after the parent ends, so a program whose old parent had the
 * command's pid is never taken in.
 *
 * The processes seen at the stop are then only watched, each by its pid and the time it was created, until each has
 * exited, become a zombie, or its pid belongs to another process. Processes started later are not looked for. A look
 * that cannot list the processes in time counts them as still there, so the repository's lock is never let go on a
 * guess.
 *
 * On Windows one window is left: Git can end, and Windows give its pid to another program, between the check that the
 * command still runs (and has the anchored creation time) and `taskkill` opening the pid, a few milliseconds later.
 * Closing it needs a process handle held through the kill, or a Job Object, which Node offers neither of; a native
 * helper could (follow-up).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** One process: its parent, its process group (off Windows), when it was created (opaque; equal means the same process), and whether it is a zombie. */
export interface ProcessEntry {
  pid: number
  ppid: number
  pgid?: number
  started?: string
  /** `started` in ms since the epoch, to compare creation times. */
  startedMs?: number
  zombie?: boolean
}

/** How far from the moment Mousse started the command its creation time may be (`ps` reports it to the second). */
export const SPAWN_ANCHOR_SLACK_MS = 2_000

/** `ps` in the C locale, so `lstart` is always in the one form `Date.parse` reads. */
const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' }

/** Windows file time (100 ns since 1601) in ms since the epoch. */
function fileTimeMs(fileTime: number): number {
  return fileTime / 10_000 - 11_644_473_600_000
}

/** Stand-ins for tests: the process list, the kill at the stop, or whether the tree is still there at all. */
export const gitStopProbe: {
  table?: () => Promise<ProcessEntry[] | undefined>
  kill?: (pid: number, group: boolean) => void
  alive?: (tree: StoppedGitTree) => boolean
} = {}

/** How long one look at the process list may take before it counts as unreadable. */
export const PROCESS_LIST_TIMEOUT_MS = 3_000

const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }"
].join('; ')

function readTable(): Promise<ProcessEntry[] | undefined> {
  if (gitStopProbe.table) return gitStopProbe.table()
  const windows = process.platform === 'win32'
  const [file, args] = windows
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT]]
    // `lstart` last: it holds spaces. Creation times to the second, as `ps` reports them on Linux and macOS.
    : ['ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=']]
  return new Promise((done) => {
    execFile(file, args as string[], { windowsHide: true, timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', ...(windows ? {} : { env: PS_ENV }) }, (error, stdout) => {
      if (error) { done(undefined); return }
      const entries: ProcessEntry[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/)
        if (windows) {
          const [pid, ppid, created] = fields.map(Number)
          if (Number.isInteger(pid) && Number.isInteger(ppid)) entries.push({ pid: pid!, ppid: ppid!, ...(created ? { started: String(created), startedMs: fileTimeMs(created) } : {}) })
        } else {
          const [pid, ppid, pgid] = fields.slice(0, 3).map(Number)
          const started = fields.slice(4).join(' ') || undefined
          const startedMs = started ? Date.parse(started) : Number.NaN
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) entries.push({ pid: pid!, ppid: ppid!, pgid: pgid!, zombie: (fields[3] ?? '').startsWith('Z'), ...(started ? { started } : {}), ...(Number.isFinite(startedMs) ? { startedMs } : {}) })
        }
      }
      done(entries.length ? entries : undefined)
    })
  })
}

/** Every process, or undefined when the list cannot be read within {@link PROCESS_LIST_TIMEOUT_MS}. */
export function readProcessEntries(): Promise<ProcessEntry[] | undefined> {
  return Promise.race([
    readTable().catch(() => undefined),
    new Promise<undefined>((done) => { setTimeout(() => done(undefined), PROCESS_LIST_TIMEOUT_MS).unref() })
  ])
}

/**
 * When process `pid` was created, in ms since the epoch, read without blocking: `CreationDate` on Windows, `ps`
 * `lstart` elsewhere (to the second). Null when it is not running or cannot be read.
 */
export function readProcessStart(pid: number): Promise<number | null> {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}'; if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }`]]
    : ['ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))]]
  return new Promise((done) => {
    execFile(file, args as string[], { windowsHide: true, timeout: 10_000, encoding: 'utf8', ...(process.platform === 'win32' ? {} : { env: PS_ENV }) }, (error, stdout) => {
      const at = error ? Number.NaN : Date.parse(stdout.trim())
      done(Number.isFinite(at) ? at : null)
    })
  })
}

/**
 * The one kill, at the stop, while the command runs and so is certainly the process Mousse started: off Windows its
 * process group (it leads it); on Windows `taskkill /T` from it (not waited for) and its own handle.
 */
function killAtStop(child: ChildProcess, rootDisproved: boolean): void {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  // On Windows the pid `taskkill` opens must still be the command's: Mousse's handle shows it running, and the list just
  // read did not show another creation time for it (`rootDisproved`; a list or a creation time that could not be read
  // disproves nothing, and the handle is trusted as before). What is left is the window named at the top of this file.
  if (process.platform === 'win32' && rootDisproved) return
  if (gitStopProbe.kill) { gitStopProbe.kill(pid, process.platform !== 'win32'); return }
  if (process.platform === 'win32') {
    // `taskkill /T` walks the tree from the command, so the command must still run while it does: its own handle is used
    // only after `taskkill` ended, if it is still running then.
    const own = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill() }
    const kill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    kill.on('error', own)
    kill.on('exit', own)
    kill.unref()
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

export class StoppedGitTree {
  /** The processes seen at the stop, by pid, with when each was created (undefined when that could not be read). */
  private readonly tracked = new Map<number, string | undefined>()
  /** False until a list was read; until then what the command started is not known, and it counts as still there. */
  private known = false

  /** `spawnedAt`: when Mousse started the command, the anchor its creation time is checked against. */
  private constructor(readonly root: number, private readonly spawnedAt: number) {
    this.tracked.set(root, undefined)
  }

  /**
   * Whether `entry` is the command: its pid, and a creation time within {@link SPAWN_ANCHOR_SLACK_MS} of when Mousse
   * started it. One whose creation time cannot be read cannot be disproved, and counts.
   */
  private isRoot(entry: ProcessEntry | undefined): entry is ProcessEntry {
    return entry !== undefined && entry.pid === this.root && !this.disproved(entry)
  }

  /** Whether `entry` has a creation time, and it is not the command's. */
  private disproved(entry: ProcessEntry): boolean {
    return entry.startedMs !== undefined && Math.abs(entry.startedMs - this.spawnedAt) > SPAWN_ANCHOR_SLACK_MS
  }

  /** The pids of the command's processes being watched (the command's own until its processes were listed). */
  pids(): number[] {
    return this.known ? [...this.tracked.keys()] : [this.root]
  }

  /**
   * Kills the command once, then notes the processes it had at the stop. On Windows they are listed before the kill
   * (a list after it would miss the children of a parent already gone); off Windows the group is killed at once and its
   * members are listed after. A list that cannot be read is tried again by the next look.
   */
  static async stop(child: ChildProcess, spawnedAt: number): Promise<StoppedGitTree> {
    const tree = new StoppedGitTree(child.pid!, spawnedAt)
    if (process.platform === 'win32') {
      const table = await readProcessEntries()
      // Not killed when the list shows another creation time for the command's pid; killed otherwise, as Mousse's handle
      // shows it running.
      const listed = table?.find((entry) => entry.pid === child.pid)
      killAtStop(child, listed !== undefined && tree.disproved(listed))
      if (table) tree.note(table)
    } else {
      killAtStop(child, false)
      const table = await readProcessEntries()
      if (table) tree.note(table)
    }
    return tree
  }

  /**
   * Notes, from the first list read, the command and what it had started then. The command counts only with its
   * anchored creation time; without it, it is gone (another program may have its pid now), and so is anything found by
   * it. A descendant counts when its parent is in the tree, as the same process in this list, and it was created after
   * that parent; off Windows also a member of the command's group while the group is still the command's (no other
   * process has the command's pid). Only once: what is started later is never taken in.
   */
  private note(table: ProcessEntry[]): void {
    if (this.known) return
    this.known = true
    const byPid = new Map(table.map((entry) => [entry.pid, entry]))
    this.tracked.clear()
    const root = byPid.get(this.root)
    if (!this.isRoot(root)) {
      // The command is gone. Off Windows its group may still have members: its id goes to no other group while one lives,
      // unless another process now has the command's pid and leads a group of that id.
      if (process.platform === 'win32' || root) return
    } else {
      this.tracked.set(this.root, root.started)
    }
    const inTree = (entry: ProcessEntry): boolean => {
      if (process.platform !== 'win32' && entry.pgid === this.root) return true
      const parent = byPid.get(entry.ppid)
      if (!parent || !this.tracked.has(parent.pid) || this.tracked.get(parent.pid) !== parent.started) return false
      return parent.startedMs === undefined || entry.startedMs === undefined || entry.startedMs >= parent.startedMs
    }
    for (let grew = true; grew;) {
      grew = false
      for (const entry of table) {
        if (this.tracked.has(entry.pid) || !inTree(entry)) continue
        this.tracked.set(entry.pid, entry.started)
        grew = true
      }
    }
  }

  /** A cheap look without listing (Windows): whether a watched pid is still there. True can be a reused pid; a list confirms. */
  quickAlive(): boolean {
    if (gitStopProbe.alive) return gitStopProbe.alive(this)
    const there = (target: number): boolean => { try { process.kill(target, 0); return true } catch { return false } }
    return this.pids().some(there)
  }

  /**
   * Whether a watched process is still there, by the process list: one with the same pid and creation time that is not
   * a zombie. True when the list cannot be read in time, or when what the command started was never known.
   */
  async alive(): Promise<boolean> {
    if (gitStopProbe.alive) return gitStopProbe.alive(this)
    const table = await readProcessEntries()
    if (!table) return true
    if (!this.known) {
      // The list at the stop could not be read: the first one read stands for it. Until then nothing is let go.
      this.note(table)
    }
    const byPid = new Map(table.map((entry) => [entry.pid, entry]))
    return [...this.tracked.keys()].some((pid) => {
      const entry = byPid.get(pid)
      if (!entry || entry.zombie) return false
      const started = this.tracked.get(pid)
      return started === undefined || entry.started === started
    })
  }
}
