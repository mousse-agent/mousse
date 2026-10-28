import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { SCOPE_VARIABLE } from './environment'

/**
 * The scope of a device: everything the endpoint started for it on this computer.
 *
 * A block, the device's switch going off, a revoke and Net being turned off must end everything the device
 * started, and an ordinary kill of a process tree cannot: VS Code's server, Zed's daemon and anything run with
 * `setsid`, `nohup` or `&` leave the process group and are re-parented, so no walk down from the session finds
 * them. Two marks find them again.
 *
 * - **The marker.** Every program started for a device has `MOUSSE_EDITOR_SCOPE=<token>` in its environment, and
 *   a program inherits its environment across `fork`, `setsid` and daemonizing. The token is a keyed hash of the
 *   device's id (`scopeToken`), so it is the same after the daemon restarts, and a program started before a
 *   restart is still found. The kill reads the environment of every process of the user (`/proc/<pid>/environ`
 *   on Linux, `ps -E` on macOS), which only the owner of a process may do, and kills those that carry the token.
 * - **The tree.** Whatever still hangs from a session's program, and whatever shares its process group, is killed
 *   as well, so a program that cleared its own environment is found while its parent lives.
 *
 * What this cannot find: a program that has cleared its environment, left its process group and lost its parent.
 * Linux has `cgroup` scopes and sub-reapers for that, which Node cannot ask for (no `prctl`), and macOS has
 * nothing at all. docs/net/threat-model.md states the limit.
 */

export interface ProcessRow {
  pid: number
  ppid: number
  /** The process group. */
  pgid: number
  /** The program has this device's marker in its environment. */
  tagged: boolean
}

/** The processes of a scope: marked ones, the live roots, their descendants and their process groups. Never `self` or init. */
export function scopeMembers(
  rows: readonly ProcessRow[],
  roots: ReadonlySet<number>,
  self: number
): number[] {
  const live = new Set(rows.map((row) => row.pid))
  const groups = new Set<number>()
  for (const root of roots) if (live.has(root)) groups.add(root)
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const members = new Set<number>()
  const walk = [...groups]
  while (walk.length) {
    const pid = walk.pop()!
    if (members.has(pid)) continue
    members.add(pid)
    walk.push(...(children.get(pid) ?? []))
  }
  for (const row of rows) if (row.tagged || groups.has(row.pgid)) members.add(row.pid)
  members.delete(self)
  members.delete(0)
  members.delete(1)
  return [...members]
}

/** The token that marks a device's programs: stable for a key and a device, and not derivable without the key. */
export function scopeToken(key: Uint8Array, node: string): string {
  return createHmac('sha256', key).update(`editor-scope ${node}`).digest('hex').slice(0, 32)
}

const NUMBER = /^\d+$/u

/** Linux: `/proc/<pid>/stat` and `/proc/<pid>/environ` of every process the caller may read. */
export async function readLinuxProcesses(token: string): Promise<ProcessRow[]> {
  const marker = Buffer.from(`${SCOPE_VARIABLE}=${token}\0`)
  let names: string[]
  try {
    names = (await readdir('/proc')).filter((name) => NUMBER.test(name))
  } catch {
    return []
  }
  const rows: ProcessRow[] = []
  const one = async (name: string): Promise<void> => {
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'latin1')
      // `pid (comm) state ppid pgrp ...`: the name may hold spaces and brackets, so the fields start after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(fields[1])
      const pgid = Number(fields[2])
      if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return
      const environment = await readFile(`/proc/${name}/environ`).catch(() => undefined)
      rows.push({ pid: Number(name), ppid, pgid, tagged: environment?.includes(marker) ?? false })
    } catch {
      // The process ended, or belongs to someone else.
    }
  }
  for (let i = 0; i < names.length; i += 64) await Promise.all(names.slice(i, i + 64).map(one))
  return rows
}

/** macOS: `ps -E` shows each process's environment after its command line. */
export function readMacProcesses(token: string): Promise<ProcessRow[]> {
  const marker = ` ${SCOPE_VARIABLE}=${token} `
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axww', '-E', '-o', 'pid=,ppid=,pgid=,command='],
      { maxBuffer: 256 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error && !stdout) return resolve([])
        const rows: ProcessRow[] = []
        for (const line of String(stdout).split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/u.exec(line)
          if (match)
            rows.push({
              pid: Number(match[1]),
              ppid: Number(match[2]),
              pgid: Number(match[3]),
              // Each variable is a word of the line, so the token is found between two spaces.
              tagged: ` ${match[4]} `.includes(marker)
            })
        }
        resolve(rows)
      }
    )
  })
}

export function readProcesses(platform: NodeJS.Platform): (token: string) => Promise<ProcessRow[]> {
  return platform === 'linux' ? readLinuxProcesses : readMacProcesses
}

export interface ScopeKillerOptions {
  /** The processes now, with which carry `token`. */
  snapshot(token: string): Promise<ProcessRow[]>
  /** `kill(2)`; a negative pid is a process group. Errors (already gone) are the caller's to ignore. */
  signal(pid: number, signal: NodeJS.Signals): void
  self?: number
  /** Tests wait for no time. */
  pause?: (ms: number) => Promise<void>
  /** How many times to look again after a kill: what was killed may have been about to start something. */
  rounds?: number
}

/**
 * Ends scopes. The kill is asynchronous end to end (reads, then signals; the daemon's thread is never held), and
 * one scope is killed by one run at a time: a second request while a run is on makes the run look once more
 * after it, which also covers programs started while the first was going.
 */
export class ScopeKiller {
  private readonly roots = new Map<string, Set<number>>()
  private readonly running = new Map<string, { again: boolean; done: Promise<number> }>()
  private readonly self: number
  private readonly rounds: number
  private readonly pause: (ms: number) => Promise<void>

  constructor(private readonly options: ScopeKillerOptions) {
    this.self = options.self ?? process.pid
    this.rounds = options.rounds ?? 6
    this.pause =
      options.pause ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms)
          timer.unref?.()
        }))
  }

  /** The program of a session: the leader of its own process group. */
  track(token: string, pid: number): void {
    const set = this.roots.get(token) ?? new Set<number>()
    set.add(pid)
    this.roots.set(token, set)
  }

  untrack(token: string, pid: number): void {
    const set = this.roots.get(token)
    if (!set) return
    set.delete(pid)
    if (!set.size) this.roots.delete(token)
  }

  /** The tokens that have a program running now. */
  tokens(): string[] {
    return [...this.roots.keys()]
  }

  /** Kills everything of `token`; resolves with how many processes were signalled, when none is left. */
  kill(token: string): Promise<number> {
    const current = this.running.get(token)
    if (current) {
      current.again = true
      return current.done
    }
    const state: { again: boolean; done: Promise<number> } = {
      again: false,
      done: Promise.resolve(0)
    }
    state.done = (async () => {
      let total = 0
      do {
        state.again = false
        total += await this.sweep(token)
      } while (state.again)
      return total
    })().finally(() => {
      this.running.delete(token)
    })
    this.running.set(token, state)
    return state.done
  }

  private async sweep(token: string): Promise<number> {
    let total = 0
    for (let round = 0; round < this.rounds; round++) {
      const roots = new Set(this.roots.get(token) ?? [])
      let members: number[]
      try {
        members = scopeMembers(await this.options.snapshot(token), roots, this.self)
      } catch {
        members = []
      }
      // The groups of the roots first: one signal ends everything in them at once, whatever it is doing.
      for (const root of roots) this.send(-root)
      for (const pid of members) this.send(pid)
      total += members.length
      if (!members.length) break
      await this.pause(40)
    }
    this.roots.delete(token)
    return total
  }

  private send(pid: number): void {
    try {
      this.options.signal(pid, 'SIGKILL')
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}
