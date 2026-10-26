// Kills a process and everything it started, across process groups. Plain JavaScript so the
// runtime check script (scripts/check-pi-runtime-install.mjs) uses the same code as the app.
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
 * parent link is lost. The tree is therefore frozen first: the child's group, then the group of
 * every descendant found, again until no new one appears. Then every group found and every
 * descendant is killed, and the child's group last. Mousse's own group is never signalled.
 *
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
  const self = options.self ?? process.pid

  // Freeze the child and its own group so nothing new starts while the tree is read.
  if (!signal(kill, -pid, 'SIGSTOP')) signal(kill, pid, 'SIGSTOP')
  const groups = new Set()
  const pids = new Set()
  let ownGroup
  for (let round = 0; round < 5; round += 1) {
    const current = table()
    if (!current) break
    ownGroup ??= current.find((entry) => entry.pid === self)?.pgid
    let added = false
    for (const entry of descendantsOf(current, pid)) {
      if (entry.pid === self || pids.has(entry.pid)) continue
      pids.add(entry.pid)
      added = true
      if (entry.pgid > 1 && entry.pgid !== pid && entry.pgid !== ownGroup && !groups.has(entry.pgid)) {
        groups.add(entry.pgid)
        signal(kill, -entry.pgid, 'SIGSTOP')
      } else signal(kill, entry.pid, 'SIGSTOP')
    }
    if (!added) break
  }
  for (const group of groups) signal(kill, -group, 'SIGKILL')
  for (const descendant of pids) signal(kill, descendant, 'SIGKILL')
  if (!signal(kill, -pid, 'SIGKILL')) signal(kill, pid, 'SIGKILL')
}
