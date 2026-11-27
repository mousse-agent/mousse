import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { LeftoverRecord, LeftoverRule, Place } from '../../../oneShot/places'
import { ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_ONE_SHOT_DIR } from '../antigravity'

/**
 * What an Antigravity single request leaves outside its place (`oneShot/places.ts`), as typed leftovers removed with
 * the place, by its release or by the places sweep:
 * - its settings folder in the entry's app data, `one-shot-<place id>` (`--cli_dir_name`);
 * - on `agy`, the files of the session it opened in that app data, once its saved conversation names the place.
 *
 * Ownership is read again from the object itself at removal time, never from a stored flag.
 */

/** A request id: what `randomUUID` gives. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A session id `agy` gives: letters, digits and dashes, so it names a file of its own and never a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

/** The leftover kinds (`LeftoverRecord.kind`). */
export const AGY_SETTINGS_LEFTOVER = 'agy_settings'
export const AGY_SESSION_LEFTOVER = 'agy_session'

/** The files `agy` keeps for session `sessionId` in its app data: notes, annotations, then its saved conversation last. */
function sessionFiles(appData: string, sessionId: string): string[] {
  const conversation = join(appData, 'conversations', `${sessionId}.db`)
  return [join(appData, 'brain', sessionId), join(appData, 'annotations', `${sessionId}.pbtxt`), `${conversation}-wal`, `${conversation}-shm`, conversation]
}

/** Whether the saved conversation of `sessionId` in `appData` names place `id` (its folder's path holds the id). */
function conversationNames(appData: string, sessionId: string, id: string): boolean {
  const conversation = join(appData, 'conversations', `${sessionId}.db`)
  const stats = lstatSync(conversation)
  if (!stats.isFile()) return false
  const bytes = readFileSync(conversation)
  return bytes.includes(Buffer.from(id, 'utf8')) || bytes.includes(Buffer.from(id, 'utf16le'))
}

/** The session's files to register as leftovers of `place`, in removal order: the conversation that proves them goes last. */
export function sessionLeftovers(appData: string, sessionId: string): LeftoverRecord[] {
  if (!SESSION_ID.test(sessionId)) return []
  return sessionFiles(appData, sessionId).map((path) => ({ kind: AGY_SESSION_LEFTOVER, path, proof: sessionId }))
}

/** The settings folder of a single request in `appData`, as a leftover of the place `placeId`. */
export function settingsLeftover(appData: string, placeId: string): LeftoverRecord {
  return { kind: AGY_SETTINGS_LEFTOVER, path: join(appData, `${ANTIGRAVITY_ONE_SHOT_DIR}-${placeId}`), proof: placeId }
}

const inAppData = (path: string, levels: 1 | 2): boolean => {
  if (!isAbsolute(path)) return false
  const appData = levels === 1 ? dirname(path) : dirname(dirname(path))
  return basename(appData) === ANTIGRAVITY_APP_DATA_DIR
}

/** The rules the places sweep and a release read Antigravity's leftovers by. */
export const ANTIGRAVITY_LEFTOVER_RULES: readonly LeftoverRule[] = Object.freeze([
  {
    kind: AGY_SETTINGS_LEFTOVER,
    allows: (path: string) => inAppData(path, 1) && REQUEST_ID.test(basename(path).slice(ANTIGRAVITY_ONE_SHOT_DIR.length + 1)) && basename(path).startsWith(`${ANTIGRAVITY_ONE_SHOT_DIR}-`),
    // Named after this place's id, which no other request has.
    owns: (path: string, proof: string, place: Place) => proof === place.id && basename(path) === `${ANTIGRAVITY_ONE_SHOT_DIR}-${place.id}`
  },
  {
    kind: AGY_SESSION_LEFTOVER,
    allows: (path: string) => inAppData(path, 2) && ['brain', 'annotations', 'conversations'].includes(basename(dirname(path))),
    // One of the session's own files, and its saved conversation names this place.
    owns: (path: string, proof: string, place: Place) => {
      if (!SESSION_ID.test(proof)) return false
      const appData = dirname(dirname(path))
      return sessionFiles(appData, proof).includes(path) && conversationNames(appData, proof, place.id)
    }
  }
])

/** Test seam: how the files older versions left are removed. */
export const legacyOneShotFs = {
  rm: (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** A folder older versions left with no record this old is from a request that ended. */
const LEFTOVER_AGE_MS = 30 * 60_000

function names(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function olderThan(path: string, ms: number, now: number): boolean {
  try { return now - statSync(path).mtimeMs >= ms } catch { return true }
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

/**
 * Removes what single requests of older versions left in an entry's own folders (`<state>/one-shot/<id>`,
 * `one-shot-homes/<id>` beside its `gemini-home`, and `one-shot-<id>` in its app data), now that requests run in places.
 * A request is skipped while its recorded process runs, and while its folders are younger than 30 minutes; session
 * files are left to `agy`. Runs in the places sweep (`schedulePlaceSweep`), never on the start path.
 */
export function sweepLegacyAntigravityOneShots(profileHome: string, now = Date.now()): void {
  const entries = [{ stateDir: join(profileHome, 'providers', 'antigravity'), geminiHome: join(profileHome, 'providers', 'antigravity', 'gemini-home') }]
  for (const name of names(join(profileHome, 'harness'))) {
    const stateDir = join(profileHome, 'harness', name)
    entries.push({ stateDir, geminiHome: join(stateDir, 'home', 'gemini-home') })
  }
  for (const { stateDir, geminiHome } of entries) {
    const scratchRoot = join(stateDir, ANTIGRAVITY_ONE_SHOT_DIR)
    const homesRoot = join(dirname(geminiHome), 'one-shot-homes')
    const appData = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
    const ids = new Set<string>([...names(scratchRoot), ...names(homesRoot)])
    for (const name of names(appData)) if (name.startsWith(`${ANTIGRAVITY_ONE_SHOT_DIR}-`)) ids.add(name.slice(ANTIGRAVITY_ONE_SHOT_DIR.length + 1))
    for (const id of ids) {
      if (!REQUEST_ID.test(id)) continue
      const paths = [join(appData, `${ANTIGRAVITY_ONE_SHOT_DIR}-${id}`), join(scratchRoot, id), join(homesRoot, id)]
      let pid: unknown
      try { pid = (JSON.parse(readFileSync(join(homesRoot, id, 'mousse-one-shot.json'), 'utf8')) as { pid?: unknown }).pid } catch { /* no record */ }
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && running(pid)) continue
      if (!paths.every((path) => olderThan(path, LEFTOVER_AGE_MS, now))) continue
      for (const path of paths) {
        try { legacyOneShotFs.rm(path) } catch { /* the next sweep */ }
      }
    }
  }
}
