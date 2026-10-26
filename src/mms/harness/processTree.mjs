// Kills a process and everything it started, across process groups. Plain JavaScript so the
// runtime check script (scripts/check-pi-runtime-install.mjs) uses the same code as the app.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * Every process as `{ pid, ppid, pgid }` (POSIX `ps`, Linux and macOS), or undefined when `ps`
 * cannot run.
 */
export function readProcessTable(run = spawnSync) {
  try {
    const result = run('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
    const table = []
    for (const line of result.stdout.split('\n')) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
      if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) table.push({ pid, ppid, pgid })
    }
    return table.length ? table : undefined
  } catch {
    return undefined
  }
}

/**
 * When `pid` started, as an opaque string, or undefined when it is not running: field 22 of
 * `/proc/<pid>/stat` on Linux, `ps -o lstart=` elsewhere. A pid that is reused gets another value.
 */
export function readStartTime(pid, run = spawnSync) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name (field 2) may hold spaces and parentheses; the fields after it do not.
    return `proc:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
  } catch {
    /* no procfs */
  }
  try {
    const result = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    const value = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return result.status === 0 && value ? `ps:${value}` : undefined
  } catch {
    return undefined
  }
}

/** Every process below `root` in `table`, nearest first. */
export function descendantsOf(table, root) {
  const children = new Map()
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue
    const list = children.get(entry.ppid) ?? []
    list.push(entry)
    children.set(entry.ppid, list)
  }
  const found = []
  const seen = new Set([root])
  const queue = [root]
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/** `kill`, where a process or group that is already gone (or not ours) is not an error. */
function signal(kill, target, name) {
  try {
    kill(target, name)
    return true
  } catch {
    return false
  }
}

/**
 * POSIX: a child may start helpers in their own process group (Pi's shell runs `detached`), so
 * killing the child's group alone would leave them running, and once the child is gone their
 * parent links are lost. So:
 *
 * 1. A child that is gone with no group left returns at once (no `ps`).
 * 2. The child's group (or the child alone, when it leads none) is frozen, then the group of every
 *    descendant found, reading the table again until no new descendant appears.
 * 3. Every descendant group is killed, then the child's group.
 * 4. A descendant no killed group covered (one in Mousse's own group) is killed by pid, only if it
 *    still has the start time it had when it was found, so a reused pid is never hit.
 *
 * Mousse's own group is never signalled, neither as a descendant's group nor as the child's.
 * Windows: `taskkill /T` follows parent links regardless of groups.
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return
  const platform = options.platform ?? process.platform
  const run = options.run ?? spawnSync
  if (platform === 'win32') {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
    return
  }
  const kill = options.kill ?? ((target, name) => process.kill(target, name))
  const table = options.table ?? (() => readProcessTable(run))
  const startTime = options.startTime ?? ((target) => readStartTime(target, run))
  const self = options.self ?? process.pid
  if (pid === self) return

  // A reaped child with no group left: nothing to walk.
  if (!signal(kill, pid, 0) && !signal(kill, -pid, 0)) return

  let current = table()
  const ownGroup = current?.find((entry) => entry.pid === self)?.pgid
  // Without a table, assume the usual case: the child leads its own group (spawned detached).
  const childGroup = current?.find((entry) => entry.pid === pid)?.pgid ?? pid
  const leadsGroup = childGroup === pid && pid !== ownGroup
  if (leadsGroup) signal(kill, -pid, 'SIGSTOP')
  else signal(kill, pid, 'SIGSTOP')

  const groups = new Set()
  /** Descendants no group signal covers, with their start time when found. */
  const single = new Map()
  const seen = new Set()
  for (let round = 0; round < 5 && current; round += 1) {
    let added = false
    for (const entry of descendantsOf(current, pid)) {
      if (entry.pid === self || seen.has(entry.pid)) continue
      seen.add(entry.pid)
      added = true
      if (entry.pgid === pid && leadsGroup) continue
      if (entry.pgid > 1 && entry.pgid !== ownGroup && entry.pgid !== pid) {
        if (!groups.has(entry.pgid)) {
          groups.add(entry.pgid)
          signal(kill, -entry.pgid, 'SIGSTOP')
        }
        continue
      }
      const started = startTime(entry.pid)
      if (started === undefined) continue
      single.set(entry.pid, { started, pgid: entry.pgid })
      signal(kill, entry.pid, 'SIGSTOP')
    }
    if (!added) break
    current = table()
  }

  const killedGroups = new Set()
  for (const group of groups) if (signal(kill, -group, 'SIGKILL')) killedGroups.add(group)
  const childGroupKilled = leadsGroup && signal(kill, -pid, 'SIGKILL')
  if (!childGroupKilled) signal(kill, pid, 'SIGKILL')
  for (const [descendant, { started, pgid }] of single) {
    if (killedGroups.has(pgid)) continue
    if (startTime(descendant) === started) signal(kill, descendant, 'SIGKILL')
  }
}
