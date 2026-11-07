import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

/**
 * Process-group control for bot dispatches (Bot Phase 1 §5.9), shared by the daemon's
 * `BotProcessRegistry` and the detached supervisor (`botSupervisorMain.ts`), so it imports Node's
 * built-ins only. A bot's runtime leads a process group of its own on POSIX (`detached`), and the
 * group is what is signalled; on Windows the tree under the leader's pid is ended by `taskkill`.
 *
 * "Gone" means no member is left running. A killed child of the daemon stays a zombie until the
 * daemon's loop reaps it, and a zombie still answers `kill(pid, 0)`: so after a kill, liveness is
 * read from the process table, where zombies are skipped (`/proc` on Linux, `ps` on macOS).
 */

export interface ProcessScopeOptions {
  platform?: NodeJS.Platform
  /** Test seam: `process.kill`. */
  kill?: (target: number, signal: NodeJS.Signals | 0) => void
  /** Test seam: the live (non-zombie) members of a group; undefined when the table cannot be read. */
  members?: (pgid: number) => Promise<number[] | undefined>
  /** Test seam: Windows' `taskkill /T /F /PID`. */
  taskkill?: (pid: number) => Promise<void>
}

const defaultKill = (target: number, signal: NodeJS.Signals | 0) => process.kill(target, signal)

/** Whether the error of `kill` says the target does not exist. */
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

/**
 * Sends `signal` to the group `pgid` leads (POSIX) or to its leader (Windows, where only 0 is
 * meaningful: use `endTree` to end it). False when nothing is there to receive it.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0, options: ProcessScopeOptions = {}): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false
  const platform = options.platform ?? process.platform
  try {
    ;(options.kill ?? defaultKill)(platform === 'win32' ? pgid : -pgid, signal)
    return true
  } catch (error) {
    // EPERM: something is there that is not ours to signal; it is not reported as gone.
    return !missing(error)
  }
}

/** Ends the process tree `pid` heads on Windows (`taskkill /T /F`); resolves when the command returned. */
export function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve())
  })
}

/** Linux: the members of `pgid` that are not zombies, from `/proc/<pid>/stat`. */
function procMembers(pgid: number): number[] | undefined {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }
  const found: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // The command name (field 2) may hold spaces and parentheses; the fields after it do not.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const state = fields[0]
    if (Number(fields[2]) === pgid && state !== 'Z' && state !== 'X') found.push(Number(entry))
  }
  return found
}

/** macOS and other POSIX: the members of `pgid` that are not zombies, from `ps`. */
function psMembers(pgid: number): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error || typeof stdout !== 'string') return resolve(undefined)
      const found: number[] = []
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
        if (match && Number(match[2]) === pgid && !match[3].startsWith('Z')) found.push(Number(match[1]))
      }
      resolve(found)
    })
  })
}

/**
 * Whether anything of the group still runs. A group that `kill(-pgid, 0)` no longer finds is gone;
 * one it finds is read from the process table, so members left as zombies do not count. Windows:
 * whether the leader still runs.
 */
export async function groupAlive(pgid: number, options: ProcessScopeOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  if (!signalGroup(pgid, 0, options)) return false
  if (platform === 'win32') return true
  const members = options.members ? await options.members(pgid) : platform === 'linux' ? procMembers(pgid) : await psMembers(pgid)
  // Without a table the signal's answer stands.
  return members === undefined ? true : members.length > 0
}

export interface EndGroupOptions extends ProcessScopeOptions {
  /** After SIGTERM, how long the group has before SIGKILL (default 2 s). */
  graceMs?: number
  /** After SIGKILL, how long the exit is waited for (default 10 s). */
  confirmMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Polls until the group is gone or `untilMs` passes; true when it is gone. */
export async function waitGone(pgid: number, untilMs: number, options: EndGroupOptions): Promise<boolean> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const poll = options.pollMs ?? 100
  for (;;) {
    if (!(await groupAlive(pgid, options))) return true
    if (now() >= untilMs) return false
    await sleep(poll)
  }
}

/**
 * Ends a group and confirms it: SIGTERM, SIGKILL after the grace, then the exit is waited for (on
 * Windows `taskkill /T /F`, then the leader's exit). `exitAt` is when it was seen gone.
 */
export async function endGroup(pgid: number, options: EndGroupOptions = {}): Promise<{ exitAt: number } | { stillAlive: true }> {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  if (!(await groupAlive(pgid, options))) return { exitAt: now() }
  if (platform === 'win32') {
    await (options.taskkill ?? taskkillTree)(pgid)
  } else {
    signalGroup(pgid, 'SIGTERM', options)
    if (!(await waitGone(pgid, now() + (options.graceMs ?? 2_000), options))) signalGroup(pgid, 'SIGKILL', options)
  }
  return (await waitGone(pgid, now() + (options.confirmMs ?? 10_000), options)) ? { exitAt: now() } : { stillAlive: true }
}
