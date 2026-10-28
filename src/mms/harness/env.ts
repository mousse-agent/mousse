import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import type { BinarySource, CredentialKind } from '../../shared/harness/status'
import type { HarnessDriverKind } from '../../shared/harness/types'
import { cliLaunch, withUserEnv, type CliLaunch } from './cliConfig'
import { resolveWindowsShim } from './resolveWindowsShim'
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
  /**
   * Variables set last on every process of the instance, over the launch variables and anything a
   * caller adds (the agent's telemetry switch, Settings → Providers). `spawnHarness` applies
   * them; a runtime that builds its own process environment applies them itself (`withEnforced`).
   */
  enforced?: Readonly<Record<string, string>>
  /**
   * Launch arguments added last to the processes that take the entry's launch arguments (the
   * agent's telemetry switch, e.g. Codex's `-c analytics.enabled=false`).
   */
  enforcedArgs?: readonly string[]
}

/** `env` with `enforced` set over it, dropping any other spelling of each name first (Windows names ignore case). */
export function withEnforced(env: NodeJS.ProcessEnv, enforced: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const names = Object.keys(enforced ?? {})
  if (!names.length) return env
  const upper = new Set(names.map((name) => name.toUpperCase()))
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!upper.has(key.toUpperCase())) next[key] = value
  return Object.assign(next, enforced)
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
 * whatever its home holds. Variables set on the instance itself still apply, except for a driver
 * with `OwnedEnvRules` (Claude Code, Codex), which refuses the credential families there too.
 */
export const INHERITED_CREDENTIALS: Partial<Record<HarnessDriverKind, readonly string[]>> = {
  claude: [
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    // The other ways Claude Code takes a token, a key or a file holding one.
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
    'CLAUDE_CODE_HOST_CREDS_FILE', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_ENVIRONMENT_KEY', 'ANTHROPIC_WORK_SECRET', 'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE'
  ],
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

/**
 * How the environment of an instance with its own home is built, for the drivers that take part
 * (`ownedLaunchEnv`). Mousse's own environment may hold the user's sign-in in more places than a
 * list of credential names can follow, so the families that choose or hold a credential are closed:
 * nothing in them is inherited but what `inherit` names. What the instance configures is applied
 * on top, except the `reserved` names, which Settings refuses and a stored one loses at launch.
 */
interface OwnedEnvRules {
  /** Families (a trailing `*` is a prefix) that are not inherited from Mousse's environment. */
  closed: readonly string[]
  /** Inherited although they are in a closed family. */
  inherit: readonly string[]
  /** Names the instance cannot configure: where the sign-in lives, and how a process picks one. */
  reserved: readonly string[]
  /** The variables Mousse sets to point the driver at the instance's home. */
  fixed(home: string): Record<string, string>
  /**
   * Configuration keys a launch argument (`-c key=value`) cannot set: they move the sign-in or the
   * state out of the home, send the account's token to another address, or pick another route.
   * A key matches itself and every key under it (`model_providers` covers `model_providers.x.env_key`).
   */
  reservedConfig?: readonly string[]
}

const CLAUDE_OWNED_ENV: OwnedEnvRules = {
  // Anthropic's and Claude Code's own variables, and the cloud providers it can sign in through.
  closed: ['ANTHROPIC_*', 'CLAUDE_*', 'AWS_*', 'GOOGLE_*', 'GCLOUD_*', 'CLOUDSDK_*', 'AZURE_*'],
  // Where Git for Windows is: not a credential, and Claude Code needs it.
  inherit: ['CLAUDE_CODE_GIT_BASH_PATH'],
  reserved: [
    // Where the sign-in is kept: the credential file and the Keychain / Credential Manager item (the
    // secure-storage variable wins over the config dir; empty means `~/.claude`), and the Anthropic
    // profile store, which outranks the config dir.
    'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE',
    // Credentials, and the identities that stand for one.
    ...(INHERITED_CREDENTIALS.claude ?? []),
    'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_SCOPE',
    'CLAUDE_CODE_OAUTH_*', 'CLAUDE_CODE_SESSION_*', 'CLAUDE_CODE_HOST_*', 'CLAUDE_CODE_ACCOUNT_*', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL',
    // The route a process signs in through (a cloud provider or a gateway) instead of the account.
    'CLAUDE_CODE_USE_*', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
    'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH', 'CLAUDE_CODE_SKIP_MANTLE_AUTH',
    'AWS_*', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_*', 'CLOUDSDK_*', 'AZURE_*'
  ],
  // The credential file and the OS credential item of each instance are its own (the item's name is
  // made from this folder), and the Anthropic profile store is inside the home, so the user's shared
  // one (`%APPDATA%\Anthropic`, `~/.config/anthropic`) is never looked at.
  fixed: (home) => ({ CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home, ANTHROPIC_CONFIG_DIR: join(home, 'anthropic') })
}

const CODEX_OWNED_ENV: OwnedEnvRules = {
  // Codex's own variables (the home and the state database, access tokens, keys, login servers and
  // identity services) and the other routes it can take instead of a ChatGPT sign-in: OpenAI and
  // Azure OpenAI keys and addresses, ChatGPT, and Amazon Bedrock. Names checked against the text of
  // Codex 0.162's program file, which was not run.
  closed: ['CODEX_*', 'OPENAI_*', 'CHATGPT_*', 'AZURE_*', 'AWS_*', ...(INHERITED_CREDENTIALS.codex ?? [])],
  // A certificate bundle for the network is not a credential, and a company network needs it.
  inherit: ['CODEX_CA_CERTIFICATE'],
  reserved: ['CODEX_*', 'OPENAI_*', 'CHATGPT_*', 'AZURE_*', 'AWS_*', ...(INHERITED_CREDENTIALS.codex ?? [])],
  // The sign-in file and the OS credential item are named after this folder, and the state database
  // stays in it, so one instance never reads or writes another account's files.
  fixed: (home) => ({ CODEX_HOME: home, CODEX_SQLITE_HOME: home }),
  // `-c` overrides win over the home's own config file. Where the sign-in is stored (the login
  // command runs without the entry's arguments, so it would store it another way), where state and
  // logs go, the addresses a token is sent to, and the model providers a turn could be routed through.
  reservedConfig: ['openai_base_url', 'chatgpt_base_url', 'sqlite_home', 'log_dir', 'cli_auth_credentials_store', 'model_provider', 'model_providers']
}

const OWNED_ENV_RULES: Partial<Record<HarnessDriverKind, OwnedEnvRules>> = { claude: CLAUDE_OWNED_ENV, codex: CODEX_OWNED_ENV }

/**
 * Why `name` cannot be set in the configured variables of an instance with its own home: it says
 * where the sign-in lives or how a process picks one (`home`: Mousse sets it; `credential`: it is
 * not passed). Undefined when it is free to set, and for drivers without rules. Case-insensitive,
 * as Windows is.
 */
export function reservedEnvName(driver: HarnessDriverKind, name: string): { kind: 'home' | 'credential'; variable: string } | undefined {
  const rules = OWNED_ENV_RULES[driver]
  if (!rules) return undefined
  const fixed = Object.keys(rules.fixed('')).find((variable) => variable.toUpperCase() === name.toUpperCase())
  if (fixed) return { kind: 'home', variable: fixed }
  if (matchesVariable(rules.inherit, name)) return undefined
  return matchesVariable(rules.reserved, name) ? { kind: 'credential', variable: name } : undefined
}

/**
 * The configuration overrides in launch arguments (`-c key=value`, `--config key=value`,
 * `--config=key=value`, `-ckey=value`), with where each sits in `args` and how many arguments it takes.
 */
function configOverrides(args: readonly string[]): Array<{ key: string; at: number; length: number }> {
  const found: Array<{ key: string; at: number; length: number }> = []
  const keyOf = (text: string) => text.split('=')[0]!.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!
    if (arg === '-c' || arg === '--config') {
      if (at + 1 < args.length) found.push({ key: keyOf(args[at + 1]!), at, length: 2 })
      at += 1
    } else if (/^--config=/.test(arg)) found.push({ key: keyOf(arg.slice('--config='.length)), at, length: 1 })
    else if (/^-c.+/.test(arg)) found.push({ key: keyOf(arg.slice(2).replace(/^=/, '')), at, length: 1 })
  }
  return found
}

const reservedConfigKey = (rules: OwnedEnvRules, key: string): boolean =>
  (rules.reservedConfig ?? []).some((name) => key === name || key.startsWith(`${name}.`))

/**
 * The configuration keys among `args` that an instance with its own home cannot set
 * (`OwnedEnvRules.reservedConfig`), in the order given. Empty for a driver without rules.
 */
export function reservedLaunchKeys(driver: HarnessDriverKind, args: readonly string[] | undefined): string[] {
  const rules = OWNED_ENV_RULES[driver]
  if (!rules?.reservedConfig || !args) return []
  return configOverrides(args).filter((entry) => reservedConfigKey(rules, entry.key)).map((entry) => entry.key)
}

/** The launch arguments of an instance with its own home, without the overrides Mousse reserves. */
export function ownedUserArgs(driver: HarnessDriverKind, args: readonly string[] | undefined): string[] | undefined {
  const rules = OWNED_ENV_RULES[driver]
  if (!args || !rules?.reservedConfig) return args ? [...args] : undefined
  const drop = new Set<number>()
  for (const entry of configOverrides(args))
    if (reservedConfigKey(rules, entry.key)) for (let offset = 0; offset < entry.length; offset += 1) drop.add(entry.at + offset)
  return args.filter((_, index) => !drop.has(index))
}

/** The configured variables of an instance with its own home, without the ones Mousse reserves. */
export function ownedUserEnv(driver: HarnessDriverKind, userEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(userEnv ?? {})) if (!reservedEnvName(driver, name)) kept[name] = value
  return kept
}

/**
 * The one environment every process of an instance with its own home starts with (status checks,
 * turns, sign-in, sign-out): Mousse's environment without the families that choose or hold a
 * credential, the instance's configured variables on top (minus the reserved ones), then the
 * driver's home variables set to the instance's home. A configured or inherited `CLAUDE_CONFIG_DIR`,
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`, Anthropic profile, key or cloud route therefore never reaches a
 * process that must run as its own account. An instance without a home of its own, and a driver
 * without rules, run as configured.
 */
export function ownedLaunchEnv(
  driver: HarnessDriverKind,
  instance: Pick<InstanceEnv, 'env' | 'home'>,
  userEnv: Readonly<Record<string, string>> | undefined
): NodeJS.ProcessEnv {
  const rules = OWNED_ENV_RULES[driver]
  if (!instance.home || !rules) return withUserEnv(instance.env, { ...(userEnv ?? {}) })
  const inherited: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(instance.env)) {
    if (!matchesVariable(rules.closed, key) || matchesVariable(rules.inherit, key)) inherited[key] = value
  }
  const env = withUserEnv(inherited, ownedUserEnv(driver, userEnv))
  const fixed = rules.fixed(instance.home)
  const names = new Set(Object.keys(fixed).map((name) => name.toUpperCase()))
  for (const key of Object.keys(env)) if (names.has(key.toUpperCase())) delete env[key]
  return Object.assign(env, fixed)
}

export function instanceEnv(input: {
  instanceId: string
  driver: HarnessDriverKind
  configRevision: number
  /** Absolute Mousse-owned home; absent = the user's own home. */
  home?: string
  searchPath: readonly string[]
  base?: NodeJS.ProcessEnv
  /** `InstanceEnv.enforced`: set last on every process. */
  enforced?: Readonly<Record<string, string>>
  /** `InstanceEnv.enforcedArgs`. */
  enforcedArgs?: readonly string[]
}): InstanceEnv {
  const base = input.base ?? process.env
  const variable = HOME_VARIABLES[input.driver]
  const owned = Boolean(input.home && OWNED_ENV_RULES[input.driver])
  // A driver with rules (Claude Code, Codex) starts from the owned environment; the others drop their listed credentials.
  let env = owned ? ownedLaunchEnv(input.driver, { env: base, home: input.home }, undefined) : input.home && variable ? withUserEnv(base, { [variable]: input.home }) : { ...base }
  if (input.home && !owned) {
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
    ...(extraSearch.length ? { driverSearchPath: extraSearch } : {}),
    ...(input.enforced && Object.keys(input.enforced).length ? { enforced: { ...input.enforced } } : {}),
    ...(input.enforcedArgs?.length ? { enforcedArgs: [...input.enforcedArgs] } : {})
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
