import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isClaudeSignInVariable } from '../../claude/apiKey'

/** Variables whose value is the credential Claude Code sends: the value identifies it. */
const CLAUDE_DIRECT_CREDENTIALS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

/** Where Claude Code reads policy settings, by platform (they apply over the user's). */
export function managedSettingsPaths(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json']
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  return ['/etc/claude-code/managed-settings.json']
}

export interface AccountSubjectOptions {
  readText?: (path: string) => string
  /** The user's home directory (default `os.homedir()`). */
  home?: string
  platform?: NodeJS.Platform
}

type Json = Record<string, unknown>

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const on = (value: string | undefined) => Boolean(value && /^(1|true|yes|on)$/i.test(value))

/** The user's and the managed settings Claude Code reads, and the environment they give it. */
function readClaudeSettings(env: NodeJS.ProcessEnv, options: AccountSubjectOptions) {
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  const home = options.home ?? homedir()
  const json = (path: string): Json | undefined => {
    try {
      const value: unknown = JSON.parse(readText(path))
      return isRecord(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  const settings = [json(join(configDir || join(home, '.claude'), 'settings.json')), ...managedSettingsPaths(options.platform ?? process.platform).map(json)]
    .filter((value): value is Json => Boolean(value))
  // Claude Code applies the `env` of its settings over its own environment.
  const effective: Record<string, string | undefined> = { ...env }
  for (const entry of settings)
    if (isRecord(entry.env)) for (const [name, value] of Object.entries(entry.env)) if (typeof value === 'string') effective[name] = value
  return { json, readText, home, configDir, settings, effective }
}

/**
 * A variable as Claude Code sees it: its environment with the `env` of the user's and the managed
 * settings applied over it (project settings are not read). Undefined when unset or blank.
 */
export function claudeEffectiveVariable(env: NodeJS.ProcessEnv, name: string, options: AccountSubjectOptions = {}): string | undefined {
  return readClaudeSettings(env, options).effective[name]?.trim() || undefined
}

/**
 * The environment Claude Code runs with once it applies the `env` of the user's and the managed
 * settings. A turn that loads no settings files passes it so the sign-in kept there (a proxy's
 * address and token, say) still applies.
 */
export function claudeEffectiveEnvironment(env: NodeJS.ProcessEnv, options: AccountSubjectOptions = {}): NodeJS.ProcessEnv {
  return readClaudeSettings(env, options).effective
}

/** A cloud's own environment is allowed only while one of its Claude routes is enabled. */
const CLOUD_SIGN_IN_VARIABLES: ReadonlyArray<{ routes: readonly string[]; names: RegExp | ReadonlySet<string> }> = [
  { routes: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'], names: /^AWS_/ },
  // ADC/GoogleAuth inputs, plus Claude's project, location and quota inputs; no other Google product's keys.
  { routes: ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'], names: new Set([
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'CLOUDSDK_CONFIG', 'CLOUD_ML_REGION'
  ]) },
  // Azure Identity's default credential chain and the Azure CLI configuration it may use.
  { routes: ['CLAUDE_CODE_USE_FOUNDRY'], names: new Set([
    'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH',
    'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_CLIENT_SEND_CERTIFICATE_CHAIN', 'AZURE_ADDITIONALLY_ALLOWED_TENANTS',
    'AZURE_AUTHORITY_HOST', 'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_USERNAME', 'AZURE_PASSWORD',
    'AZURE_CONFIG_DIR', 'AZURE_TOKEN_CREDENTIALS'
  ]) }
]

/** Claude's own configuration families, kept as families so a new model or setting needs no Mousse update. */
const CLAUDE_CONFIGURATION_VARIABLE = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_.*CONFIG_DIR$|VERTEX_REGION_CLAUDE_|ENABLE_PROMPT_CACHING_)/
const SIGN_IN_SUPPORT_VARIABLE = /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/

/**
 * `base` (default `env`) with only the sign-in variables of the user's and the managed settings' `env` applied over it
 * (including Claude configuration families and the active cloud environment), for a request that loads no settings files yet must keep a sign-in kept there
 * (a proxy's address and token). Nothing that changes what runs at start-up is copied: no
 * `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_*`/`DYLD_*`, `PYTHON*` or `ELECTRON_RUN_AS_NODE`.
 */
export function claudeSignInEnvironment(env: NodeJS.ProcessEnv, options: AccountSubjectOptions = {}, base: NodeJS.ProcessEnv = env): NodeJS.ProcessEnv {
  const { effective } = readClaudeSettings(env, options)
  const signIn: NodeJS.ProcessEnv = { ...base }
  const clouds = CLOUD_SIGN_IN_VARIABLES.filter(({ routes }) => routes.some((route) => on(effective[route])))
  for (const [name, value] of Object.entries(effective)) {
    if (CLAUDE_CONFIGURATION_VARIABLE.test(name) || isClaudeSignInVariable(name) || SIGN_IN_SUPPORT_VARIABLE.test(name) || clouds.some(({ names }) => names instanceof RegExp ? names.test(name) : names.has(name))) signIn[name] = value
  }
  return signIn
}

/**
 * A stable id of the account Claude Code runs as, read from the files and variables it reads,
 * without starting it (never shown or stored; the gateway hashes it). Undefined when Mousse cannot
 * tell which account a turn would use; the gateway then hands the history over instead of resuming.
 *
 * Every credential Claude Code may use is part of the id, so a change to any of them reads as
 * another account (forgetting a session too often is safe; resuming another account's is not):
 * - a token or key variable, by a hash of its value;
 * - on Bedrock, the AWS access key id (the named profile's static keys, else the variables, else the
 *   default profile's, as the AWS SDK default chain picks them); on Vertex,
 *   the service account or user grant of the Google credentials file, with the project;
 * - the claude.ai sign-in stored in the home's `.claude.json` (account and organization).
 * A credential Mousse cannot see makes the account unknown even when a stored sign-in is there:
 * an `apiKeyHelper` or AWS credential export in Claude's settings, an AWS profile without static
 * keys (SSO, roles, processes), the cloud default chains, or a Google credential of another kind.
 * Cloud variables count only when their route is on (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`).
 * Project settings are not read: they depend on the folder of each turn.
 */
export function claudeAccountSubject(env: NodeJS.ProcessEnv, options: AccountSubjectOptions = {}): string | undefined {
  const { json, readText, home, configDir, settings, effective } = readClaudeSettings(env, options)
  const value = (name: string) => effective[name]?.trim() || undefined
  const setting = (name: string) => settings.some((entry) => typeof entry[name] === 'string' && (entry[name] as string).trim())

  if (setting('apiKeyHelper')) return undefined
  const parts: string[] = []
  if (on(value('CLAUDE_CODE_USE_BEDROCK'))) {
    const principal = setting('awsCredentialExport') ? undefined : bedrockPrincipal(value, readText, home)
    if (!principal) return undefined
    parts.push(principal)
  } else if (on(value('CLAUDE_CODE_USE_VERTEX'))) {
    const principal = vertexPrincipal(value, readText, home, options.platform ?? process.platform)
    if (!principal) return undefined
    parts.push(principal)
  }
  const direct = CLAUDE_DIRECT_CREDENTIALS.filter((name) => value(name))
  if (direct.length) parts.push(`env:${sha(direct.map((name) => `${name}=${value(name)}`).join('\n'))}`)
  const account = json(configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'))?.oauthAccount
  if (isRecord(account) && typeof account.accountUuid === 'string' && account.accountUuid)
    parts.push(`claude.ai:${account.accountUuid}:${typeof account.organizationUuid === 'string' ? account.organizationUuid : ''}`)
  if (!parts.length) return undefined
  // A proxy is not a credential, but the same credential through another route is another account.
  const route = value('ANTHROPIC_BASE_URL')
  if (route) parts.push(`route:${sha(route)}`)
  return parts.join('|')
}

/**
 * The credential and route overrides a regular turn may load on top of its instance's sign-in.
 * Keep every candidate in the key, since project trust and settings precedence can change which
 * one Claude uses. A helper or an indirect credential cannot be identified from settings alone.
 */
export function claudeTurnCredentialKey(
  cwd: string,
  sources: readonly string[] = ['project', 'local'],
  inline?: object
): string | undefined {
  const files: string[] = []
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (sources.includes('project')) files.push(join(folder, '.claude', 'settings.json'))
    if (sources.includes('local')) files.push(join(folder, '.claude', 'settings.local.json'))
    if (dirname(folder) === folder) break
  }
  const settings: unknown[] = [inline]
  for (const file of files) {
    try {
      settings.push(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
  }
  const credentials: unknown[] = []
  for (const entry of settings) {
    if (!isRecord(entry)) continue
    if (entry.apiKeyHelper || entry.awsCredentialExport || entry.awsAuthRefresh || entry.gcpAuthRefresh || entry.forceLoginOrgUUID || entry.forceLoginMethod) return undefined
    if (!isRecord(entry.env)) continue
    const overrides = Object.entries(entry.env).filter(([key]) =>
      isClaudeSignInVariable(key) || SIGN_IN_SUPPORT_VARIABLE.test(key) ||
      CLOUD_SIGN_IN_VARIABLES.some(({ names }) => names instanceof RegExp ? names.test(key) : names.has(key)))
    if (overrides.some(([key, value]) => typeof value !== 'string' ||
        (key !== 'ANTHROPIC_BASE_URL' && !CLAUDE_DIRECT_CREDENTIALS.includes(key)))) return undefined
    if (overrides.length) credentials.push(overrides.sort(([a], [b]) => a.localeCompare(b)))
  }
  return sha(JSON.stringify(credentials))
}

/**
 * Whether Claude Code's settings forbid `bypassPermissions` (`permissions.disableBypassPermissionsMode:
 * "disable"`), read from the files it reads without starting it: the user's `settings.json` (the
 * instance's config directory when it has one), the managed policy file, and, when the turn has a
 * folder, that folder's `.claude/settings.json` and `settings.local.json`. Any one of them is enough:
 * a mode Claude Code refuses is never offered. Settings Claude Code loads from elsewhere (an
 * `--settings` file) are not read.
 */
export function claudeBypassDisabled(env: NodeJS.ProcessEnv, options: AccountSubjectOptions & { cwd?: string } = {}): boolean {
  return anyClaudeSettings(env, options, (settings) => {
    const permissions = settings.permissions
    return isRecord(permissions) && permissions.disableBypassPermissionsMode === 'disable'
  })
}

/**
 * Whether Claude Code's settings turn its auto mode off (`disableAutoMode: "disable"`; the
 * `permissions` block is read too), from the same files as `claudeBypassDisabled`. Any one of them is
 * enough: a thread set to Auto then runs as Auto-accept edits rather than in a mode Claude Code refuses.
 */
export function claudeAutoModeDisabled(env: NodeJS.ProcessEnv, options: AccountSubjectOptions & { cwd?: string } = {}): boolean {
  return anyClaudeSettings(env, options, (settings) => {
    const permissions = settings.permissions
    return settings.disableAutoMode === 'disable' || (isRecord(permissions) && permissions.disableAutoMode === 'disable')
  })
}

/**
 * A variable as a turn in `options.cwd` sees it: `claudeEffectiveVariable`, with the `env` of that
 * folder's `.claude/settings.json` and `settings.local.json` over the user's (managed settings still
 * win). Undefined when unset or blank.
 */
export function claudeTurnVariable(env: NodeJS.ProcessEnv, name: string, options: AccountSubjectOptions & { cwd?: string } = {}): string | undefined {
  const { json, effective } = readClaudeSettings(env, options)
  const managed = managedSettingsPaths(options.platform ?? process.platform).map(json)
  const fromSettings = (entry: Json | undefined) => (isRecord(entry?.env) && typeof entry.env[name] === 'string' ? (entry.env[name] as string).trim() || undefined : undefined)
  const project = options.cwd ? [json(join(options.cwd, '.claude', 'settings.local.json')), json(join(options.cwd, '.claude', 'settings.json'))] : []
  for (const entry of [...managed, ...project]) {
    const value = fromSettings(entry)
    if (value) return value
  }
  return effective[name]?.trim() || undefined
}

/** Claude Code's variables that choose the prompt cache lifetime (the first wins over its `promptCacheTtl` setting). */
export const CLAUDE_CACHE_TTL_VARIABLES = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H'] as const

/**
 * Whether the user already chose Claude Code's prompt cache lifetime: one of
 * `CLAUDE_CACHE_TTL_VARIABLES` in its environment, or `promptCacheTtl` or one of those variables in
 * any settings file it reads for a turn in `options.cwd` (the files of `claudeBypassDisabled`).
 * Mousse then sets nothing, since its variable would override that choice.
 */
export function claudeChoosesCacheTtl(env: NodeJS.ProcessEnv, options: AccountSubjectOptions & { cwd?: string } = {}): boolean {
  if (CLAUDE_CACHE_TTL_VARIABLES.some((name) => env[name]?.trim())) return true
  return anyClaudeSettings(env, options, (settings) => {
    if (settings.promptCacheTtl !== undefined) return true
    const vars = settings.env
    return isRecord(vars) && CLAUDE_CACHE_TTL_VARIABLES.some((name) => typeof vars[name] === 'string' && (vars[name] as string).trim() !== '')
  })
}

/**
 * Whether a settings file Claude Code reads for a turn in `options.cwd` sets `apiKeyHelper`: its requests then carry
 * the key that command prints, whatever `claude auth status` reports.
 */
export function claudeUsesApiKeyHelper(env: NodeJS.ProcessEnv, options: AccountSubjectOptions & { cwd?: string } = {}): boolean {
  return anyClaudeSettings(env, options, (settings) => typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim() !== '')
}

/** Whether `test` holds for any settings file Claude Code reads for a turn in `options.cwd`; an unreadable file holds nothing. */
function anyClaudeSettings(env: NodeJS.ProcessEnv, options: AccountSubjectOptions & { cwd?: string }, test: (settings: Record<string, unknown>) => boolean): boolean {
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  const home = options.home ?? homedir()
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  const paths = [
    join(configDir || join(home, '.claude'), 'settings.json'),
    ...managedSettingsPaths(options.platform ?? process.platform),
    ...(options.cwd ? [join(options.cwd, '.claude', 'settings.json'), join(options.cwd, '.claude', 'settings.local.json')] : [])
  ]
  return paths.some((path) => {
    try {
      const value: unknown = JSON.parse(readText(path))
      return isRecord(value) && test(value)
    } catch {
      return false
    }
  })
}

/** The AWS access key Bedrock calls are signed with, when Mousse can read it; else undefined. */
function bedrockPrincipal(value: (name: string) => string | undefined, readText: (path: string) => string, home: string): string | undefined {
  const token = value('AWS_BEARER_TOKEN_BEDROCK')
  if (token) return `bedrock:token:${sha(token)}`
  const region = value('AWS_REGION') ?? value('AWS_DEFAULT_REGION') ?? ''
  // The AWS SDK default chain Claude Code uses skips the key variables when a profile is named:
  // the profile wins, so its keys are the ones the calls are signed with.
  const named = value('AWS_PROFILE')
  const keyId = value('AWS_ACCESS_KEY_ID')
  if (keyId && !named) return `bedrock:key:${sha(keyId)}:${region}`
  // The shared credentials file of the profile; a profile without static keys (SSO, a role, a
  // credential process) or the remaining default chain (instance roles, ...) is unknown.
  let text: string
  try {
    text = readText(value('AWS_SHARED_CREDENTIALS_FILE') ?? join(home, '.aws', 'credentials'))
  } catch {
    return undefined
  }
  const profile = named ?? 'default'
  let section: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) {
      section = header[1]!.trim()
      continue
    }
    const entry = /^\s*aws_access_key_id\s*=\s*(\S+)\s*$/.exec(line)
    if (entry && section === profile) return `bedrock:key:${sha(entry[1]!)}:${region}`
  }
  return undefined
}

/** The Google principal Vertex calls run as, when Mousse can read it; else undefined. */
function vertexPrincipal(value: (name: string) => string | undefined, readText: (path: string) => string, home: string, platform: NodeJS.Platform): string | undefined {
  const gcloud = value('CLOUDSDK_CONFIG') ?? (platform === 'win32' ? join(value('APPDATA') ?? join(home, 'AppData', 'Roaming'), 'gcloud') : join(home, '.config', 'gcloud'))
  let credentials: Json
  try {
    const parsed: unknown = JSON.parse(readText(value('GOOGLE_APPLICATION_CREDENTIALS') ?? join(gcloud, 'application_default_credentials.json')))
    if (!isRecord(parsed)) return undefined
    credentials = parsed
  } catch {
    // No file: the metadata server or another default credential Mousse cannot read.
    return undefined
  }
  const project = value('ANTHROPIC_VERTEX_PROJECT_ID') ?? ''
  if (credentials.type === 'service_account' && typeof credentials.client_email === 'string')
    return `vertex:sa:${credentials.client_email}:${project}`
  if (credentials.type === 'authorized_user' && typeof credentials.refresh_token === 'string')
    return `vertex:user:${sha(`${String(credentials.client_id ?? '')}|${credentials.refresh_token}`)}:${project}`
  return undefined
}
