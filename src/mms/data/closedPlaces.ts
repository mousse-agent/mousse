import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * What a bot with "use files on this computer" may not read or change besides the Mousse home (bot-architecture.md
 * §3.7): every other place Mousse itself keeps sign-ins, cookies, keys or tokens, and the sign-in files of the CLIs it
 * runs for the owner. One list, built here, used by every check that closes the Mousse home: the bot authority's check
 * of each file call (`botAuthority.ts`), Codex's permission profile (`codexBotSandbox`) and Claude Code's sandbox
 * (`claudeLockedSandbox`), so they cannot drift. The owner's other files, secrets included, are not on it.
 *
 * Each place is given as spelled and, when it differs, with the real path of the folder it is in (a link, a junction or
 * a short name on the way to it), so a check of real paths and a sandbox that mounts by name both find it. Only that
 * folder is looked up, never the place itself: listing a sign-in file opens nothing and doesn't even look for it.
 */
export interface BotClosedPlacesInput {
  /** The Mousse home (`mousseDataFolder`): already closed whole; a place inside it is not listed again. */
  mousseHome: string
  /** Mousse's environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
  /** The owner's home folder (default `homedir()`). */
  userHome?: string
  platform?: NodeJS.Platform
  /** The system's temporary folders (default: `tmpdir()`, and `/tmp`, `/private/tmp`, `/var/tmp` off Windows). */
  temps?: readonly string[]
  /** The variables set on the owner's own CLI entries (default: those the harness noted, `noteCliEntryEnvironment`). */
  entryEnvs?: ReadonlyArray<Readonly<Record<string, string | undefined>>>
}

export function botClosedPlaces(input: BotClosedPlacesInput): string[] {
  const env = input.env ?? process.env
  const userHome = input.userHome ?? homedir()
  const platform = input.platform ?? process.platform
  const envs = [env, ...(input.entryEnvs ?? [...entryEnvironments.values()])]
  const places = [
    ...mousseOwnPlaces(env, userHome, platform),
    ...mousseTempEntries(input.temps ?? defaultTemps(platform)),
    ...codexSignInFiles(envs, userHome),
    ...claudeSignInFiles(envs, userHome, platform)
  ]
  const home = resolve(input.mousseHome)
  const spelled = [...new Set(places.map((place) => resolve(place)))]
  return [...new Set(spelled.flatMap((place) => [place, join(realOrSpelled(dirname(place)), basename(place))]))].filter((place) => !inside(home, place))
}

/**
 * Where Mousse keeps its own data outside its home: the app's Electron user data (`MOUSSE_ELECTRON_USER_DATA`, set by
 * the app and its service when they start; else where `resolveElectronUserData` puts it for the default home). It holds
 * the in-app browser's profiles (`persist:mousse-browser`, `persist:mousse-profile-<id>`: the owner's cookies and site
 * sign-ins) and the key Electron encrypts Mousse's stored secrets with. Every bot's own browser profile
 * (`<home>/browser/user-data/…/botbrowser_<botId>`), the token broker's host id, the managed entries' homes and MCP
 * sign-ins are inside the Mousse home.
 */
function mousseOwnPlaces(env: Readonly<Record<string, string | undefined>>, userHome: string, platform: NodeJS.Platform): string[] {
  const set = env.MOUSSE_ELECTRON_USER_DATA?.trim()
  if (set && isAbsolute(set)) return [set]
  const appData = platform === 'win32'
    ? env.APPDATA?.trim() || join(userHome, 'AppData', 'Roaming')
    : platform === 'darwin' ? join(userHome, 'Library', 'Application Support') : env.XDG_CONFIG_HOME?.trim() || join(userHome, '.config')
  return [join(appData, 'mousse')]
}

/**
 * The folders and files Mousse keeps in the system's temporary folders `temps`, as they are now: every entry named
 * `mousse-…` (the ChatGPT token broker's socket folder, pasted bot attachments; for the seconds a task runs, a pull
 * request's text, the paths the owner stages, Git's trace of their hooks, an ACP agent's check). A bot's sandbox closes
 * them by name, read when its turn starts: a pattern can't stand for them, since Codex's Linux sandbox lists a whole
 * folder to expand one and refuses every command when any folder in it can't be read, as some in `/tmp` never can.
 */
export function mousseTempEntries(temps: readonly string[]): string[] {
  const entries: string[] = []
  for (const temp of new Set(temps)) {
    let names: string[]
    try {
      names = readdirSync(temp)
    } catch {
      continue
    }
    for (const name of names) if (name.startsWith('mousse-')) entries.push(join(temp, name))
  }
  return entries
}

function defaultTemps(platform: NodeJS.Platform): string[] {
  return [tmpdir(), ...(platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])]
}

/** An absolute folder a variable names, or none (a relative one names no one folder). */
function folderOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * Codex's sign-in in each home it may run with (`CODEX_HOME` of Mousse's environment or an entry's, and `~/.codex`):
 * `auth.json` (the ChatGPT tokens or the API key) and `.credentials.json` (the MCP servers' OAuth tokens, when Codex
 * keeps them in a file). The rest of the home (its `config.toml`, sessions and logs) stays open.
 */
function codexSignInFiles(envs: ReadonlyArray<Readonly<Record<string, string | undefined>>>, userHome: string): string[] {
  const homes = new Set([join(userHome, '.codex'), ...envs.map((env) => folderOf(env.CODEX_HOME)).filter((home): home is string => home !== undefined)])
  return [...homes].flatMap((home) => [join(home, 'auth.json'), join(home, '.credentials.json')])
}

/**
 * Claude Code's sign-in, as its program file reads it (Claude Code 2.x): `.credentials.json` in the secure-storage
 * folder (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, else the config folder `CLAUDE_CONFIG_DIR`, else `~/.claude`; the OAuth
 * tokens, and the MCP servers'), `.device-keys.json` and the remote session's `.session_ingress_token`, the global
 * config `.claude.json` with its backups (it holds an API key saved by `/login`: `~/.claude.json`, or
 * `<CLAUDE_CONFIG_DIR>/.claude.json`, and `<config>/backups`), the Anthropic profile store (`ANTHROPIC_CONFIG_DIR`, else
 * `%APPDATA%\Anthropic` or `~/.config/anthropic`) and the federation token cache (`CLAUDE_CODE_FEDERATION_CACHE_DIR`).
 * The rest of the config folder (`settings.json`, `CLAUDE.md`, skills, projects) stays open. On macOS the sign-in is
 * normally in the keychain, which is not a file.
 */
function claudeSignInFiles(envs: ReadonlyArray<Readonly<Record<string, string | undefined>>>, userHome: string, platform: NodeJS.Platform): string[] {
  const defaultConfig = join(userHome, '.claude')
  const places: string[] = [join(userHome, '.claude.json'), join(userHome, '.claude.json.backup'), join(defaultConfig, '.device-keys.json')]
  const configs = new Set([defaultConfig])
  const secure = new Set<string>()
  const profiles = new Set<string>()
  for (const env of envs) {
    const config = folderOf(env.CLAUDE_CONFIG_DIR)
    if (config) {
      configs.add(config)
      places.push(join(config, '.claude.json'), join(config, '.claude.json.backup'))
    }
    // Set but empty means the default folder.
    if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) secure.add(folderOf(env.CLAUDE_SECURESTORAGE_CONFIG_DIR) ?? defaultConfig)
    const profile = folderOf(env.ANTHROPIC_CONFIG_DIR)
    if (profile) profiles.add(profile)
    const federation = folderOf(env.CLAUDE_CODE_FEDERATION_CACHE_DIR)
    if (federation) places.push(federation)
  }
  for (const config of configs) places.push(join(config, '.credentials.json'), join(config, '.session_ingress_token'), join(config, 'backups'))
  for (const folder of secure) places.push(join(folder, '.credentials.json'))
  const env = envs[0] ?? {}
  profiles.add(platform === 'win32'
    ? join(env.APPDATA?.trim() || join(userHome, 'AppData', 'Roaming'), 'Anthropic')
    : join(env.XDG_CONFIG_HOME?.trim() || join(userHome, '.config'), 'anthropic'))
  places.push(...profiles)
  return places
}

/**
 * The variables set on each of the owner's own Codex and Claude Code entries (Settings → Providers), which may move
 * their home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, …): noted by the harness when it builds an entry, so the sign-in files
 * of every home a CLI runs with on this computer are closed. An entry with a Mousse-owned home notes none: that home is
 * inside the Mousse home.
 */
const entryEnvironments = new Map<string, Readonly<Record<string, string>>>()

export function noteCliEntryEnvironment(entry: string, env: Readonly<Record<string, string>> | undefined): void {
  if (env && Object.keys(env).length) entryEnvironments.set(entry, { ...env })
  else entryEnvironments.delete(entry)
}

/**
 * Whether a bot's sandbox can open `path` for writing, beside Mousse's data with file access: a folder (not a link) this
 * user can write. Codex's and Claude Code's Linux sandboxes make read-only folders of their own inside a writable folder
 * (`.git`, `.codex`, `.agents`, `.aws`; `/etc/claude-code`), and when they can't (a file, or a folder such as `/usr` or
 * `/etc` that only the system may change) every command of the turn fails before it starts. So a file directly in a folder
 * on the way to Mousse's data (`~/.bashrc`), a folder only the system may change and what is inside it (`/mnt`, `/media`)
 * stay read-only to commands; a file tool, checked by the bot's authority, can still change them.
 */
export function writableFolder(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory()) return false
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Whether `path` is `folder` or inside it (absolute paths; case-insensitive on Windows). */
function inside(folder: string, path: string): boolean {
  const norm = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const a = norm(resolve(folder))
  const b = norm(resolve(path))
  if (a === b) return true
  const prefix = a.endsWith('/') || a.endsWith('\\') ? a : `${a}${process.platform === 'win32' ? '\\' : '/'}`
  return b.startsWith(prefix)
}

/** The real path of a folder that may not exist: the real path of the deepest folder that does, and the rest as it is. */
function realOrSpelled(place: string): string {
  const rest: string[] = []
  let current = resolve(place)
  for (;;) {
    try {
      return rest.length ? join(realpathSync.native(current), ...rest) : realpathSync.native(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(place)
      rest.unshift(basename(current))
      current = parent
    }
  }
}
