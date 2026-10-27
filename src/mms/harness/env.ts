import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import type { BinarySource, CredentialKind } from '../../shared/harness/status'
import type { HarnessDriverKind } from '../../shared/harness/types'
import { cliLaunch, withUserEnv, type CliLaunch } from '../providers/cliConfig'
import { resolveWindowsShim } from '../providers/resolveWindowsShim'
import { PI_AMBIENT_ENV, PI_ENV_KEYS } from './pi/envKeys'
import { GROK_CREDENTIAL_VARIABLES } from './grok/variables'

/**
 * The environment of one instance at one config revision: where its binary is, which home it
 * uses, and the variables every process of the instance starts with. Computed once per revision
 * (and when the login-shell PATH arrives); every harness spawn takes it.
 */
export interface InstanceEnv {
  instanceId: string
  driver: HarnessDriverKind
  configRevision: number
  /** `default` for the user's own vendor home; `private:<instanceId>` for a Mousse-owned one. */
  homeId: string
  /** The Mousse-owned home directory, when the instance has one. */
  home?: string
  /**
   * The base variables: Mousse's own environment with the instance's home variable set. The
   * user's launch variables are applied on top by the services, as before.
   */
  env: NodeJS.ProcessEnv
  /** PATH entries to search for the binary after the inherited PATH (the login shell's). */
  searchPath: string[]
  /** Where the driver's own installer puts its binary, searched last (`~/.grok/bin`). */
  driverSearchPath?: string[]
}

export const DEFAULT_HOME_ID = 'default'

export function privateHomeId(instanceId: string): string {
  return `private:${instanceId}`
}

/** The variable that points a driver at another home, when it has one. */
export const HOME_VARIABLES: Partial<Record<HarnessDriverKind, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  /** Pi's agent dir (auth, settings, models); a Pi process always runs with a Mousse-owned one. */
  pi: 'PI_CODING_AGENT_DIR',
  grok: 'GROK_HOME'
}

/**
 * Credentials a driver reads from the environment ahead of its home. An instance with its own home
 * does not inherit them from Mousse's environment, or it would sign in as the user's own account
 * whatever its home holds. Variables set on the instance itself still apply.
 */
export const INHERITED_CREDENTIALS: Partial<Record<HarnessDriverKind, readonly string[]>> = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'],
  pi: PI_ENV_KEYS,
  // Cursor has no home of its own: its host always runs with the instance's key and never sees this.
  cursor: ['CURSOR_API_KEY'],
  // Every variable that makes Grok sign in some other way than its home's `auth.json`. A trailing
  // `*` matches the prefix (`GROK_AUTH*` covers `GROK_AUTH`, `GROK_AUTH_PATH` and the
  // `GROK_AUTH_PROVIDER_*` command and tokens).
  grok: GROK_CREDENTIAL_VARIABLES
}

/** True when `name` is one of `names` (a trailing `*` matches a prefix), case-insensitively. */
export function matchesVariable(names: readonly string[], name: string): boolean {
  const upper = name.toUpperCase()
  return names.some((entry) => {
    const pattern = entry.toUpperCase()
    return pattern.endsWith('*') ? upper.startsWith(pattern.slice(0, -1)) : upper === pattern
  })
}

/** A credential any driver reads from the environment (`INHERITED_CREDENTIALS`). */
export function isInheritedCredential(name: string): boolean {
  return Object.values(INHERITED_CREDENTIALS).some((names) => matchesVariable(names!, name))
}

/**
 * Variables every process of a driver with a Mousse-owned home starts with, set after the inherited
 * credentials are dropped.
 */
export const DRIVER_VARIABLES: Partial<Record<HarnessDriverKind, Readonly<Record<string, string>>>> = {
  // Grok's own updater opens a console window on Windows and replaces the binary under Mousse;
  // sign-ins started from Mousse say where they come from.
  grok: { GROK_DISABLE_AUTOUPDATER: '1', GROK_OAUTH2_REFERRER: 'mousse' }
}

/**
 * Where the official Grok installer puts `grok`: `<GROK_HOME>/bin` of the user's own home
 * (`~/.grok/bin`), searched after PATH.
 */
export function grokStandaloneBin(base: NodeJS.ProcessEnv = process.env): string {
  const home = base.GROK_HOME?.trim()
  return join(home && isAbsolute(home) ? home : join(homedir(), '.grok'), 'bin')
}

export function instanceEnv(input: {
  instanceId: string
  driver: HarnessDriverKind
  configRevision: number
  /** Absolute Mousse-owned home; absent = the user's own home. */
  home?: string
  searchPath: readonly string[]
  base?: NodeJS.ProcessEnv
}): InstanceEnv {
  const base = input.base ?? process.env
  const variable = HOME_VARIABLES[input.driver]
  let env = input.home && variable ? withUserEnv(base, { [variable]: input.home }) : { ...base }
  if (input.home) {
    const drop = INHERITED_CREDENTIALS[input.driver] ?? []
    for (const key of Object.keys(env)) if (matchesVariable(drop, key)) delete env[key]
  }
  // Only a Mousse-owned home gets them: the user's own home runs the CLI as the user set it up.
  const own = input.home ? DRIVER_VARIABLES[input.driver] : undefined
  if (own) env = withUserEnv(env, { ...own })
  // The standalone Grok install is found after PATH, wherever the instance's home is.
  const extraSearch = input.driver === 'grok' ? [grokStandaloneBin(base)] : []
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    configRevision: input.configRevision,
    homeId: input.home ? privateHomeId(input.instanceId) : DEFAULT_HOME_ID,
    ...(input.home ? { home: input.home } : {}),
    env,
    searchPath: [...input.searchPath, ...extraSearch],
    ...(extraSearch.length ? { driverSearchPath: extraSearch } : {})
  }
}

/**
 * What a locked process (a bot's runtime, PR 6 §2) may take from Mousse's environment: what finds
 * programs, the home folder, the locale and terminal, the system folders, and the proxy and
 * certificate settings. Credentials, tokens and every other variable are left out.
 */
export const LOCKED_ENV_POSIX: readonly string[] = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TERM'])
export const LOCKED_ENV_WINDOWS: readonly string[] = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'PROGRAMDATA', 'PROGRAMFILES', 'CLAUDE_CODE_GIT_BASH_PATH'
])
/** Kept on every platform, in any case (`https_proxy` as well as `HTTPS_PROXY`). */
export const LOCKED_ENV_NETWORK: readonly string[] = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'])

/** The ambient credentials a driver's instance may run on, by provider (Pi's Bedrock and Vertex). */
const AMBIENT_ENV: Partial<Record<HarnessDriverKind, Readonly<Record<string, readonly string[]>>>> = { pi: PI_AMBIENT_ENV }

export interface LockedEnvInput {
  platform: NodeJS.Platform
  /** Mousse's environment, which the allowed variables are copied from. */
  base: NodeJS.ProcessEnv
  driver: HarnessDriverKind
  /** The instance's provider, for a driver with several (`pi:<provider>`). */
  provider?: string
  /** What the instance runs on (`InstanceSnapshot.auth.credential`): only `ambient` passes the provider's cloud credentials. */
  credential: CredentialKind
  /** The instance's Mousse-owned home, set as the driver's home variable. */
  home?: string
  /** The instance's own secret (its key variable), set after the home. */
  secrets?: Readonly<Record<string, string>>
  /** The activation's private scratch folder: on POSIX, `TMPDIR` is `<scratch>/tmp`. */
  scratch: string
  /** Values Mousse always sets (telemetry off), applied last over everything else. */
  enforced?: Readonly<Record<string, string>>
}

/**
 * The environment of a locked process, built from nothing (PR 6 §2): the platform's allowlist and
 * the network settings, `TMPDIR` in the scratch folder, then for an ambient instance exactly its
 * provider's cloud credentials (`PI_AMBIENT_ENV`), then the driver's home variable and the
 * instance's secret, then the enforced values. Key and subscription instances, and every driver
 * without ambient sign-in, get no cloud credentials. Interactive instances keep `instanceEnv`.
 */
export function lockedEnv(input: LockedEnvInput): NodeJS.ProcessEnv {
  const windows = input.platform === 'win32'
  const env: NodeJS.ProcessEnv = {}
  const copy = (names: readonly string[], anyCase: boolean) => {
    for (const [key, value] of Object.entries(input.base)) {
      if (value === undefined) continue
      const allowed = anyCase || windows ? matchesVariable(names, key) : names.some((name) => (name.endsWith('*') ? key.startsWith(name.slice(0, -1)) : key === name))
      if (allowed) env[key] = value
    }
  }
  /** Sets `name`, dropping any other spelling of it first (Windows names ignore case). */
  const put = (name: string, value: string) => {
    for (const key of Object.keys(env)) if (key === name || (windows && key.toUpperCase() === name.toUpperCase())) delete env[key]
    env[name] = value
  }
  copy(windows ? LOCKED_ENV_WINDOWS : LOCKED_ENV_POSIX, false)
  copy(LOCKED_ENV_NETWORK, true)
  if (!windows) put('TMPDIR', posix.join(input.scratch, 'tmp'))
  const ambient = input.credential === 'ambient' && input.provider ? AMBIENT_ENV[input.driver]?.[input.provider] : undefined
  if (ambient) copy(ambient, false)
  const variable = HOME_VARIABLES[input.driver]
  if (input.home && variable) put(variable, input.home)
  for (const [name, value] of Object.entries(input.secrets ?? {})) put(name, value)
  for (const [name, value] of Object.entries(input.enforced ?? {})) put(name, value)
  return env
}

export interface ResolvedBinary {
  /** What the snapshot shows: the override as typed, or the program found. */
  path?: string
  launch?: CliLaunch
  source: BinarySource
  /** Set when the explicit override cannot run (no fallback to PATH). */
  overrideMissing?: boolean
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Finds `names` on the inherited PATH and `~/.local/bin` first (where the services always looked),
 * then on the login-shell PATH. A Windows npm `.cmd` shim counts only once it resolves to the
 * program it runs.
 */
export function findOnPath(names: readonly string[], env: Pick<InstanceEnv, 'env' | 'searchPath'>, platform: NodeJS.Platform = process.platform): string | undefined {
  const inherited = (env.env.PATH ?? env.env.Path ?? '').split(platform === 'win32' ? ';' : ':')
  const directories = [...inherited, join(homedir(), '.local', 'bin'), ...env.searchPath]
  const seen = new Set<string>()
  for (const directory of directories) {
    if (!directory || seen.has(directory)) continue
    seen.add(directory)
    for (const name of names) {
      const candidate = resolve(directory, name)
      if (!executable(candidate)) continue
      if (resolveWindowsShim(candidate, { platform, env: env.env })) return candidate
    }
  }
  return undefined
}

/** Executable names of a CLI on this platform (`claude.exe`, then an npm `claude.cmd` shim). */
export function cliNames(name: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name]
}

/**
 * The binary an instance runs: an explicit override (which never falls back), a Mousse-managed
 * install, or the CLI found on PATH.
 */
/**
 * A command as the user typed it: an absolute path, or a bare name looked up on the inherited and
 * login-shell PATH (`grok` → `…/grok.exe` on Windows). Never a shell; a `.cmd` shim counts only
 * once it resolves to the program it runs.
 */
export function resolveCommand(command: string, env: Pick<InstanceEnv, 'env' | 'searchPath'>, platform: NodeJS.Platform = process.platform): CliLaunch | undefined {
  const trimmed = command.trim()
  if (!trimmed) return undefined
  if (isAbsolute(trimmed)) return cliLaunch(trimmed)
  // A relative path with a directory is never searched for.
  if (/[\\/]/.test(trimmed)) return undefined
  const names = platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(trimmed) ? [...cliNames(trimmed, platform), trimmed] : [trimmed]
  const found = findOnPath(names, env, platform)
  return found ? cliLaunch(found) : undefined
}

export function resolveBinary(input: {
  override?: string
  /** Extra check for an override (e.g. Antigravity's helper beside it); throws when invalid. */
  validateOverride?: (path: string) => void
  managed?: string
  names: readonly string[]
  env: Pick<InstanceEnv, 'env' | 'searchPath'>
}): ResolvedBinary {
  if (input.override) {
    let launch = resolveCommand(input.override, input.env)
    if (launch && input.validateOverride) {
      try {
        input.validateOverride(input.override)
      } catch {
        launch = undefined
      }
    }
    return launch ? { path: input.override, launch, source: 'override' } : { path: input.override, source: 'override', overrideMissing: true }
  }
  if (input.managed) return { path: input.managed, launch: cliLaunch(input.managed), source: 'managed' }
  const found = input.names.length ? findOnPath(input.names, input.env) : undefined
  const launch = found ? cliLaunch(found) : undefined
  return launch ? { path: launch.path, launch, source: 'path' } : { source: 'path' }
}
