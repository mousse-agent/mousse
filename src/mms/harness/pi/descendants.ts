import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The processes a Pi process started, remembered while it is alive (POSIX). Pi's `bash` tool runs
 * its shell detached, in a process group of its own; when Pi dies those processes are reparented
 * and nothing links them to Pi any more. So the engine records Pi's descendants (pid, group and
 * start time) while Pi runs, and after an unexpected death kills each recorded group and process
 * that still has the start time it had when recorded, so a reused pid is never hit.
 *
 * Windows keeps a dead parent's pid in its children's records, so the engine's sweep finds them
 * there; this tracker is for Linux and macOS.
 */

export interface ProcessEntry {
  pid: number
  ppid: number
  pgid: number
  /** Opaque start time (`ps -o lstart`): a reused pid gets another one. */
  start: string
}

export interface DescendantTrackerOptions {
  /** Every process (test seam); default `ps -A -o pid=,ppid=,pgid=,lstart=`, asynchronously. */
  list?: () => Promise<ProcessEntry[] | undefined>
  /** Sends SIGKILL to a pid, or to a process group when `group` (test seam). */
  kill?: (id: number, group: boolean) => void
}

export async function listProcesses(): Promise<ProcessEntry[] | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    const table: ProcessEntry[] = []
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (match) table.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4].trim() })
    }
    return table.length ? table : undefined
  } catch {
    return undefined
  }
}

function sigkill(id: number, group: boolean): void {
  try {
    process.kill(group ? -id : id, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

export class DescendantTracker {
  private readonly known = new Map<number, ProcessEntry>()
  private recording: Promise<void> | undefined

  constructor(private readonly root: number, private readonly options: DescendantTrackerOptions = {}) {}

  /** Every recorded descendant. */
  get recorded(): ProcessEntry[] {
    return [...this.known.values()]
  }

  /** Records Pi's current descendants (one listing at a time). */
  snapshot(): Promise<void> {
    if (this.recording) return this.recording
    this.recording = (async () => {
      const table = await (this.options.list ?? listProcesses)()
      if (!table) return
      // Descendants that ended are dropped: their numbers may be reused by other programs.
      const running = new Set(table.map((entry) => `${entry.pid}:${entry.start}`))
      for (const [pid, entry] of this.known) if (!running.has(`${pid}:${entry.start}`)) this.known.delete(pid)
      const children = new Map<number, ProcessEntry[]>()
      for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry])
      const queue = [this.root]
      const seen = new Set(queue)
      while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (seen.has(child.pid)) continue
          seen.add(child.pid)
          this.known.set(child.pid, child)
          queue.push(child.pid)
        }
      }
    })().finally(() => {
      this.recording = undefined
    })
    return this.recording
  }

  /** After Pi died: kills each recorded group and process still running with its recorded start time. */
  async killRecorded(): Promise<void> {
    // A listing still running when Pi died is part of what was recorded.
    await this.recording?.catch(() => {})
    if (!this.known.size) return
    const table = await (this.options.list ?? listProcesses)()
    if (!table) return
    const kill = this.options.kill ?? sigkill
    // Only what is still live as recorded (same pid and start time): those processes, and the groups
    // they are in. A group number alone, or a pid now used by another program, is never signalled.
    const live = table.filter((entry) => this.known.get(entry.pid)?.start === entry.start)
    const groups = new Set(live.map((entry) => entry.pgid).filter((pgid) => pgid > 1 && pgid !== process.pid))
    for (const pgid of groups) kill(pgid, true)
    for (const entry of live) kill(entry.pid, false)
  }
}

/**
 * Kills each group a recorded leader leads, with every member still in it, also when the leader is
 * already gone (a group id is not reused while the group has members). A leader pid now running
 * with another start time is someone else's group and is left alone.
 */
export async function killOwned(table: ProcessEntry[] | undefined, leaders: Array<{ pid: number; start: string }>, kill: (id: number, group: boolean) => void = sigkill): Promise<void> {
  // Without a listing ownership cannot be verified, and a group is never signalled by number alone.
  if (!table) return
  for (const leader of leaders) {
    if (leader.pid === process.pid || !leader.start) continue
    const current = table.find((entry) => entry.pid === leader.pid)
    if (current && current.start !== leader.start) continue
    if (table.some((entry) => entry.pgid === leader.pid)) kill(leader.pid, true)
  }
}

/** Why a shell was not started: its group could not be verified as Mousse's. */
export class UnverifiedGroupError extends Error {
  constructor() {
    super('mousse_shell_uncontained: Mousse could not verify the shell process group (no process listing), so the command was not run.')
    this.name = 'UnverifiedGroupError'
  }
}

/**
 * The shell groups a Pi process owns (POSIX). A group is owned while at least one process in it is
 * one Mousse recorded (same pid and start time): only then is it signalled, never on its number
 * alone, since a group number is free for reuse once every member is gone. Recorded members are
 * the leader at registration and every process seen in the group while it was still verified
 * (`refresh`, on each sampling pass and when a command ends); a group with no recorded member left
 * is retired.
 */
export class OwnedGroups {
  /** pgid → recorded members, `pid:start`. */
  private readonly groups = new Map<number, Set<string>>()

  constructor(private readonly list: () => Promise<ProcessEntry[] | undefined> = listProcesses) {}

  get size(): number {
    return this.groups.size
  }

  /** Records a new shell's group; refuses (and the shell runs nothing) when it cannot be verified. */
  async record(pgid: number): Promise<void> {
    const table = await this.list()
    const leader = table?.find((entry) => entry.pid === pgid && entry.pgid === pgid)
    if (!leader?.start) throw new UnverifiedGroupError()
    this.groups.set(pgid, new Set([`${leader.pid}:${leader.start}`]))
  }

  /** The groups of `table` still owned: a live process in them is a recorded member. */
  private owned(table: ProcessEntry[]): number[] {
    return [...this.groups].filter(([pgid, members]) => table.some((entry) => entry.pgid === pgid && members.has(`${entry.pid}:${entry.start}`))).map(([pgid]) => pgid)
  }

  /** Re-verifies every group: members of an owned one are recorded, an unowned one is retired. */
  async refresh(): Promise<void> {
    if (!this.groups.size) return
    const table = await this.list()
    if (!table) return
    const owned = new Set(this.owned(table))
    for (const [pgid, members] of this.groups) {
      if (!owned.has(pgid)) {
        this.groups.delete(pgid)
        continue
      }
      for (const entry of table) if (entry.pgid === pgid && entry.start) members.add(`${entry.pid}:${entry.start}`)
    }
  }

  /** A group's command ended. */
  ended(): Promise<void> {
    return this.refresh()
  }

  /** Kills every group still owned (verified now, member by member). */
  async kill(kill: (id: number, group: boolean) => void = sigkill): Promise<void> {
    if (!this.groups.size) return
    const table = await this.list()
    if (!table) return
    for (const pgid of this.owned(table)) if (pgid !== process.pid) kill(pgid, true)
  }
}
