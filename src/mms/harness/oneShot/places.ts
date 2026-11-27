import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { childKindOf, trackChildProcess } from '../../diagnostics/liveCounts'
import { recordHarnessSpawn } from '../spawn'
import { spawnProviderProcess, windowsProviderTree } from '../windowsProviderProcess'
import { PLACE_WATCHER } from './placeWatcher'

/**
 * Places: the folder a single request (a thread title and the like) runs in, owned end to end here.
 *
 * - A durable record `<profile>/one-shot-ledger/<id>.json` is written before the place `<profile>/one-shot/<id>/`
 *   exists and before any vendor code runs. It holds no prompt, title or secret, and is read back as untrusted.
 * - A place reaches `reaped` only on positive proof that its process tree drained: on Windows the job supervisor
 *   (`windowsProviderProcess.ts`) reports the job empty; on POSIX a per-request watcher (`placeWatcher.ts`) kills the
 *   process group when its pipe from the daemon closes and reports the group gone. Without proof the record stays.
 * - Deletion never follows links or junctions, rechecks the place folder's identity right before removing it, takes
 *   only uuid-named places inside the place root, and rechecks a vendor leftover's ownership at deletion time.
 * - {@link sweepPlaces} retries what ended requests left, of this Mousse or an earlier one.
 *
 * Neither the ledger folder nor the place root is ever given to an agent: the agent gets only its place.
 */

export type PlaceState = 'reserved' | 'running' | 'stopping' | 'reaped' | 'removed'

export interface PlaceRecord {
  v: 1
  id: string
  state: PlaceState
  route: string
  instanceId: string
  createdAt: number
  updatedAt: number
  /** Identity of the place folder at creation (dev and ino as strings), so deletion can recheck it. */
  dir?: { dev: string; ino: string }
  /** What to prove drained: on Windows the job supervisor's pid; on POSIX the process group id and the watcher pid. */
  tree?: { kind: 'win_job'; supervisorPid: number } | { kind: 'posix_group'; pgid: number; watcherPid?: number }
  /** Typed vendor leftovers registered during the request (path rule plus ownership proof). */
  leftovers?: LeftoverRecord[]
}

export interface Place {
  id: string
  dir: string
  ledgerPath: string
  profileDir: string
}

export interface PlaceProcess {
  child: ChildProcessWithoutNullStreams
  /**
   * Ends the whole tree (state `stopping`) and resolves `drained` only on positive proof (Windows: the job is empty;
   * POSIX: the group is gone, as the watcher reports or `kill(-pgid, 0)` says after SIGKILL), else `unproven` after
   * `timeoutMs`. Idempotent: later calls get the first call's result.
   */
  stop(timeoutMs?: number): Promise<'drained' | 'unproven'>
}

/** A vendor leftover outside the place (a session file and the like), with what proves it is this place's. */
export interface LeftoverRecord {
  kind: string
  path: string
  proof: string
}

export interface LeftoverRule {
  kind: string
  /** Whether `path` is a legal target for this kind. */
  allows(path: string): boolean
  /** Rechecked at deletion time: does the object at `path` still prove to be this place's? Never a stored flag. */
  owns(path: string, proof: string, place: Place): boolean
}

export type SweepKeptReason = 'live' | 'running' | 'young' | 'malformed' | 'not_owned' | 'remove_failed'

export interface SweepReport {
  removed: string[]
  kept: { id: string; reason: SweepKeptReason }[]
}

/** The place root and the ledger folder, under the profile. */
export const PLACE_ROOT_DIR = 'one-shot'
export const PLACE_LEDGER_DIR = 'one-shot-ledger'

/** A record with no process tree, or a place folder with no record, this old is left from a request that ended. */
export const PLACE_LEFTOVER_AGE_MS = 30 * 60_000

/** How long {@link PlaceProcess.stop} waits for proof by default. */
export const PLACE_STOP_TIMEOUT_MS = 8_000

/** A place id: what `randomUUID` gives. Anything else under the place root is not ours. */
const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LEDGER_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const LEDGER_TEMP = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json\.[0-9a-f-]{36}\.tmp$/
const STATES: readonly PlaceState[] = ['reserved', 'running', 'stopping', 'reaped', 'removed']
const RECORD_BYTES = 64 * 1024
const LEFTOVERS_MAX = 32

/** Test seam: the file operations that create and remove places, so tests can make them fail. */
export const placesFs = {
  mkdir: (path: string) => { mkdirSync(path, { mode: 0o700 }) },
  writeFile: (path: string, data: string) => { writeFileSync(path, data, { mode: 0o600, flag: 'wx' }) },
  rename: (from: string, to: string) => { renameSync(from, to) },
  unlink: (path: string) => { unlinkSync(path) },
  rmdir: (path: string) => { rmdirSync(path) }
}

/** The records of this Mousse's places that are not yet released: the sweep never touches them. */
const live = new Map<string, PlaceRecord>()

const rootOf = (profileDir: string) => join(profileDir, PLACE_ROOT_DIR)
const ledgerDirOf = (profileDir: string) => join(profileDir, PLACE_LEDGER_DIR)

function placeOf(profileDir: string, id: string): Place {
  return { id, dir: join(rootOf(profileDir), id), ledgerPath: join(ledgerDirOf(profileDir), `${id}.json`), profileDir }
}

/** Refuses a place whose id is not a uuid or whose paths are not the ones its profile and id give. */
function checkPlace(place: Place): void {
  const expected = PLACE_ID.test(place.id) ? placeOf(place.profileDir, place.id) : undefined
  if (!expected || expected.dir !== place.dir || expected.ledgerPath !== place.ledgerPath) throw new Error('Not a place this module made.')
}

/** Whether `path` lies strictly inside `root`. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Writes the record atomically: a fresh temporary file (0o600) renamed over the ledger file. */
function writeRecord(ledgerPath: string, record: PlaceRecord): void {
  const temp = `${ledgerPath}.${randomUUID()}.tmp`
  placesFs.writeFile(temp, JSON.stringify(record))
  try {
    placesFs.rename(temp, ledgerPath)
  } catch (error) {
    try { placesFs.unlink(temp) } catch { /* the sweep removes stale temporary files */ }
    throw error
  }
}

/** Moves a live place's record on, in memory and on disk. A failed write is reported; the memory copy still guards. */
function mark(place: Place, patch: Partial<PlaceRecord>): PlaceRecord | undefined {
  const current = live.get(place.id)
  if (!current) return undefined
  const next = { ...current, ...patch, updatedAt: Date.now() }
  live.set(place.id, next)
  try {
    writeRecord(place.ledgerPath, next)
  } catch (error) {
    console.warn('[one-shot] a place record could not be written', { id: place.id, state: next.state, error: String(error) })
  }
  return next
}

function realFolder(path: string): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

const shortText = (value: string) => value.length > 0 && value.length <= 256

/**
 * Writes `<profile>/one-shot-ledger/<uuid>.json` (state reserved, 0o600, atomic) before creating
 * `<profile>/one-shot/<uuid>/` (0o700), then records the folder's identity. Throws on failure, leaving no folder.
 */
export function reservePlace(profileDir: string, meta: { route: string; instanceId: string }): Place {
  if (!shortText(meta.route) || !shortText(meta.instanceId)) throw new TypeError('A place needs a route and an instance id.')
  const place = placeOf(profileDir, randomUUID())
  const now = Date.now()
  const record: PlaceRecord = { v: 1, id: place.id, state: 'reserved', route: meta.route, instanceId: meta.instanceId, createdAt: now, updatedAt: now }
  mkdirSync(ledgerDirOf(profileDir), { recursive: true, mode: 0o700 })
  if (!realFolder(ledgerDirOf(profileDir))) throw new Error('The place ledger is not a folder.')
  writeRecord(place.ledgerPath, record)
  let made = false
  try {
    mkdirSync(rootOf(profileDir), { recursive: true, mode: 0o700 })
    if (!realFolder(rootOf(profileDir))) throw new Error('The place root is not a folder.')
    placesFs.mkdir(place.dir)
    made = true
    const stats = lstatSync(place.dir, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('The place is not a folder.')
    const reserved: PlaceRecord = { ...record, dir: { dev: String(stats.dev), ino: String(stats.ino) }, updatedAt: Date.now() }
    writeRecord(place.ledgerPath, reserved)
    live.set(place.id, reserved)
    return place
  } catch (error) {
    let folderGone = !made
    if (made) try { placesFs.rmdir(place.dir); folderGone = true } catch { /* the record stays so the sweep finds it */ }
    if (folderGone) try { placesFs.unlink(place.ledgerPath) } catch { /* an old record with no tree is swept */ }
    throw error
  }
}

/** Whether process `pid` runs (or exists and is not ours to signal). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether process group `pgid` is gone: only ESRCH proves it. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Whether a recorded tree has drained, from outside: on Windows the supervisor is gone, so its job handle closed and
 * the kernel ended the tree (the job is KILL_ON_JOB_CLOSE and only the supervisor holds it); on POSIX the group is
 * gone. A running pid may be another program's (PID reuse): that is not proof, and nothing here ever signals it.
 */
function treeGone(tree: NonNullable<PlaceRecord['tree']>): boolean {
  if (tree.kind === 'win_job') return process.platform === 'win32' && !running(tree.supervisorPid)
  return process.platform !== 'win32' && groupGone(tree.pgid)
}

/**
 * Spawns `command args` in the place with exactly `env`, piped stdio and no window. The working folder is the place, or
 * `cwd` when given, which must be an existing folder inside the place (by path and once links are resolved). Windows: through
 * the job supervisor. POSIX: in its own process group, with a per-request watcher holding a pipe from the daemon.
 * Records state `running` with the tree before returning.
 */
export function spawnInPlace(
  place: Place,
  launch: { command: string; args: string[]; env: NodeJS.ProcessEnv; purpose: string; instanceId: string; cwd?: string }
): PlaceProcess {
  checkPlace(place)
  const record = live.get(place.id)
  if (!record || record.state !== 'reserved') throw new Error('A place runs one process, once reserved.')
  const cwd = launch.cwd === undefined ? place.dir : resolve(launch.cwd)
  if (cwd !== place.dir && !(inside(place.dir, cwd) && realFolder(cwd) && inside(realpathSync(place.dir), realpathSync(cwd))))
    throw new Error('A place\'s process runs inside the place.')
  const { command, args, env } = launch
  recordHarnessSpawn({ instanceId: launch.instanceId, purpose: launch.purpose, command, args, env })
  const windows = process.platform === 'win32'
  let child: ChildProcessWithoutNullStreams
  let watcher: ChildProcessWithoutNullStreams | undefined
  let watcherEmpty: Promise<void> | undefined
  if (windows) {
    child = spawnProviderProcess(command, args, { cwd, env })
  } else {
    // Own process group, so the whole tree can be signalled and probed as one.
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: 'pipe', detached: !windows })
    child.on('error', () => { /* no pid: nothing ran, stop() resolves drained */ })
    if (child.pid !== undefined) {
      const started = spawn(process.execPath, ['-e', PLACE_WATCHER, String(child.pid)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: 'pipe',
        // Out of the daemon's group, so a signal to the daemon's group leaves the watcher to clean up.
        detached: !windows
      })
      started.on('error', () => { /* stop() falls back to probing the group */ })
      started.stdin.on('error', () => { /* the watcher already ended */ })
      started.stderr.resume()
      started.unref()
      watcherEmpty = new Promise((resolve) => {
        let text = ''
        started.stdout.setEncoding('utf8')
        started.stdout.on('data', (chunk: string) => {
          text += chunk
          if (text.includes('empty')) resolve()
        })
      })
      watcher = started
    }
  }
  trackChildProcess(child, childKindOf(command))
  const pid = child.pid
  const tree: PlaceRecord['tree'] = pid === undefined
    ? undefined
    : windows ? { kind: 'win_job', supervisorPid: pid } : { kind: 'posix_group', pgid: pid, ...(watcher?.pid ? { watcherPid: watcher.pid } : {}) }
  mark(place, { state: 'running', ...(tree ? { tree } : {}) })

  let stopPoll = () => {}
  /** True on positive proof that the tree drained. */
  const drained = (): Promise<boolean> => {
    if (pid === undefined) return Promise.resolve(true)
    if (windows) {
      const job = windowsProviderTree(child)
      return job ? job.stop().then(() => true, () => false) : Promise.resolve(false)
    }
    return new Promise((resolve) => {
      void watcherEmpty?.then(() => resolve(true))
      // Closing the pipe is the watcher's cue; the daemon also kills and probes the group itself.
      watcher?.stdin.destroy()
      try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      const poll = setInterval(() => {
        if (groupGone(pid)) resolve(true)
        else try { process.kill(-pid, 'SIGKILL') } catch { /* gone meanwhile */ }
      }, 25)
      stopPoll = () => clearInterval(poll)
    })
  }
  let stopping: Promise<'drained' | 'unproven'> | undefined
  const stop = (timeoutMs = PLACE_STOP_TIMEOUT_MS) => {
    stopping ??= new Promise((resolve) => {
      mark(place, { state: 'stopping' })
      const timer = setTimeout(() => resolve('unproven'), timeoutMs)
      void drained().then((proven) => {
        clearTimeout(timer)
        resolve(proven ? 'drained' : 'unproven')
      })
    }).finally(() => stopPoll()) as Promise<'drained' | 'unproven'>
    return stopping
  }
  return { child, stop }
}

/** Registers a typed leftover target in the place's record. */
export function addLeftover(place: Place, leftover: LeftoverRecord): void {
  checkPlace(place)
  const record = live.get(place.id)
  if (!record) throw new Error('The place is not live.')
  if (!validLeftover(leftover)) throw new TypeError('A leftover needs a kind, an absolute path and a proof.')
  mark(place, { leftovers: [...(record.leftovers ?? []), { kind: leftover.kind, path: leftover.path, proof: leftover.proof }] })
}

/** How far into a place the check of what the agent wrote looks, and how many entries it reads, before it gives up. */
const WRITTEN_DEPTH = 8
const WRITTEN_ENTRIES = 1_000

/**
 * What a request left in its place besides empty folders, as a path inside it; undefined when nothing. A link counts
 * as something; so does a folder too deep or too full to read through.
 */
export function leftInPlace(dir: string): string | undefined {
  let seen = 0
  const walk = (folder: string, depth: number): string | undefined => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (++seen > WRITTEN_ENTRIES || !entry.isDirectory() || entry.isSymbolicLink()) return relative(dir, path)
      if (depth >= WRITTEN_DEPTH) return relative(dir, path)
      const found = walk(path, depth + 1)
      if (found) return found
    }
    return undefined
  }
  try {
    return walk(dir, 0)
  } catch {
    return '(the folder could not be read)'
  }
}

/** Removes a link or junction itself, never what it points at. */
function removeEntry(path: string, stats: Stats): void {
  try {
    placesFs.unlink(path)
  } catch (error) {
    // A junction or directory link on Windows can need RemoveDirectory, which removes the link and not its target.
    if (stats.isSymbolicLink()) placesFs.rmdir(path)
    else throw error
  }
}

/** Removes `start` and everything under it without following a link or junction. Throws when something stays. */
function removeTree(start: string): void {
  const top = lstatSync(start)
  if (top.isSymbolicLink() || !top.isDirectory()) return removeEntry(start, top)
  const stack: { path: string; listed: boolean }[] = [{ path: start, listed: false }]
  while (stack.length) {
    const item = stack[stack.length - 1]!
    if (item.listed) {
      placesFs.rmdir(item.path)
      stack.pop()
      continue
    }
    item.listed = true
    for (const name of readdirSync(item.path)) {
      const path = join(item.path, name)
      const stats = lstatSync(path)
      if (stats.isDirectory() && !stats.isSymbolicLink()) stack.push({ path, listed: false })
      else removeEntry(path, stats)
    }
  }
}

type FolderCheck = 'missing' | 'ours' | 'unknown' | 'not_owned'

/** Whether the place folder is still the one made for the record: a real folder with the recorded dev and ino. */
function checkFolder(dir: string, identity: PlaceRecord['dir']): FolderCheck {
  let stats
  try {
    stats = lstatSync(dir, { bigint: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not_owned'
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return 'not_owned'
  if (!identity) return 'unknown'
  return String(stats.dev) === identity.dev && String(stats.ino) === identity.ino ? 'ours' : 'not_owned'
}

function olderThan(path: string, ms: number, now: number): boolean {
  try { return now - lstatSync(path).mtimeMs >= ms } catch { return false }
}

/**
 * What the agent wrote in the place, or only in its subfolder `sub` when given (the rest holds the process's own home
 * and temporary folders), as a path inside the place. A missing subfolder holds nothing; one that is a link, or that
 * resolves outside the place, counts as written.
 */
function writtenUnder(dir: string, sub: string | undefined): string | undefined {
  if (sub === undefined) return leftInPlace(dir)
  const folder = join(dir, sub)
  try {
    lstatSync(folder)
  } catch {
    return undefined
  }
  if (!realFolder(folder) || !inside(realpathSync(dir), realpathSync(folder))) return sub
  const found = leftInPlace(folder)
  return found === undefined ? undefined : join(sub, found)
}

type CleanResult = { result: 'removed' | 'not_owned' | 'malformed' | 'remove_failed'; written?: string }

/**
 * Removes an ended request's place and owned leftovers, then its record. Call only once its tree is proven drained.
 * The folder must still be the recorded one (identity unknown counts only for a sweep, on a folder that has aged).
 */
function cleanEnded(place: Place, record: PlaceRecord, rules: readonly LeftoverRule[], unknownFolderOk: boolean, writtenIn?: string): CleanResult {
  const root = rootOf(place.profileDir)
  if (!inside(root, place.dir)) return { result: 'not_owned' }
  const folder = checkFolder(place.dir, record.dir)
  if (folder === 'not_owned' || (folder === 'unknown' && !unknownFolderOk)) return { result: 'not_owned' }
  const leftovers = (record.leftovers ?? []).map((leftover) => ({ leftover, rule: rules.find((rule) => rule.kind === leftover.kind) }))
  if (leftovers.some(({ rule }) => !rule)) return { result: 'not_owned' }
  if (leftovers.some(({ leftover, rule }) => !rule!.allows(leftover.path))) return { result: 'malformed' }
  const written = folder === 'missing' ? undefined : writtenUnder(place.dir, writtenIn)
  for (const { leftover, rule } of leftovers) {
    try {
      lstatSync(leftover.path)
    } catch {
      continue
    }
    let owned = false
    try {
      owned = rule!.owns(leftover.path, leftover.proof, place)
    } catch {
      return { result: 'not_owned', written }
    }
    if (!owned) {
      console.warn('[one-shot] a leftover no longer proves to be this request\'s and was kept', { id: place.id, kind: leftover.kind })
      continue
    }
    try { removeTree(leftover.path) } catch { return { result: 'remove_failed', written } }
  }
  if (folder !== 'missing') {
    // Recheck right before removing: the folder must still be the recorded one.
    if (checkFolder(place.dir, record.dir) !== folder) return { result: 'not_owned', written }
    try { removeTree(place.dir) } catch { return { result: 'remove_failed', written } }
  }
  if (live.has(place.id)) mark(place, { state: 'removed' })
  try { placesFs.unlink(place.ledgerPath) } catch { return { result: 'remove_failed', written } }
  return { result: 'removed', written }
}

/**
 * After the request: stops its tree. Without proof the record stays (state stopping) for the sweep. With proof the
 * place is `reaped`, what the agent wrote is noted (only inside `options.written`, a relative subfolder, when given),
 * the whole place and owned leftovers are removed, then the record. Removal failures keep the record for the sweep.
 */
export async function releasePlace(
  place: Place,
  proc: PlaceProcess | undefined,
  rules: readonly LeftoverRule[] = [],
  options: { written?: string } = {}
): Promise<{ reaped: boolean; written?: string; removed: boolean }> {
  checkPlace(place)
  const writtenIn = options.written
  if (writtenIn !== undefined && (isAbsolute(writtenIn) || !inside(place.dir, join(place.dir, writtenIn))))
    throw new Error('The written check looks only inside the place.')
  try {
    const record = live.get(place.id) ?? readRecord(place).record
    if (!record) return { reaped: false, removed: false }
    const drained = proc ? (await proc.stop()) === 'drained' : !record.tree || treeGone(record.tree)
    if (!drained) return { reaped: false, removed: false }
    mark(place, { state: 'reaped' })
    const { result, written } = cleanEnded(place, live.get(place.id) ?? record, rules, false, writtenIn)
    if (result !== 'removed') console.warn('[one-shot] a place was kept for the sweep', { id: place.id, reason: result })
    return { reaped: true, ...(written !== undefined ? { written } : {}), removed: result === 'removed' }
  } finally {
    live.delete(place.id)
  }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const pid = (value: unknown, min = 1) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 0x7fffffff
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function validLeftover(value: unknown): value is LeftoverRecord {
  return plain(value) && onlyKeys(value, ['kind', 'path', 'proof'])
    && typeof value.kind === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.kind)
    && typeof value.path === 'string' && value.path.length <= 4096 && !value.path.includes('\0') && isAbsolute(value.path)
    && typeof value.proof === 'string' && value.proof.length > 0 && value.proof.length <= 512
}

/** Validates a record read from disk. Returns the record, or why it is malformed. */
function parseRecord(text: string, id: string): PlaceRecord | string {
  let value: unknown
  try { value = JSON.parse(text) } catch { return 'not JSON' }
  if (!plain(value)) return 'not an object'
  if (!onlyKeys(value, ['v', 'id', 'state', 'route', 'instanceId', 'createdAt', 'updatedAt', 'dir', 'tree', 'leftovers'])) return 'unknown field'
  if (value.v !== 1) return 'unknown version'
  if (value.id !== id) return 'id does not match the file'
  if (!STATES.includes(value.state as PlaceState)) return 'unknown state'
  if (typeof value.route !== 'string' || !shortText(value.route) || typeof value.instanceId !== 'string' || !shortText(value.instanceId)) return 'bad route or instance'
  if (!time(value.createdAt) || !time(value.updatedAt)) return 'bad times'
  const dir = value.dir
  if (dir !== undefined && !(plain(dir) && onlyKeys(dir, ['dev', 'ino']) && typeof dir.dev === 'string' && /^\d{1,40}$/.test(dir.dev)
    && typeof dir.ino === 'string' && /^\d{1,40}$/.test(dir.ino))) return 'bad folder identity'
  const tree = value.tree
  if (tree !== undefined) {
    const ok = plain(tree) && (
      (tree.kind === 'win_job' && onlyKeys(tree, ['kind', 'supervisorPid']) && pid(tree.supervisorPid))
      || (tree.kind === 'posix_group' && onlyKeys(tree, ['kind', 'pgid', 'watcherPid']) && pid(tree.pgid, 2) && (tree.watcherPid === undefined || pid(tree.watcherPid, 2))))
    if (!ok) return 'bad process tree'
  }
  const leftovers = value.leftovers
  if (leftovers !== undefined && !(Array.isArray(leftovers) && leftovers.length <= LEFTOVERS_MAX && leftovers.every(validLeftover))) return 'bad leftovers'
  return value as unknown as PlaceRecord
}

/** Reads a place's ledger record as untrusted input: a regular file, small, of the strict shape. */
function readRecord(place: Place): { record?: PlaceRecord; malformed?: string; mtimeMs?: number } {
  try {
    const stats = lstatSync(place.ledgerPath)
    if (!stats.isFile()) return { malformed: 'not a file' }
    if (stats.size > RECORD_BYTES) return { malformed: 'too large' }
    const parsed = parseRecord(readFileSync(place.ledgerPath, 'utf8'), place.id)
    return typeof parsed === 'string' ? { malformed: parsed } : { record: parsed, mtimeMs: stats.mtimeMs }
  } catch (error) {
    return { malformed: `unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
  }
}

function list(dir: string): string[] {
  try { return realFolder(dir) ? readdirSync(dir) : [] } catch { return [] }
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Cleans what ended requests left, of this Mousse or an earlier one. Every record is untrusted: a malformed one is
 * kept and reported, never acted on. Places live here are skipped. A recorded tree must be proven drained (a running
 * pid is never signalled; it may be another program's). A record with no tree is retried while younger than
 * {@link PLACE_LEFTOVER_AGE_MS}, then treated as never spawned. A uuid-named place folder with no record is removed
 * once that old. Run a while after start, never on the start path.
 */
export async function sweepPlaces(profileDir: string, rules: readonly LeftoverRule[] = [], now = Date.now()): Promise<SweepReport> {
  const report: SweepReport = { removed: [], kept: [] }
  const ledgerDir = ledgerDirOf(profileDir)
  const root = rootOf(profileDir)
  const recorded = new Set<string>()
  for (const name of list(ledgerDir)) {
    const temp = LEDGER_TEMP.exec(name)
    if (temp) {
      if (!live.has(temp[1]!) && olderThan(join(ledgerDir, name), PLACE_LEFTOVER_AGE_MS, now)) try { placesFs.unlink(join(ledgerDir, name)) } catch { /* next sweep */ }
      continue
    }
    const id = LEDGER_FILE.exec(name)?.[1]
    if (!id) continue
    recorded.add(id)
    if (live.has(id)) {
      report.kept.push({ id, reason: 'live' })
      continue
    }
    const place = placeOf(profileDir, id)
    const { record, malformed, mtimeMs } = readRecord(place)
    if (!record) {
      console.warn('[one-shot] a place record is malformed and was kept', { id, reason: malformed })
      report.kept.push({ id, reason: 'malformed' })
      continue
    }
    if (record.tree ? !treeGone(record.tree) : now - (mtimeMs ?? now) < PLACE_LEFTOVER_AGE_MS) {
      report.kept.push({ id, reason: record.tree ? 'running' : 'young' })
      continue
    }
    const unknownFolderOk = olderThan(place.dir, PLACE_LEFTOVER_AGE_MS, now)
    const { result } = cleanEnded(place, record, rules, unknownFolderOk)
    if (result === 'removed') report.removed.push(id)
    else report.kept.push({ id, reason: result })
    await pause()
  }
  for (const name of list(root)) {
    if (!PLACE_ID.test(name) || recorded.has(name) || live.has(name)) continue
    const path = join(root, name)
    if (!olderThan(path, PLACE_LEFTOVER_AGE_MS, now)) {
      report.kept.push({ id: name, reason: 'young' })
      continue
    }
    try {
      removeTree(path)
      report.removed.push(name)
    } catch {
      report.kept.push({ id: name, reason: 'remove_failed' })
    }
    await pause()
  }
  return report
}
