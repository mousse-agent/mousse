/**
 * The processes of a Git command that was stopped (`runGitProcess` under a cancellation): what it started is killed with
 * it, and is then looked at until none of it is left, so the repository's lock is let go only after them.
 *
 * Each process is known by its pid and the time it was created, so a pid the system gives to another program later is
 * never taken for it. Each look also finds what the remaining processes started since (their children, by parent pid;
 * off Windows also by process group, the command leads its own) and kills that too. A look that cannot list the
 * processes counts them as still there: the lock is never let go on a guess.
 */
import { execFile, spawn } from 'node:child_process'

/** One process: its parent, its process group (off Windows), and when it was created (an opaque value; equal means the same process). */
export interface ProcessEntry {
  pid: number
  ppid: number
  pgid?: number
  started?: string
}

/** Stand-ins for tests: the process list, the kill, or whether the tree is still there at all. */
export const gitStopProbe: {
  table?: () => Promise<ProcessEntry[] | undefined>
  kill?: (pid: number, group: boolean) => void
  alive?: (tree: StoppedGitTree) => boolean
} = {}

const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }"
].join('; ')

/** Every process with its parent, group and creation time; undefined when the list cannot be read in `timeoutMs`. */
export function readProcessEntries(timeoutMs: number): Promise<ProcessEntry[] | undefined> {
  if (gitStopProbe.table) return gitStopProbe.table()
  const windows = process.platform === 'win32'
  const [file, args] = windows
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT]]
    // `lstart` last: it holds spaces. Creation times to the second, as `ps` reports them on Linux and macOS.
    : ['ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=']]
  return new Promise((done) => {
    execFile(file, args as string[], { windowsHide: true, timeout: Math.max(1_000, timeoutMs), maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { done(undefined); return }
      const entries: ProcessEntry[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/)
        if (windows) {
          const [pid, ppid, created] = fields.map(Number)
          if (Number.isInteger(pid) && Number.isInteger(ppid)) entries.push({ pid: pid!, ppid: ppid!, ...(created ? { started: String(created) } : {}) })
        } else {
          const [pid, ppid, pgid] = fields.slice(0, 3).map(Number)
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) entries.push({ pid: pid!, ppid: ppid!, pgid: pgid!, started: fields.slice(3).join(' ') || undefined })
        }
      }
      done(entries.length ? entries : undefined)
    })
  })
}

function killPid(pid: number, group: boolean): Promise<void> {
  if (gitStopProbe.kill) { gitStopProbe.kill(pid, group); return Promise.resolve() }
  if (process.platform === 'win32') {
    return new Promise((done) => {
      const kill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      kill.on('error', () => done())
      kill.on('exit', () => done())
    })
  }
  try { process.kill(group ? -pid : pid, 'SIGKILL') } catch { /* already gone */ }
  return Promise.resolve()
}

/** Windows file times are numbers: a child is never created before its parent, which tells a reused parent pid apart. */
function createdNoEarlier(child: string | undefined, parent: string | undefined): boolean {
  if (process.platform !== 'win32' || !child || !parent) return true
  try { return BigInt(child) >= BigInt(parent) } catch { return true }
}

export class StoppedGitTree {
  /** The processes of the command, by pid, with when each was created (undefined when that could not be read). */
  private readonly tracked = new Map<number, string | undefined>()

  private constructor(readonly root: number) {
    this.tracked.set(root, undefined)
  }

  /** The pids of the command's processes that are known. */
  pids(): number[] {
    return [...this.tracked.keys()]
  }

  /**
   * Lists the command's processes, then kills them (the command's group and each process found off Windows; on Windows
   * `taskkill /T` from the command, waited for, and each process found). A list that cannot be read leaves only the
   * command known; later looks find the rest by parent and group.
   */
  static async stop(root: number, deadline: number): Promise<StoppedGitTree> {
    const tree = new StoppedGitTree(root)
    const table = await readProcessEntries(deadline - Date.now())
    if (table) tree.adopt(table, true)
    await killPid(root, process.platform !== 'win32')
    for (const pid of tree.pids()) if (pid !== root) await killPid(pid, false)
    return tree
  }

  /**
   * Takes into the tree, from `table`, the command itself (with its creation time) and every process its tracked
   * processes started, by parent pid, and, off Windows, every process in its group, unless that group is another now
   * (its leader is gone and a new process got its pid). Returns the processes it took in.
   */
  private adopt(table: ProcessEntry[], first: boolean): ProcessEntry[] {
    const byPid = new Map(table.map((entry) => [entry.pid, entry]))
    if (first) this.tracked.set(this.root, byPid.get(this.root)?.started)
    const leader = byPid.get(this.root)
    const leaderStarted = this.tracked.get(this.root)
    const groupOurs = process.platform !== 'win32' && !(leader && leaderStarted && leader.started !== leaderStarted)
    // A parent is followed while it is still the same process. One that is gone is followed only on Windows (which keeps
    // a child's parent pid after the parent ends, where elsewhere the child is handed to init), and only while no other
    // process has its pid: the children of a program that got a reused pid are never taken for the command's.
    const followable = (ppid: number): boolean => {
      if (!this.tracked.has(ppid)) return false
      const now = byPid.get(ppid)
      const started = this.tracked.get(ppid)
      if (now) return started === undefined || now.started === started
      return process.platform === 'win32'
    }
    const added: ProcessEntry[] = []
    for (let grew = true; grew;) {
      grew = false
      for (const entry of table) {
        if (this.tracked.has(entry.pid)) continue
        const parentStarted = this.tracked.get(entry.ppid)
        const child = followable(entry.ppid) && createdNoEarlier(entry.started, parentStarted)
        const inGroup = groupOurs && entry.pgid === this.root
        if (!child && !inGroup) continue
        this.tracked.set(entry.pid, entry.started)
        added.push(entry)
        grew = true
      }
    }
    return added
  }

  /** A cheap look without listing: whether any tracked pid (or, off Windows, the command's group) is still there. */
  quickAlive(): boolean {
    if (gitStopProbe.alive) return gitStopProbe.alive(this)
    const there = (target: number): boolean => { try { process.kill(target, 0); return true } catch { return false } }
    if (process.platform !== 'win32' && there(-this.root)) return true
    return this.pids().some(there)
  }

  /**
   * Whether anything of the command is still there, by the process list: a tracked process with the same creation
   * time, or one they started since, which is killed and tracked too. True when the list cannot be read.
   */
  async alive(): Promise<boolean> {
    if (gitStopProbe.alive) return gitStopProbe.alive(this)
    const table = await readProcessEntries(10_000)
    if (!table) return true
    const byPid = new Map(table.map((entry) => [entry.pid, entry]))
    const living = this.pids().filter((pid) => {
      const entry = byPid.get(pid)
      const started = this.tracked.get(pid)
      return entry !== undefined && (started === undefined || entry.started === started)
    })
    const late = this.adopt(table, false)
    for (const entry of late) await killPid(entry.pid, false)
    return living.length > 0 || late.length > 0
  }
}
