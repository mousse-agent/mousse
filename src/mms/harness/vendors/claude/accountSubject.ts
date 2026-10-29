import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
