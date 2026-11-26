import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_ONE_SHOT_DIR, ANTIGRAVITY_ONE_SHOT_HOMES_DIR, antigravityOneShotCliDir, antigravityOneShotHome } from '../antigravity'

/**
 * The files around an Antigravity one-shot (`AntigravityProviderService.oneShot`). Each request has an id and:
 * - a scratch folder (`<state>/one-shot/<id>`), its workspace and working folder;
 * - an empty home (`<entry>/one-shot-homes/<id>`, `antigravityOneShotHome`), its `--gemini-dir`, holding the request's
 *   record ({@link OneShotRecord});
 * - a settings folder in the entry's app data (`one-shot-<id>`, `--cli_dir_name`);
 * - on `agy`, the files of the session it opened, in the entry's app data.
 *
 * They are inspected or removed only once the request's process has ended. A request of this Mousse stays
 * {@link liveOneShots} until then; one of another Mousse counts as running while its recorded process does. What
 * cannot be removed is reported, kept in the record, and tried again.
 */

/** The ids of this Mousse's one-shots whose process may still run: the sweep never touches their files. */
const liveOneShots = new Set<string>()

/** Test seam: how the one-shot files are removed. */
export const oneShotFs = {
  rm: (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** A one-shot's paths, from its entry's state folder, its `gemini-home` and its id. */
export interface OneShotPaths {
  id: string
  cwd: string
  home: string
  appData: string
  settings: string
}

export function oneShotPaths(stateDir: string, geminiHome: string, id: string): OneShotPaths {
  const cwd = join(stateDir, ANTIGRAVITY_ONE_SHOT_DIR, id)
  const appData = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
  return { id, cwd, home: antigravityOneShotHome(geminiHome, cwd), appData, settings: join(appData, antigravityOneShotCliDir(cwd)) }
}

/** What a request's home records about it, so that a later sweep (of this Mousse or the next) knows what is its. */
export interface OneShotRecord {
  /** The agent process, once started: while it runs, the request's files stay. */
  pid?: number
  /** The session it opened, on `agy`. */
  sessionId?: string
  /** The saved conversation proved to be this request's (`conversationOf`): its files may go. */
  owned?: boolean
  /** On `agy`: the session's files are the request's to remove. */
  native?: boolean
}

const RECORD = 'mousse-one-shot.json'

function readRecord(home: string): OneShotRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home, RECORD), 'utf8')) as Record<string, unknown>
    return {
      ...(typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      ...(value.owned === true ? { owned: true } : {}),
      ...(value.native === true ? { native: true } : {})
    }
  } catch {
    return undefined
  }
}

/** Merges `patch` into the request's record. */
export function recordOneShot(paths: OneShotPaths, patch: OneShotRecord): void {
  try {
    writeFileSync(join(paths.home, RECORD), JSON.stringify({ ...readRecord(paths.home), ...patch }), { mode: 0o600 })
  } catch (error) {
    console.warn('[antigravity] a single request could not be recorded', { id: paths.id, error: String(error) })
  }
}

/** Makes the request's scratch folder and home, records it, and marks it live until {@link finishOneShot}. */
export function beginOneShot(paths: OneShotPaths, record: OneShotRecord): void {
  liveOneShots.add(paths.id)
  mkdirSync(paths.cwd, { recursive: true, mode: 0o700 })
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  recordOneShot(paths, record)
}

/** How far into a one-shot's scratch folder the check looks, and how many entries it reads, before it gives up (and fails). */
const SCRATCH_DEPTH = 8
const SCRATCH_ENTRIES = 1_000

/**
 * What a one-shot left in its scratch folder `cwd` besides empty folders (the runtime's own), as a path inside it;
 * undefined when nothing. A link counts as something; so does a folder too deep or too full to read through.
 */
export function leftInScratch(cwd: string): string | undefined {
  let seen = 0
  const walk = (dir: string, depth: number): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (++seen > SCRATCH_ENTRIES || !entry.isDirectory() || entry.isSymbolicLink()) return relative(cwd, path)
      if (depth >= SCRATCH_DEPTH) return relative(cwd, path)
      const found = walk(path, depth + 1)
      if (found) return found
    }
    return undefined
  }
  try {
    return walk(cwd, 0)
  } catch {
    return '(the folder could not be read)'
  }
}

/** A session id `agy` gives: letters, digits and dashes, so it names a file of its own and never a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

/** The files `agy` keeps for session `sessionId` in its app data: its saved conversation, notes and annotations. */
function sessionFiles(appData: string, sessionId: string): string[] {
  const conversation = join(appData, 'conversations', `${sessionId}.db`)
  return [conversation, `${conversation}-wal`, `${conversation}-shm`, join(appData, 'brain', sessionId), join(appData, 'annotations', `${sessionId}.pbtxt`)]
}

/**
 * Whether the session's saved conversation belongs to the request `id`: it names the request's scratch folder, whose
 * name is the id (UTF-8 or UTF-16), which no other request's has. True, false, or why it could not tell.
 */
function ownsConversation(appData: string, sessionId: string, id: string): true | 'nothing saved' | string {
  if (!SESSION_ID.test(sessionId)) return `session id ${JSON.stringify(sessionId.slice(0, 64))} is not one agy gives`
  const conversation = sessionFiles(appData, sessionId)[0]
  try {
    lstatSync(conversation)
  } catch {
    return 'nothing saved'
  }
  try {
    const bytes = readFileSync(conversation)
    if (bytes.includes(Buffer.from(id, 'utf8')) || bytes.includes(Buffer.from(id, 'utf16le'))) return true
    return `conversation ${sessionId} does not name this request's folder`
  } catch {
    return `conversation ${sessionId} could not be read`
  }
}

/** Removes each of `paths`; returns those that stayed. */
function removeAll(paths: string[]): string[] {
  const failed: string[] = []
  for (const path of paths) {
    try { oneShotFs.rm(path) } catch { failed.push(path) }
  }
  return failed
}

/**
 * Removes what an ended request left: its settings folder and scratch folder and, on `agy`, its session's files once
 * its saved conversation proves to be this request's. The home and its record go last, only when everything else
 * went; otherwise they stay for the next try. Returns the paths that stayed. Never call it while the process runs.
 */
function cleanUp(paths: OneShotPaths, record: OneShotRecord | undefined): string[] {
  const failed = removeAll([paths.settings, paths.cwd])
  if (record?.native && record.sessionId) {
    let owned = record.owned === true
    if (!owned) {
      const verdict = ownsConversation(paths.appData, record.sessionId, paths.id)
      if (verdict === true) {
        owned = true
        recordOneShot(paths, { owned: true })
      } else if (verdict !== 'nothing saved') console.warn('[antigravity] a single request\'s session files were kept', { id: paths.id, reason: verdict })
    }
    if (owned) failed.push(...removeAll(sessionFiles(paths.appData, record.sessionId)))
  }
  if (!failed.length) failed.push(...removeAll([paths.home]))
  return failed
}

/** When a request's files that stayed are tried again, after its first cleanup. */
export const ONE_SHOT_RETRY_MS: readonly number[] = [10_000, 60_000, 5 * 60_000]

/**
 * The request's process has ended: removes its files ({@link cleanUp}) and ends its live mark. What stays is reported
 * and tried again after each of {@link ONE_SHOT_RETRY_MS}; after that the sweep keeps trying.
 */
export function finishOneShot(paths: OneShotPaths): void {
  liveOneShots.delete(paths.id)
  retry(paths, 0)
}

function retry(paths: OneShotPaths, attempt: number): void {
  if (liveOneShots.has(paths.id)) return
  const failed = cleanUp(paths, readRecord(paths.home))
  if (!failed.length) return
  const later = ONE_SHOT_RETRY_MS[attempt]
  console.warn('[antigravity] a single request\'s files could not be removed', { id: paths.id, paths: failed, retry: later ? `${later / 1000} s` : 'next sweep' })
  if (later === undefined) return
  setTimeout(() => retry(paths, attempt + 1), later).unref?.()
}

/** Whether process `pid` runs (or exists and is not this user's to signal). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A request id: what `randomUUID` gives. Anything else in the one-shot folders is not Mousse's to remove. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A folder with no record this old is left over from a Mousse that ended mid-request: no request runs that long. */
const LEFTOVER_AGE_MS = 30 * 60_000

function youngerThan(path: string, ms: number, now: number): boolean {
  try { return now - statSync(path).mtimeMs < ms } catch { return false }
}

/**
 * Removes what ended one-shots left, of this Mousse or an earlier one: each request whose id is in the scratch
 * folders under `stateDir`, the homes beside `geminiHome` or the settings folders in its app data. A request is
 * skipped while it is live here, while its recorded process runs, or, with no record, while its folders are younger
 * than {@link LEFTOVER_AGE_MS}. Run a while after start, never on the start path.
 */
export function sweepOneShotLeftovers(stateDir: string, geminiHome: string, now = Date.now()): void {
  const ids = new Set<string>()
  const appData = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
  const settingsPrefix = `${ANTIGRAVITY_ONE_SHOT_DIR}-`
  const names = (dir: string) => { try { return readdirSync(dir) } catch { return [] } }
  for (const name of names(join(stateDir, ANTIGRAVITY_ONE_SHOT_DIR))) ids.add(name)
  for (const name of names(join(geminiHome, '..', ANTIGRAVITY_ONE_SHOT_HOMES_DIR))) ids.add(name)
  for (const name of names(appData)) if (name.startsWith(settingsPrefix)) ids.add(name.slice(settingsPrefix.length))
  for (const id of ids) {
    if (!REQUEST_ID.test(id) || liveOneShots.has(id)) continue
    const paths = oneShotPaths(stateDir, geminiHome, id)
    const record = readRecord(paths.home)
    if (record?.pid !== undefined && running(record.pid)) continue
    if (!record && [paths.cwd, paths.home, paths.settings].some((path) => youngerThan(path, LEFTOVER_AGE_MS, now))) continue
    const failed = cleanUp(paths, record)
    if (failed.length) console.warn('[antigravity] a single request\'s files could not be removed', { id, paths: failed, retry: 'next sweep' })
  }
}
