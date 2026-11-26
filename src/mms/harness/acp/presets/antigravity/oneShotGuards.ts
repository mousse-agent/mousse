import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_ONE_SHOT_DIR, antigravityOneShotCliDir } from '../antigravity'

/**
 * The checks around an Antigravity one-shot (`AntigravityProviderService.oneShot`): the home's hooks and MCP servers
 * before it, the scratch folder and the session's files in `agy`'s home after it, and the sweep of what an ended
 * Mousse left behind.
 */

/** The global configuration files in an Antigravity home that would run something during a one-shot. */
const RUNNING_CONFIG = [
  { file: 'hooks.json', what: 'hooks' },
  { file: 'mcp_config.json', what: 'MCP servers' }
] as const

/** Whether a parsed configuration value sets nothing: `null`, or an empty array or object, or an object of such values. */
function setsNothing(value: unknown): boolean {
  if (value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(setsNothing)
  return false
}

/**
 * Why `geminiHome` cannot run a one-shot, or undefined when it can: its `config/hooks.json` or `config/mcp_config.json`
 * sets hooks or MCP servers, or cannot be read or parsed. A missing or blank file sets nothing (agy 1.5.17 creates an
 * empty `mcp_config.json` itself).
 */
export function antigravityOneShotRefusal(geminiHome: string): string | undefined {
  for (const { file, what } of RUNNING_CONFIG) {
    const path = join(geminiHome, 'config', file)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue
      return `Mousse can't read ${path}, so Antigravity runs no single requests.`
    }
    if (!raw.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return `${path} isn't valid JSON, so Antigravity runs no single requests.`
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${path} isn't a JSON object, so Antigravity runs no single requests.`
    if (!setsNothing(parsed)) return `${path} sets up ${what}, which could run during a single request, so Antigravity runs none.`
  }
  return undefined
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

/**
 * Whether `agy`'s saved conversation `file` belongs to the one-shot in `cwd`: it names the scratch folder's id (UTF-8
 * or UTF-16), which only this request's folder has.
 */
function conversationOf(file: string, cwd: string): boolean {
  const id = basename(cwd)
  const bytes = readFileSync(file)
  return bytes.includes(Buffer.from(id, 'utf8')) || bytes.includes(Buffer.from(id, 'utf16le'))
}

/**
 * Removes what a one-shot left in `agy`'s home `geminiHome`: its settings folder (`--cli_dir_name`, named after
 * `cwd`), and the files of `sessionId`, the session it opened (its saved conversation, notes and annotations), only
 * once its saved conversation proves to be this request's (`conversationOf`). Returns why session files were kept, if
 * they were. The shared summary database keeps its row.
 */
export function removeOneShotFiles(geminiHome: string, cwd: string, sessionId: string | undefined): string | undefined {
  const appData = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
  try { rmSync(join(appData, antigravityOneShotCliDir(cwd)), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* swept later */ }
  if (!sessionId) return undefined
  if (!SESSION_ID.test(sessionId)) return `session id ${JSON.stringify(sessionId.slice(0, 64))} is not one agy gives`
  const conversation = join(appData, 'conversations', `${sessionId}.db`)
  try {
    lstatSync(conversation)
  } catch {
    // Nothing saved: no files of this session to tell apart from another's.
    return undefined
  }
  try {
    if (!conversationOf(conversation, cwd)) return `conversation ${sessionId} does not name this request's folder`
  } catch {
    return `conversation ${sessionId} could not be read`
  }
  for (const path of [
    conversation, `${conversation}-wal`, `${conversation}-shm`,
    join(appData, 'brain', sessionId),
    join(appData, 'annotations', `${sessionId}.pbtxt`)
  ]) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* kept */ }
  }
  return undefined
}

/** A one-shot folder this old is left over from a Mousse that ended mid-request: no request runs that long. */
const LEFTOVER_AGE_MS = 30 * 60_000

/**
 * Removes one-shot folders an ended Mousse left: scratch folders under `stateDir` and settings folders in `agy`'s
 * home, older than {@link LEFTOVER_AGE_MS}. Run a while after start, never on the start path.
 */
export async function sweepOneShotLeftovers(stateDir: string, geminiHome: string, now = Date.now()): Promise<void> {
  const sweep = async (dir: string, matches: (name: string) => boolean) => {
    let names: string[]
    try { names = await readdir(dir) } catch { return }
    for (const name of names) {
      if (!matches(name)) continue
      const path = join(dir, name)
      try {
        if (now - (await stat(path)).mtimeMs < LEFTOVER_AGE_MS) continue
        await rm(path, { recursive: true, force: true })
      } catch { /* the next sweep */ }
    }
  }
  await sweep(join(stateDir, ANTIGRAVITY_ONE_SHOT_DIR), () => true)
  await sweep(join(geminiHome, ANTIGRAVITY_APP_DATA_DIR), (name) => name.startsWith(`${ANTIGRAVITY_ONE_SHOT_DIR}-`))
}
