import { createHash, createHmac } from 'node:crypto'
import type { ResolvedSettings, Settings } from '@anthropic-ai/claude-agent-sdk'
import Anthropic from '@anthropic-ai/sdk'
import { isClaudeSubscriptionToken } from '../../providers/claudeSdkProvider'

/**
 * Claude Code with an Anthropic API key (`loginMethod: 'api_key'`, PR 2 §6). The key is a vault
 * secret of the instance, applied last to every process as `ANTHROPIC_API_KEY`. Every other way
 * Claude Code could sign in or be routed from its environment is dropped first, the entry's own
 * home is set again, and the only address honoured is one set on the entry itself. Mousse never
 * handles a Claude subscription token here: one is refused as a key.
 */

/** The instance config value that makes a Claude Code entry run on an API key. */
export const CLAUDE_API_KEY_LOGIN = 'api_key'

/** The variable Claude Code reads the key from. */
export const CLAUDE_API_KEY_VARIABLE = 'ANTHROPIC_API_KEY'
/** Where Claude Code sends requests when the entry names no other address. */
export const CLAUDE_BASE_URL_VARIABLE = 'ANTHROPIC_BASE_URL'

/**
 * `CLAUDE_CODE_USE_*` switches that pick a tool, not a provider or transport. Every other
 * `CLAUDE_CODE_USE_*` is a route (Bedrock, Vertex, Foundry, Claude Platform on AWS or Google
 * Cloud, Mantle, a gateway, remote sessions) and is dropped, including ones a later Claude Code adds.
 */
const USE_NOT_A_ROUTE: ReadonlySet<string> = new Set(['CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH', 'CLAUDE_CODE_USE_COWORK_PLUGINS'])

/**
 * Names of the shipped Claude Code's credential and route inputs (read from its binary,
 * `claudeEnv` test): tokens, keys, secrets, file-descriptor credentials, OAuth and workload
 * identity, profiles and config dirs, every base URL, a Unix socket, custom headers, host-managed
 * auth, and account and organization ids.
 */
const CREDENTIAL_OR_ROUTE = /TOKEN(?!S)|SECRET|PASSPHRASE|_KEY(?:_|$)|CREDS|CREDENTIAL|IDENTITY|FEDERATION|OAUTH|_PROFILE$|CONFIG_DIR|BASE_URL|UNIX_SOCKET|CUSTOM_HEADERS|HOST_AUTH|ORGANIZATION_ID|ORGANIZATION_UUID|ACCOUNT_UUID|ACCOUNT_TAGGED_ID|SERVICE_ACCOUNT|WORKSPACE_ID|_SCOPE$|PROVIDER_MANAGED|PIN_STORED_LOGIN|REMOTE_SDK_URL|_API_HOST$|FILE_DESCRIPTOR|SKIP_\w*AUTH$/

/** Names the pattern matches that only tune Claude Code (token counts, a shape): kept. */
const NOT_A_CREDENTIAL: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_IDLE_TOKEN_THRESHOLD',
  'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
  'CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT',
  'CLAUDE_CODE_ARG_KEY_SHAPE'
])

/**
 * Whether Claude Code could sign in, or be sent somewhere other than the entry's address, through
 * `name` (any case): dropped from every process of an API-key entry, wherever it came from (Mousse's
 * environment, the entry's own variables, the user's MCP variables).
 */
export function isClaudeSignInVariable(name: string): boolean {
  // Claude Code's own hidden companions (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`) read like the rest.
  const upper = name.toUpperCase().replace(/^_+/, '')
  if (upper === 'CLAUDE_CONFIG_DIR') return true
  if (!upper.startsWith('ANTHROPIC_') && !upper.startsWith('CLAUDE_CODE_')) return false
  if (NOT_A_CREDENTIAL.has(upper)) return false
  if (upper.startsWith('CLAUDE_CODE_USE_')) return !USE_NOT_A_ROUTE.has(upper)
  return CREDENTIAL_OR_ROUTE.test(upper)
}

/** Where `models.list` and Claude Code go when the entry names no other address. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

/** Why a key cannot be saved; undefined when it can. */
export function claudeApiKeyProblem(apiKey: string): string | undefined {
  const key = apiKey.trim()
  if (!key) return 'Paste an Anthropic API key.'
  if (isClaudeSubscriptionToken(key))
    return 'This is a Claude subscription token, not an API key. Create an API key at console.anthropic.com, or sign in to Claude Code itself.'
  return undefined
}

/**
 * The address set on the entry itself (`config.env.ANTHROPIC_BASE_URL`, any case): the only one an
 * API-key entry honours. One inherited from Mousse's environment, or from MCP variables, is not.
 */
export function entryBaseUrl(entryEnv: Readonly<Record<string, string>> | undefined): string | undefined {
  const value = Object.entries(entryEnv ?? {}).find(([name]) => name.toUpperCase() === CLAUDE_BASE_URL_VARIABLE)?.[1]?.trim()
  return value || undefined
}

/**
 * The environment of a process of an API-key entry: `env` without any sign-in or route variable,
 * then the entry's own home, the entry's own address, and the key (absent when none is saved, so
 * Claude Code has nothing to sign in with).
 */
export function claudeApiKeyEnv(env: NodeJS.ProcessEnv, entry: { apiKey?: string; home?: string; baseUrl?: string }): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) if (!isClaudeSignInVariable(name)) next[name] = value
  if (entry.home) next.CLAUDE_CONFIG_DIR = entry.home
  if (entry.baseUrl) next[CLAUDE_BASE_URL_VARIABLE] = entry.baseUrl
  if (entry.apiKey && !claudeApiKeyProblem(entry.apiKey)) next[CLAUDE_API_KEY_VARIABLE] = entry.apiKey.trim()
  return next
}

/**
 * `apikey:<HMAC>` of the key, never the key; the entry's own address, when it sets one, is part of
 * it (the same key through another address is another account).
 */
export function claudeApiKeySubject(apiKey: string, baseUrl?: string): string {
  const subject = `apikey:${createHmac('sha256', 'mousse-claude-key').update(apiKey.trim()).digest('hex')}`
  return baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL ? `${subject}|route:${createHash('sha256').update(baseUrl).digest('hex')}` : subject
}

/** What Recheck learned about a key. */
export type ClaudeApiKeyCheck = 'accepted' | 'refused'

/** Asks the Anthropic API whether it accepts `apiKey` (`models.list`). Throws when it could not tell. */
export type ClaudeApiKeyChecker = (input: { apiKey: string; baseUrl: string; signal?: AbortSignal }) => Promise<ClaudeApiKeyCheck>

/**
 * One `models.list` request with the key alone: no bearer token, custom headers or default
 * credentials from Mousse's own environment, and no SDK retry. 401 and 403 are a refused key; any
 * other failure throws (it says nothing about the key).
 */
export const checkClaudeApiKey: ClaudeApiKeyChecker = async ({ apiKey, baseUrl, signal }) => {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: 15_000,
    // Custom headers from Mousse's own environment (`ANTHROPIC_CUSTOM_HEADERS`) never replace the key.
    defaultHeaders: { authorization: null, 'x-api-key': apiKey }
  })
  try {
    await client.models.list({ limit: 1 }, signal ? { signal } : undefined)
    return 'accepted'
  } catch (error) {
    if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) return 'refused'
    throw error
  }
}

/**
 * Sign-in variables a settings file may set that the flag tier can make harmless: blank, they
 * read as unset (Claude Code tests each for a truthy value), so the key in the environment is the
 * one used. Every other sign-in variable in a settings file refuses the turn.
 */
const BLANKABLE = /^(?:ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z0-9_]+)$/

/** Managed keys that run a program to compute more policy at startup, which no offline read can see. */
const POLICY_HELPER_KEYS = ['policyHelper', 'policyHelpers'] as const

/** What a key entry's turn starts with after its folder's settings are read (`claudeKeyTurnSettings`). */
export type ClaudeKeyTurnSettings = { settings?: Settings; refuse?: undefined } | { refuse: string; settings?: undefined }

/**
 * The flag-tier settings that keep a key entry on its key and its address in a folder whose
 * settings say otherwise, or why the turn cannot start there. Claude Code applies `env` and
 * `apiKeyHelper` from the folder's `.claude/settings.json` and `.claude/settings.local.json` after
 * Mousse sets the environment; its flag tier (the SDK's `settings`, `--settings`) ranks above
 * both, so a settings value there wins:
 * - an address is pinned to the entry's own (or Anthropic's);
 * - a bearer token, a subscription token or a provider route is blanked, and so is `apiKeyHelper`.
 * The key itself never goes in the flag tier (it would be on the command line), so settings that
 * set the key, the home, or any other credential refuse the turn. Managed policy outranks the flag
 * tier: any sign-in or route it sets refuses the turn too, rather than run on an account the entry
 * does not show. Policy Claude Code reads only with a claude.ai sign-in (`remote`) never applies
 * to a key entry. A policy helper (`policyHelper`, `policyHelpers`) computes managed settings only
 * when Claude Code starts, so nothing can show in advance what it sets: a turn under one is refused.
 */
export function claudeKeyTurnSettings(resolved: Pick<ResolvedSettings, 'sources'>, entry: { baseUrl?: string; label: string }): ClaudeKeyTurnSettings {
  const env: Record<string, string> = {}
  let apiKeyHelper = false
  for (const source of resolved.sources) {
    if (source.source === 'managed' && source.policyOrigin === 'remote') continue
    if (source.source === 'managed' && POLICY_HELPER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source.settings, key))) {
      const path = (source.settings as { policyHelper?: { path?: unknown } }).policyHelper?.path
      return { refuse: `Your organization's Claude Code policy runs a policy helper${typeof path === 'string' && path ? ` (${path})` : ''} that sets its settings when Claude Code starts, so Mousse cannot check that ${entry.label} would run on its API key. Use another provider, or ask your administrator.` }
    }
    const names = Object.keys(source.settings.env ?? {}).filter(isClaudeSignInVariable)
    const helper = typeof source.settings.apiKeyHelper === 'string' && source.settings.apiKeyHelper.trim() !== ''
    if (!names.length && !helper) continue
    const set = [...names, ...(helper ? ['apiKeyHelper'] : [])].join(', ')
    if (source.source !== 'project' && source.source !== 'local')
      return { refuse: `Your organization's Claude Code policy sets ${set}, so ${entry.label} cannot run on its API key here. Use another provider, or ask your administrator.` }
    const where = source.path ?? (source.source === 'local' ? '.claude/settings.local.json' : '.claude/settings.json')
    const fixed = names.filter((name) => name.toUpperCase() !== CLAUDE_BASE_URL_VARIABLE && !BLANKABLE.test(name.toUpperCase()))
    if (fixed.length)
      return { refuse: `This folder's Claude Code settings (${where}) set ${fixed.join(', ')}, so ${entry.label} cannot run on its API key here. Remove ${fixed.length > 1 ? 'them' : 'it'} there, or use another provider.` }
    for (const name of names) env[name] = name.toUpperCase() === CLAUDE_BASE_URL_VARIABLE ? (entry.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL) : ''
    if (helper) apiKeyHelper = true
  }
  if (!Object.keys(env).length && !apiKeyHelper) return {}
  return { settings: { ...(Object.keys(env).length ? { env } : {}), ...(apiKeyHelper ? { apiKeyHelper: '' } : {}) } }
}
