import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir, hostname, networkInterfaces, tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

/**
 * What a bot with "use files on this computer" may not read or change besides the Mousse home (bot-architecture.md
 * §3.7): every other place Mousse itself keeps sign-ins, cookies, keys or tokens, and the sign-in files of the CLIs it
 * runs for the owner. One list, built here when a turn is compiled, used by every check that closes the Mousse home:
 * the bot authority's check of each file call (`botAuthority.ts`), Codex's permission profile (`codexBotSandbox`) and
 * Claude Code's sandbox and permission rules (`claudeLockedSandbox`, `claudeLockedOptions`), so they cannot drift. The
 * owner's other files, secrets included, are not on it.
 *
 * Each place is given as spelled and, when it differs, with the real path of the folder it is in (a link, a junction or
 * a short name on the way to it), so a check of real paths and a sandbox that mounts by name both find it. Only that
 * folder is looked up, never the place itself: listing a sign-in file opens nothing and doesn't even look for it.
 */
export interface BotClosedPlacesInput {
  /** The Mousse home (`mousseDataFolder`): already closed whole; a place inside it is not listed again. */
  mousseHome: string
  /**
   * The bot's profile: its `mousse.conf`, and those of the other profiles beside it, hold the variables set on their
   * Codex, Claude Code and Grok entries (`everyProfileEntryEnvironment`).
   */
  profileHome?: string
  /** Mousse's environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
  /** The owner's home folder (default `homedir()`). */
  userHome?: string
  platform?: NodeJS.Platform
  /** The system's temporary folders (default: `tmpdir()`, and `/tmp`, `/private/tmp`, `/var/tmp` off Windows). */
  temps?: readonly string[]
  /** The variables set on the owner's own CLI entries (default: read from `profileHome`, `everyProfileEntryEnvironment`). */
  entryEnvs?: ReadonlyArray<Readonly<Record<string, string | undefined>>>
}

/** The profile's stored provider entries can't be read, so the homes they may move a CLI's sign-in to aren't known. */
export class ClosedPlacesUnknown extends Error {}

/** Throws `ClosedPlacesUnknown` when the profile's provider entries can't be read: the list would be incomplete. */
export function botClosedPlaces(input: BotClosedPlacesInput): string[] {
  const env = input.env ?? process.env
  const userHome = input.userHome ?? homedir()
  const platform = input.platform ?? process.platform
  const envs = [env, ...(input.entryEnvs ?? (input.profileHome ? everyProfileEntryEnvironment(input.profileHome) : []))]
  const places = [
    ...mousseOwnPlaces(env, userHome, platform),
    ...mousseTempEntries(input.temps ?? defaultTemps(platform)),
    ...codexSignInFiles(envs, userHome),
    ...claudeSignInFiles(envs, userHome, platform),
    ...grokSignInFiles(envs, userHome)
  ]
  const home = resolve(input.mousseHome)
  const spelled = [...new Set(places.map((place) => resolve(place)))]
  return [...new Set(spelled.flatMap((place) => [place, join(realOrSpelled(dirname(place)), basename(place))]))].filter((place) => !inside(home, place))
}

/**
 * The variables of the CLI entries of the bot's profile (`profileEntryEnvironments`; it throws when they can't be read)
 * and of every other profile beside it in the Mousse home: they are the same owner's sign-ins. Unreadable settings
 * in any profile refuse the list: another running service may still use those entries.
 */
function everyProfileEntryEnvironment(profileHome: string): Array<Record<string, string>> {
  const own = resolve(profileHome)
  const envs = profileEntryEnvironments(own)
  const profiles = dirname(own)
  if (basename(profiles) !== 'profiles') return envs
  let names: string[] = []
  try {
    names = readdirSync(profiles)
  } catch {
    throw new ClosedPlacesUnknown('Mousse could not list its profiles.')
  }
  for (const name of names) {
    const other = join(profiles, name)
    if (other === own) continue
    if (!statSync(other).isDirectory()) continue
    envs.push(...profileEntryEnvironments(other))
  }
  return envs
}

/** The CLIs whose sign-in a moved home relocates, by the driver that runs them. */
const CLI_DRIVERS: ReadonlySet<string> = new Set(['codex', 'claude', 'grok'])

/**
 * The variables set on each Codex, Claude Code and Grok entry of a profile (Settings → Providers), as stored in its
 * `mousse.conf` (`providers.instances.<id>.config.env`), whether the entry has run in this service or not. An entry with a
 * Mousse-owned home (`config.home: 'private'`) has none that matter: that home is inside the Mousse home. No file: none.
 * A file that can't be read or parsed throws `ClosedPlacesUnknown`.
 */
export function profileEntryEnvironments(profileHome: string): Array<Record<string, string>> {
  const file = join(profileHome, 'mousse.conf')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new ClosedPlacesUnknown(`Mousse couldn't read this profile's provider settings (${error instanceof Error ? error.message : String(error)}).`)
  }
  const instances = (parsed as { providers?: { instances?: unknown } } | null)?.providers?.instances
  if (!instances || typeof instances !== 'object') return []
  const envs: Array<Record<string, string>> = []
  for (const entry of Object.values(instances as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const { driver, config } = entry as { driver?: unknown; config?: { home?: unknown; env?: unknown } }
    if (typeof driver !== 'string' || !CLI_DRIVERS.has(driver) || config?.home === 'private') continue
    const variables = config?.env
    if (!variables || typeof variables !== 'object') continue
    envs.push(Object.fromEntries(Object.entries(variables as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string')))
  }
  return envs
}

/**
 * Where Mousse keeps its own data outside its home: the app's Electron user data (`MOUSSE_ELECTRON_USER_DATA`, set by
 * the app and its service when they start; else where `resolveElectronUserData` puts it for the default home). It holds
 * the in-app browser's profiles (`persist:mousse-browser`, `persist:mousse-profile-<id>`: the owner's cookies and site
 * sign-ins) and the key Electron encrypts Mousse's stored secrets with. Every bot's own browser profile
 * (`<home>/browser/user-data/…/botbrowser_<botId>`), the token broker's host id, the managed entries' homes (Codex,
 * Claude Code, Grok, Antigravity's under `<profile>/providers`), Pi's agent folder and MCP sign-ins are inside the
 * Mousse home.
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
 * request's text, the paths the owner stages, Git's trace of their hooks, an ACP agent's check), the owner's own
 * folders of that name included. A bot's sandbox closes them by name, read when its turn starts: a pattern can't stand
 * for them, since Codex's Linux sandbox lists a whole folder to expand one and refuses every command when any folder in
 * it can't be read, as some in `/tmp` never can.
 */
export function mousseTempEntries(temps: readonly string[]): string[] {
  const entries: string[] = []
  for (const temp of new Set(temps)) {
    let names: string[]
    try {
      names = readdirSync(temp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new ClosedPlacesUnknown('Mousse could not list a temporary folder.')
    }
    for (const name of names) if (name.startsWith('mousse-')) entries.push(join(temp, name))
  }
  return entries
}

/** Whether `place` is one of Mousse's entries in a temporary folder (`mousseTempEntries`): short-lived, most of them. */
export function isMousseTempEntry(place: string, temps: readonly string[] = defaultTemps(process.platform)): boolean {
  return basename(place).startsWith('mousse-') && temps.some((temp) => resolve(dirname(place)) === resolve(temp) || realOrSpelled(dirname(place)) === realOrSpelled(temp))
}

function defaultTemps(platform: NodeJS.Platform): string[] {
  return [tmpdir(), ...(platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])]
}

/** An absolute folder, or none when unset. A relative home cannot be closed independently of each CLI working folder. */
function folderOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed && !isAbsolute(trimmed)) throw new ClosedPlacesUnknown('A CLI home is relative, so its sign-in folder cannot be determined.')
  return trimmed || undefined
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
 * config with its backups (it holds an API key saved by `/login`): `.claude.json` (`~/.claude.json`, or
 * `<CLAUDE_CONFIG_DIR>/.claude.json`) and the older `<config>/.config.json`, which Claude Code reads first when it
 * exists, and `<config>/backups`; the Anthropic profile store (`ANTHROPIC_CONFIG_DIR`, else `%APPDATA%\Anthropic` or
 * `~/.config/anthropic`) and the federation token cache (`CLAUDE_CODE_FEDERATION_CACHE_DIR`). The rest of the config
 * folder (`settings.json`, `CLAUDE.md`, skills, projects) stays open. On macOS the sign-in is normally in the keychain,
 * which is not a file.
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
  for (const config of configs)
    places.push(join(config, '.credentials.json'), join(config, '.session_ingress_token'), join(config, '.config.json'), join(config, '.config.json.backup'), join(config, 'backups'))
  for (const folder of secure) places.push(join(folder, '.credentials.json'))
  const env = envs[0] ?? {}
  profiles.add(platform === 'win32'
    ? join(env.APPDATA?.trim() || join(userHome, 'AppData', 'Roaming'), 'Anthropic')
    : join(env.XDG_CONFIG_HOME?.trim() || join(userHome, '.config'), 'anthropic'))
  places.push(...profiles)
  return places
}

/** Grok's sign-in (`grokHome`): `auth.json` in `GROK_HOME`, of Mousse's environment or an entry's, and in `~/.grok`. */
function grokSignInFiles(envs: ReadonlyArray<Readonly<Record<string, string | undefined>>>, userHome: string): string[] {
  const homes = new Set([join(userHome, '.grok'), ...envs.map((env) => folderOf(env.GROK_HOME)).filter((home): home is string => home !== undefined)])
  return [...homes].map((home) => join(home, 'auth.json'))
}

/**
 * Every entry inside `folder` that is not one of `keep` and does not lead to one (as `entriesBeside`), for closing them:
 * a folder on the way that can't be listed is closed whole, `keep` inside it included, rather than left open.
 */
export function closedBeside(folder: string, keep: readonly string[]): string[] {
  const within = (path: string, parent: string) => path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  if (!keep.some((path) => within(path, folder))) return [folder]
  const beside: string[] = []
  const walk = (at: string): void => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      beside.push(at)
      return
    }
    for (const name of names) {
      const entry = join(at, name)
      if (keep.includes(entry)) continue
      if (keep.some((path) => within(path, entry))) walk(entry)
      else beside.push(entry)
    }
  }
  walk(folder)
  return beside
}

/** Whether a closed place is `root` or inside it, on the real path of `root` (a search over it would reach one). */
export function closedWithin(root: string, places: readonly string[]): boolean {
  const roots = [...new Set([resolve(root), realOrSpelled(resolve(root))])]
  return places.some((place) => roots.some((at) => inside(at, place)))
}

/**
 * Whether a bot's sandbox can open `path` for writing: a folder (not a link) this user can write. Codex's and Claude
 * Code's Linux sandboxes make read-only folders of their own inside a writable folder (Codex's `.git`, `.codex`,
 * `.agents`, `.aws`; Claude Code's `/etc/claude-code`), and when they can't (a file, or a folder such as `/usr` or
 * `/etc` that only the system may change) every command of the turn fails before it starts.
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

/** The kernel's own file systems: never writable to a bot's commands. */
const KERNEL_FOLDERS: ReadonlySet<string> = new Set(['/proc', '/sys', '/dev'])

/** What a bot's commands may do with file access on Linux (`linuxCommandLayout`): each path is one sandbox entry. */
export interface LinuxCommandLayout {
  /** Writable folders: each is a mount of its own, so none of them can be renamed away from a closed place inside it. */
  write: string[]
  /** Read-only: the folders on the way down to the bot's folders inside the Mousse home, and the Codex package there. */
  read: string[]
  /** Neither readable nor writable: Mousse's own data beside those, and every other closed place that exists. */
  deny: string[]
}

/**
 * How a bot's commands reach the file system with file access on Linux, for Codex's profile and Claude Code's sandbox
 * alike. Everything is readable but `deny`. Writable (`write`): the owner's home folder itself, every folder beside the
 * way down to it and to the Mousse home that this user can write (`/tmp`, a user-owned `/opt`), the drives mounted under
 * `/mnt`, `/media`, `/media/<user>` and `/run/media/<user>`, and the bot's own folders. So a file or a new entry directly
 * in the home folder is writable, and so is a drive. Closed (`deny`): every entry of the Mousse home beside the way down
 * to the bot's folders and the Codex package kept there (`closedBeside`: a folder that can't be listed is closed whole),
 * and every place `botClosedPlaces` lists outside it. The folders on that way, and the package, are read-only (`read`),
 * and every folder between a writable folder and a closed place inside it is a writable folder of its own: a mount can't
 * be renamed, so a command can't move a closed place to a name the next command's sandbox doesn't close. Read-only stays
 * every other folder this user can't write (`/usr`, `/etc`, a root-owned `/opt`, `/var`, …) and, with `windowsDrives`
 * false, WSL's Windows drives.
 */
export function linuxCommandLayout(input: {
  /** The tops of the file system file access opens (`computerRoots`). */
  roots: readonly string[]
  /** The Mousse home. */
  mousseHome: string
  /** The other closed places (`computer.outside`). */
  outside: readonly string[]
  /** The bot's own folders (its files folder and scratch), writable. */
  mine: readonly string[]
  /** Folders inside the Mousse home that stay readable (the Codex package an entry Mousse manages runs). */
  readable?: readonly string[]
  userHome?: string
  user?: string
  /**
   * Whether WSL's Windows drives (`/mnt/c`, …) may be writable. Codex makes its own `.git`, `.codex`, `.agents` and `.aws`
   * on the disk at the top of each writable folder while a command runs, so for Codex they stay read-only: it would make
   * them at the root of the owner's Windows drives. Default true.
   */
  windowsDrives?: boolean
  /** For tests: whether a folder is writable (`writableFolder`), a folder's entries, whether this is WSL, and whether a place exists. */
  writable?: (path: string) => boolean
  list?: (path: string) => string[]
  wsl?: boolean
  exists?: (path: string) => boolean
}): LinuxCommandLayout {
  const writable = input.writable ?? writableFolder
  const list = input.list ?? ((path: string) => readdirSync(path))
  const home = resolve(input.mousseHome)
  const userHome = resolve(input.userHome ?? homedir())
  const kept = [...input.mine, ...(input.readable ?? [])].map((path) => resolve(path))
  // Only the places that exist when the turn starts: both sandboxes make a stand-in on the disk for one that doesn't, and
  // Codex 0.162.1 fails every command when the folder it is in doesn't exist either. One made later is closed from the
  // next turn (a change of the list opens a new Codex thread); the file tool's check holds the whole list throughout.
  const present = input.exists ?? ((path: string) => safe(() => lstatSync(path)) !== undefined)
  const outside = input.outside.map((place) => resolve(place)).filter((place) => !kept.some((folder) => inside(place, folder)) && present(place))
  const deny = [...new Set([...closedBeside(home, kept), ...outside])]
  // The way down from the Mousse home to each folder kept inside it: read-only, so nothing can be made or renamed there.
  const way = new Set<string>()
  for (const folder of kept)
    if (inside(home, folder)) for (let at = dirname(folder); inside(home, at); at = dirname(at)) {
      way.add(at)
      if (at === home) break
    }
  const read = [...new Set([...way, ...(input.readable ?? []).map((path) => resolve(path))])]
  const usable = (path: string) => !KERNEL_FOLDERS.has(path) && !inside(home, path) && writable(path)
  const write = new Set<string>()
  if (!inside(home, userHome) && usable(userHome)) write.add(userHome)
  for (const root of input.roots)
    for (const entry of entriesOutside(resolve(root), [home, userHome], list)) if (usable(entry)) write.add(entry)
  const user = input.user ?? safeUser()
  const windowsDrive = (parent: string, name: string) => parent === '/mnt' && /^[a-z]$/i.test(name) && (input.wsl ?? onWsl())
  for (const parent of ['/mnt', '/media', ...(user ? [join('/media', user), join('/run/media', user)] : [])])
    for (const name of safeList(list, parent)) {
      const drive = join(parent, name)
      if (input.windowsDrives === false && windowsDrive(parent, name)) continue
      if (usable(drive)) write.add(drive)
    }
  // Every folder between a writable folder and a closed or read-only place inside it, as a writable folder of its own.
  for (const place of [...deny, ...read])
    for (const root of [...write])
      if (place !== root && inside(root, place))
        for (let at = dirname(place); at !== root && inside(root, at); at = dirname(at))
          if (!way.has(at) && !deny.some((closed) => inside(closed, at)) && usable(at)) write.add(at)
  for (const folder of input.mine) write.add(resolve(folder))
  return { write: [...write], read, deny }
}

/** `entriesBeside` that never throws: a folder that can't be listed adds nothing writable. */
function entriesOutside(root: string, keep: readonly string[], list: (path: string) => string[]): string[] {
  const within = (path: string, parent: string) => path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  const kept = keep.filter((path) => path === root || within(path, root))
  if (!kept.length) return [root]
  const beside: string[] = []
  const walk = (at: string): void => {
    for (const name of safeList(list, at)) {
      const entry = join(at, name)
      if (kept.includes(entry)) continue
      if (kept.some((path) => within(path, entry))) walk(entry)
      else beside.push(entry)
    }
  }
  if (!kept.includes(root)) walk(root)
  return beside
}

function safeList(list: (path: string) => string[], path: string): string[] {
  try {
    return list(path)
  } catch {
    return []
  }
}

/** Whether this Linux runs on WSL, where `/mnt/<letter>` is a Windows drive. */
function onWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

function safeUser(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

/**
 * What a bot that may run commands with file access on Linux is told of what its commands can't change, in its
 * instructions: the system's own "Read-only file system" can't be answered as a refusal by Mousse, so it is said ahead.
 */
export const BOT_COMMAND_WRITE_LIMIT_TEXT = 'Your commands can\'t change files in folders only the system may change (such as /usr, /etc, /opt or /var) nor Mousse\'s own data and sign-ins; there they get "Read-only file system" or "Permission denied". Your file tool can change such a file where your owner\'s account can, and Mousse checks each change.'

/** What Codex adds to it: what its sandbox keeps read-only besides (`codexBotSandbox`). */
export const CODEX_COMMAND_WRITE_LIMIT_TEXT = `${BOT_COMMAND_WRITE_LIMIT_TEXT} Codex also keeps .git, .codex, .agents and .aws at the top of a writable folder (such as the home folder) read-only, and on WSL the Windows drives under /mnt.`

/**
 * What Claude Code adds to it: its sandbox keeps git, shell and editor settings in the turn's working folder (and up to
 * three levels below it) read-only.
 */
export const CLAUDE_COMMAND_WRITE_LIMIT_TEXT = `${BOT_COMMAND_WRITE_LIMIT_TEXT} Claude Code also keeps git, shell and editor settings in your working folder read-only (such as .git/hooks, .git/config, .gitconfig, .bashrc, .vscode, .idea and .claude/commands).`

/**
 * A path that names this computer over the network (Windows): its UNC form (`\\host\share\…`, `\\?\UNC\host\share\…`,
 * with `/` or `\`), or a device path to a drive (`\\?\C:\…`, `\\.\C:\…`), as the local path it means. `host` is this
 * computer when it is `localhost`, a loopback or unspecified address in any IPv4 or IPv6 form (`[::1]`,
 * `0--1.ipv6-literal.net`, `::ffff:127.0.0.1`), one of this computer's own addresses in any of those forms, or one of
 * its names (alone, with a domain after it, or with a final dot). Its administrative drive share (`C$`) and `ADMIN$` are
 * turned into the drive and the Windows folder; any other share on this computer, a numeric host Windows would read in
 * a way not listed here, and any other device path, is refused, since it can't be turned into a local path with
 * certainty. So is a path on any other host whose volume is one of this computer's own (`ThisComputer.ownVolume`): a name
 * this computer doesn't know it goes by (a DNS name that points back to it). A UNC path to another computer, or one that
 * can't be reached, is an ordinary network file.
 */
export type LocalPathOf = { kind: 'plain' } | { kind: 'local'; path: string } | { kind: 'remote' } | { kind: 'refused' }

export interface ThisComputer {
  /** Names, lower case. */
  names: string[]
  /** Addresses, lower case, without a zone (`canonicalAddress` is applied when they are compared). */
  addresses: string[]
  /** The Windows folder (`%SystemRoot%`), for `ADMIN$`. */
  windows: string
  /**
   * Whether a network path is on one of this computer's own volumes: the volume serial number Windows reports through
   * the share for the deepest part of the path that exists is one of this computer's local drives'. A path that can't be
   * reached is not. Absent: not checked.
   */
  ownVolume?: (path: string) => boolean
}

export function thisComputer(env: Readonly<Record<string, string | undefined>> = process.env): ThisComputer {
  const names = new Set<string>(['localhost'])
  for (const name of [safe(() => hostname()), env.COMPUTERNAME]) if (name) names.add(name.toLowerCase())
  const addresses = new Set<string>()
  for (const list of Object.values(safe(() => networkInterfaces()) ?? {}))
    for (const address of list ?? []) addresses.add(normalAddress(address.address))
  return { names: [...names], addresses: [...addresses], windows: env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows', ownVolume: onLocalVolume }
}

/** `ThisComputer.ownVolume` on the real file system. */
export function onLocalVolume(path: string): boolean {
  const volume = volumeOf(path)
  return volume !== undefined && localVolumes().has(volume)
}

/** The volume serial number of the deepest part of `path` that exists, or undefined when none can be read. */
function volumeOf(path: string): bigint | undefined {
  for (let at = path; ; ) {
    try {
      return statSync(at, { bigint: true }).dev
    } catch {
      const parent = win32.dirname(at)
      if (parent === at) return undefined
      at = parent
    }
  }
}

/** The volume serial numbers of this computer's drives, without the drives mapped to a network share. */
function localVolumes(): Set<bigint> {
  const volumes = new Set<bigint>()
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (realpathSync.native(root).startsWith('\\\\')) continue
      volumes.add(statSync(root, { bigint: true }).dev)
    } catch {
      // No such drive, or no disk in it.
    }
  }
  return volumes
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function normalAddress(address: string): string {
  return address.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '')
}

/**
 * One spelling per address: an IPv4 address as it is; an IPv6 address that carries an IPv4 one (`::ffff:a.b.c.d`, and the
 * older `::a.b.c.d`) as that IPv4 address; any other IPv6 address with every group written out. Anything else unchanged.
 */
function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) return address
  const groups = expandIPv6(address)
  if (!groups) return address
  const zeros = groups.slice(0, 5).every((group) => group === 0)
  const carried = zeros && (groups[5] === 0xffff || (groups[5] === 0 && (groups[6] !== 0 || groups[7]! > 1)))
  if (carried) return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.')
  return groups.map((group) => group.toString(16)).join(':')
}

/** Whether an address (`canonicalAddress`) is a loopback or unspecified one: `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`. */
function loopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.') || address === '0.0.0.0'
  return address === '0:0:0:0:0:0:0:1' || address === '0:0:0:0:0:0:0:0'
}

function expandIPv6(address: string): number[] | undefined {
  let text = address
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const parts = v4[1]!.split('.').map(Number)
    if (parts.some((part) => part > 255)) return undefined
    text = text.slice(0, -v4[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const read = (part: string | undefined) => (part ? part.split(':').filter(Boolean).map((group) => parseInt(group, 16)) : [])
  const front = read(head)
  const back = read(tail)
  const fill = text.includes('::') ? 8 - front.length - back.length : 0
  const groups = [...front, ...Array(Math.max(fill, 0)).fill(0), ...back]
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined
}

export function localPathOf(raw: string, computer: ThisComputer = thisComputer()): LocalPathOf {
  const path = raw.replace(/\//g, '\\')
  if (!path.startsWith('\\\\')) return { kind: 'plain' }
  let unc: string
  const device = /^\\\\[?.]\\(.*)$/s.exec(path)
  if (device) {
    const rest = device[1]!
    const uncDevice = /^UNC\\(.*)$/is.exec(rest)
    if (!uncDevice) return /^[A-Za-z]:(\\|$)/.test(rest) ? { kind: 'local', path: win32.normalize(rest.length === 2 ? `${rest}\\` : rest) } : { kind: 'refused' }
    unc = uncDevice[1]!
  } else unc = path.slice(2)
  const [rawHost = '', share = '', ...rest] = unc.split('\\')
  if (!rawHost || !share) return { kind: 'refused' }
  let host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  // The IPv6 literal form Windows takes in UNC paths: `fe80--1s4.ipv6-literal.net` is `fe80::1%4`.
  const literal = /^(.*)\.ipv6-literal\.net$/.exec(host)
  if (literal) host = literal[1]!.replace(/-/g, ':').replace(/s(\d+)$/, '%$1')
  host = canonicalAddress(normalAddress(host))
  const named = computer.names.some((name) => host === name || host.startsWith(`${name}.`))
  const local = named || loopbackAddress(host) || computer.addresses.some((address) => canonicalAddress(address) === host)
  if (!local) {
    // A host Windows would read as a number though it is no plain address (`127.1`, `2130706433`, `0x7f.1`, `0177.0.0.1`):
    // it may be this computer, so it is not certain.
    if (/^((0x[0-9a-f]+|\d+)\.){0,3}(0x[0-9a-f]+|\d+)$/.test(host) && (isIP(host) !== 4 || /(^|\.)0\d/.test(host))) return { kind: 'refused' }
    if (computer.ownVolume?.(`\\\\${unc}`)) return { kind: 'refused' }
    return { kind: 'remote' }
  }
  const after = rest.join('\\')
  const drive = /^([A-Za-z])\$$/.exec(share)
  if (drive) return { kind: 'local', path: win32.normalize(`${drive[1]!.toUpperCase()}:\\${after}`) }
  if (share.toLowerCase() === 'admin$') return { kind: 'local', path: win32.normalize(win32.join(computer.windows, after)) }
  return { kind: 'refused' }
}

/** Whether `path` is `folder` or inside it (absolute paths; case-insensitive on Windows). */
function inside(folder: string, path: string): boolean {
  const norm = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const a = norm(resolve(folder))
  const b = norm(resolve(path))
  if (a === b) return true
  const child = relative(a, b)
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
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
