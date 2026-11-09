import { createHmac, randomBytes } from 'node:crypto'
import { constants, copyFileSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { atomicWriteFileSync } from '../../../data/AtomicFs'
import { VENDOR_SETTINGS_CHANGED, type VendorSettingEntry, type VendorSettingsView } from '../../../../shared/harness/vendorSettings'

/**
 * Claude Code's own `settings.json` in the account home an entry runs with (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`), as Settings → Providers shows and edits it: the API base URL, the key or token, the
 * default model and the `CLAUDE_CODE_*` flags. Secret values are never returned, only "•••• 1a2b".
 * An edit keeps every other key and the file's layout (indentation, line endings, final newline),
 * keeps a one-time copy of the file as it was (`settings.json.mousse-bak`) and replaces it atomically.
 * A `settings.json` that is a symbolic link (a dotfiles checkout) is edited where it points, so the
 * link stays. An edit names the revision it was made on: a file changed on disk since is refused.
 */

export const CLAUDE_SETTINGS_BACKUP_SUFFIX = '.mousse-bak'

/**
 * A refusal Mousse words itself (a value it won't save, a file it leaves alone, a file changed on disk):
 * safe to show the user, and never carrying the value.
 */
export class ClaudeSettingsError extends Error {}

type Json = Record<string, unknown>

interface KnownSetting {
  key: string
  label: string
  secret: boolean
  /** Offered by "Add setting" when the file does not have it. */
  common: boolean
  validate: (value: string) => string | undefined
}

const MAX_VALUE = 4096
const controlChars = /[\u0000-\u001f\u007f]/

function plainText(what: string) {
  return (value: string): string | undefined => {
    if (!value.trim()) return `${what} can't be empty.`
    if (value.length > MAX_VALUE) return `${what} is too long.`
    if (controlChars.test(value)) return `${what} can't contain line breaks or control characters.`
    return undefined
  }
}

function secretText(what: string) {
  return (value: string): string | undefined => plainText(what)(value) ?? (/\s/.test(value) ? `${what} can't contain spaces.` : undefined)
}

function urlText(value: string): string | undefined {
  const problem = plainText('The URL')(value)
  if (problem) return problem
  if (/\s/.test(value)) return "The URL can't contain spaces."
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// URL.'
    if (!url.hostname) return 'Enter a full URL, like https://api.example.com.'
  } catch {
    return 'Enter a full URL, like https://api.example.com.'
  }
  return undefined
}

/** The settings shown when present, in this order; the `CLAUDE_CODE_*` variables follow by name. */
const KNOWN: KnownSetting[] = [
  { key: 'env.ANTHROPIC_BASE_URL', label: 'API base URL', secret: false, common: true, validate: urlText },
  { key: 'env.ANTHROPIC_API_KEY', label: 'API key', secret: true, common: true, validate: secretText('The key') },
  { key: 'env.ANTHROPIC_AUTH_TOKEN', label: 'Auth token', secret: true, common: true, validate: secretText('The token') },
  { key: 'model', label: 'Default model', secret: false, common: true, validate: plainText('The model') },
  { key: 'env.ANTHROPIC_MODEL', label: 'Model (ANTHROPIC_MODEL)', secret: false, common: false, validate: plainText('The model') }
]

const FLAG = /^env\.(CLAUDE_CODE_[A-Z0-9_]+)$/
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

function settingFor(key: string): KnownSetting | undefined {
  const known = KNOWN.find((entry) => entry.key === key)
  if (known) return known
  const flag = FLAG.exec(key)?.[1]
  if (!flag) return undefined
  const secret = SECRET_NAME.test(flag)
  return { key, label: flag, secret, common: false, validate: secret ? secretText('The value') : plainText('The value') }
}

/** "•••• 1a2b": the last four characters of a long secret, none of a short one. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `•••• ${value.slice(-4)}` : '••••'
}

/**
 * The folder Claude Code keeps its settings in for an environment it starts with; undefined for a
 * relative `CLAUDE_CONFIG_DIR`, which Claude resolves against each project folder (no one file).
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string = homedir()): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return isAbsolute(dir) ? dir : undefined
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv, home?: string): string | undefined {
  const dir = claudeConfigDir(env, home)
  return dir ? join(dir, 'settings.json') : undefined
}

/**
 * The file an edit of `path` writes: the file itself, or where it points when it is a symbolic link
 * (replacing the link with a copy would cut it off from its dotfiles). Anything but a regular file
 * (a folder, a device) is refused.
 */
export function claudeSettingsWriteTarget(path: string): string {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path)
  } catch (error) {
    // A missing file is created; a link to a missing file is not followed anywhere.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (target !== path) throw new ClaudeSettingsError('This settings.json is a link to a file that is not there, so Mousse leaves it alone.')
      return path
    }
    throw error
  }
  try {
    if (!statSync(target).isFile()) throw new ClaudeSettingsError('This settings.json is not a file, so Mousse leaves it alone.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

// Revisions are keyed per run of the service, so the value sent to a window says nothing about the
// file's contents (it holds secrets) beyond "same as before".
const REVISION_KEY = randomBytes(32)

/** The revision of a file's text ("none" for a missing file): an edit made on another is refused. */
export function claudeSettingsRevision(text: string | undefined): string {
  return text === undefined ? 'none' : createHmac('sha256', REVISION_KEY).update(text).digest('hex').slice(0, 24)
}

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const UNREADABLE = "Mousse can't read this settings.json as JSON, so it leaves the file alone."

function parse(text: string): Json {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isRecord(value)) throw new ClaudeSettingsError(UNREADABLE)
  return value
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function valueAt(settings: Json, key: string): unknown {
  if (key.startsWith('env.')) return isRecord(settings.env) ? settings.env[key.slice(4)] : undefined
  return settings[key]
}

function entryFor(setting: KnownSetting, value: string): VendorSettingEntry {
  return { key: setting.key, label: setting.label, secret: setting.secret, ...(setting.secret ? { masked: maskSecret(value) } : { value }) }
}

/** What the file holds that the page shows (string values only), with secrets masked. */
export function readClaudeSettingsFile(path: string, options: { shared: boolean; confirmed?: boolean }): VendorSettingsView {
  const base = { path, shared: options.shared, ...(options.shared ? { confirmed: options.confirmed === true } : {}) }
  const addableAll = KNOWN.filter((setting) => setting.common).map(({ key, label, secret }) => ({ key, label, secret }))
  let text: string | undefined
  try {
    text = readText(path)
  } catch {
    return { ...base, exists: true, entries: [], addable: [], error: "Mousse can't open this settings.json." }
  }
  if (text === undefined) return { ...base, exists: false, revision: claudeSettingsRevision(undefined), entries: [], addable: addableAll }
  let settings: Json
  try {
    settings = text.trim() ? parse(text) : {}
  } catch {
    return { ...base, exists: true, entries: [], addable: [], error: UNREADABLE }
  }
  const entries: VendorSettingEntry[] = []
  for (const setting of KNOWN) {
    const value = valueAt(settings, setting.key)
    if (typeof value === 'string') entries.push(entryFor(setting, value))
  }
  if (isRecord(settings.env)) {
    for (const name of Object.keys(settings.env).sort()) {
      const setting = settingFor(`env.${name}`)
      const value = settings.env[name]
      if (setting && FLAG.test(setting.key) && typeof value === 'string') entries.push(entryFor(setting, value))
    }
  }
  const present = new Set(entries.map((entry) => entry.key))
  return { ...base, exists: true, revision: claudeSettingsRevision(text), entries, addable: addableAll.filter((setting) => !present.has(setting.key)) }
}

/** Why `value` cannot be saved under `key`, or undefined when it can. */
export function claudeSettingProblem(key: string, value: string | null): string | undefined {
  const setting = settingFor(key)
  if (!setting) return 'Mousse does not edit this setting.'
  return value === null ? undefined : setting.validate(value)
}

/** The file's layout, so a rewrite keeps it: indentation, line endings, final newline, byte order mark. */
function layoutOf(text: string | undefined): { indent: string; eol: string; finalNewline: boolean; bom: boolean } {
  if (!text?.trim()) return { indent: '  ', eol: text?.includes('\r\n') ? '\r\n' : '\n', finalNewline: true, bom: false }
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  return { indent, eol: text.includes('\r\n') ? '\r\n' : '\n', finalNewline: /\n$/.test(text), bom: text.startsWith('\uFEFF') }
}

export interface ClaudeSettingsWriteDeps {
  writeAtomic?: (path: string, text: string, mode: number) => void
  copyFile?: (from: string, to: string) => void
}

/** The file's permission bits, kept by the rewrite; a new file is readable by its owner only. */
function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return 0o600
  }
}

/** The first copy of the file is kept; a copy that is already there (even a racing one) stays. */
function keepFirstCopy(path: string, copy: (from: string, to: string) => void): void {
  try {
    copy(path, `${path}${CLAUDE_SETTINGS_BACKUP_SUFFIX}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Sets (or with `null` removes) one setting in the file at `path`, creating the file when there is
 * none. `expectedRevision` is the revision the edit was made on (`readClaudeSettingsFile`): a file
 * changed since is refused with `VENDOR_SETTINGS_CHANGED`. A file Mousse cannot read as JSON is never
 * written. Before the first edit of an existing file a copy is kept beside it (`.mousse-bak`, never
 * overwritten afterwards). Error messages never carry the value.
 */
export function writeClaudeSetting(
  path: string,
  key: string,
  value: string | null,
  expectedRevision: string,
  deps: ClaudeSettingsWriteDeps = {}
): void {
  const problem = claudeSettingProblem(key, value)
  if (problem) throw new ClaudeSettingsError(problem)
  const target = claudeSettingsWriteTarget(path)
  const text = readText(target)
  let settings: Json
  try {
    settings = text?.trim() ? parse(text) : {}
  } catch {
    throw new ClaudeSettingsError(UNREADABLE)
  }
  if (claudeSettingsRevision(text) !== expectedRevision) throw new ClaudeSettingsError(VENDOR_SETTINGS_CHANGED)
  const before = JSON.stringify(settings)
  if (key.startsWith('env.')) {
    const name = key.slice(4)
    if (settings.env !== undefined && !isRecord(settings.env)) throw new ClaudeSettingsError('The env of this settings.json is not an object, so Mousse leaves it alone.')
    if (value === null) {
      if (isRecord(settings.env)) delete settings.env[name]
    } else {
      settings.env = { ...(isRecord(settings.env) ? settings.env : {}), [name]: value }
    }
  } else if (value === null) delete settings[key]
  else settings[key] = value
  // Nothing to change (removing a setting that is not there): the file is not touched.
  if (text !== undefined && JSON.stringify(settings) === before) return

  if (text !== undefined) keepFirstCopy(target, deps.copyFile ?? ((from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL)))
  const layout = layoutOf(text)
  let next = JSON.stringify(settings, null, layout.indent)
  if (layout.eol !== '\n') next = next.replace(/\n/g, layout.eol)
  if (layout.finalNewline) next += layout.eol
  if (layout.bom) next = `\uFEFF${next}`
  const mode = modeOf(target)
  ;(deps.writeAtomic ?? ((file, contents, fileMode) => atomicWriteFileSync(file, contents, { mode: fileMode })))(target, next, mode)
}
