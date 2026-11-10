/**
 * The processes of a Git command that was stopped (`runGitProcess` under a cancellation).
 *
 * They are killed once, at the stop, through what Mousse owns for certain: off Windows the command's own process group
 * (Mousse made it, and its id cannot be given to another group while a member of it lives), on Windows `taskkill /T`
 * from the command and the command's own process handle, both while the command still runs. Nothing is killed after
 * that.
 *
 * The processes seen at the stop are then only watched, each by its pid and the time it was created, until each has
 * exited, become a zombie, or its pid belongs to another process. Processes started later are not looked for. A look
 * that cannot list the processes in time counts them as still there, so the repository's lock is never let go on a
 * guess.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** One process: its parent, its process group (off Windows), when it was created (opaque; equal means the same process), and whether it is a zombie. */
export interface ProcessEntry {
  pid: number
  ppid: number
  pgid?: number
  started?: string
  zombie?: boolean
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
    execFile(file, args as string[], { windowsHide: true, timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { done(undefined); return }
      const entries: ProcessEntry[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/)
        if (windows) {
          const [pid, ppid, created] = fields.map(Number)
          if (Number.isInteger(pid) && Number.isInteger(ppid)) entries.push({ pid: pid!, ppid: ppid!, ...(created ? { started: String(created) } : {}) })
        } else {
          const [pid, ppid, pgid] = fields.slice(0, 3).map(Number)
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) entries.push({ pid: pid!, ppid: ppid!, pgid: pgid!, zombie: (fields[3] ?? '').startsWith('Z'), started: fields.slice(4).join(' ') || undefined })
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
    execFile(file, args as string[], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      const at = error ? Number.NaN : Date.parse(stdout.trim())
      done(Number.isFinite(at) ? at : null)
    })
  })
}

/**
 * The one kill, at the stop, while the command runs and so is certainly the process Mousse started: off Windows its
 * process group (it leads it); on Windows `taskkill /T` from it (not waited for) and its own handle.
 */
function killAtStop(child: ChildProcess): void {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
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

  private constructor(readonly root: number) {
    this.tracked.set(root, undefined)
  }

  /** The pids of the command's processes being watched. */
  pids(): number[] {
    return [...this.tracked.keys()]
  }

  /**
   * Kills the command once, then notes the processes it had at the stop. On Windows they are listed before the kill
   * (a list after it would miss the children of a parent already gone); off Windows the group is killed at once and its
   * members are listed after. A list that cannot be read is tried again by the next look.
   */
  static async stop(child: ChildProcess): Promise<StoppedGitTree> {
    const tree = new StoppedGitTree(child.pid!)
    if (process.platform === 'win32') {
      const table = await readProcessEntries()
      killAtStop(child)
      if (table) tree.note(table)
    } else {
      killAtStop(child)
      const table = await readProcessEntries()
      if (table) tree.note(table)
    }
    return tree
  }

  /**
   * Notes, from the first list read, the command and what it had started then: its descendants by parent pid, and off
   * Windows the members of its group. Only once: what is started later is never taken in.
   */
  private note(table: ProcessEntry[]): void {
    if (this.known) return
    this.known = true
    const byPid = new Map(table.map((entry) => [entry.pid, entry]))
    this.tracked.set(this.root, byPid.get(this.root)?.started)
    for (let grew = true; grew;) {
      grew = false
      for (const entry of table) {
        if (this.tracked.has(entry.pid)) continue
        const inGroup = process.platform !== 'win32' && entry.pgid === this.root
        if (!this.tracked.has(entry.ppid) && !inGroup) continue
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
    return this.pids().some((pid) => {
      const entry = byPid.get(pid)
      if (!entry || entry.zombie) return false
      const started = this.tracked.get(pid)
      return started === undefined || entry.started === started
    })
  }
}
