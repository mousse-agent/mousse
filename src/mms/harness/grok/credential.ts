import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { GROK_API_KEY_VARIABLE, GROK_OVERRIDE_VARIABLES, GROK_OWN_VARIABLES } from './variables'

/**
 * The credential a Grok process would sign in with, read without starting Grok. Status, identity,
 * models and turns all read it, so they never disagree. In order:
 *
 * 1. `XAI_API_KEY` (the instance's own, or inherited in the user's home): an API key, whose
 *    subject is its HMAC.
 * 2. Anything else that changes how Grok signs in (`GROK_OVERRIDE_VARIABLES`, or an `[auth]`,
 *    `[grok_com_config]` or `[endpoints]` table in the home's or the system's config): unknown.
 *    Mousse cannot tell the account, so a thread's native session is never resumed.
 * 3. The home's `auth.json`: the signed-in account, whose subject is its `user_id`.
 */

export type GrokCredential =
  | { kind: 'api_key'; subject: string; key: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'account'; state: 'signed_in' | 'refreshing' | 'expired'; subject?: string; methodLabel: string }
  | { kind: 'none' }

/** Entries of `auth.json` are keyed by issuer and client id. */
export const GROK_AUTH_ISSUER = 'https://auth.x.ai::'

/** Config files Grok reads, in its home and in the system folder. */
export const GROK_CONFIG_FILES = ['config.toml', 'managed_config.toml', 'requirements.toml'] as const

/** TOML tables that point Grok at another sign-in or other endpoints. */
const OVERRIDE_TABLES = ['auth', 'grok_com_config', 'endpoints']

export function grokKeySubject(apiKey: string): string {
  return `apikey:${createHmac('sha256', 'mousse-grok-key').update(apiKey).digest('hex')}`
}

/** The home Grok uses with `env`: `GROK_HOME`, else `~/.grok`. */
export function grokHome(env: NodeJS.ProcessEnv): string {
  const home = env.GROK_HOME?.trim()
  return home && isAbsolute(home) ? home : join(homedir(), '.grok')
}

/** The system folder Grok reads managed config from. */
export function grokSystemDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === 'win32' ? join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'grok') : '/etc/grok'
}

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper && value?.trim()) return value.trim()
  return undefined
}

/** The override variables set in `env` (Mousse's own are not overrides). */
export function grokOverrides(env: NodeJS.ProcessEnv): string[] {
  const own = new Set(GROK_OWN_VARIABLES.map((name) => name.toUpperCase()))
  return Object.entries(env)
    .filter(([key, value]) => Boolean(value?.trim()) && !own.has(key.toUpperCase()) && GROK_OVERRIDE_VARIABLES.some((entry) => {
      const pattern = entry.toUpperCase()
      return pattern.endsWith('*') ? key.toUpperCase().startsWith(pattern.slice(0, -1)) : key.toUpperCase() === pattern
    }))
    .map(([key]) => key)
}

/** The override tables a TOML file declares (`[auth]`, `[endpoints.chat]`, or a top-level `auth = …`). */
export function overrideTables(toml: string): string[] {
  const found = new Set<string>()
  let topLevel = true
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = /^\[\[?\s*"?([A-Za-z0-9_-]+)"?\s*(?:[.\]])/.exec(line)
    if (header) {
      topLevel = false
      if (OVERRIDE_TABLES.includes(header[1])) found.add(header[1])
      continue
    }
    if (!topLevel) continue
    const key = /^"?([A-Za-z0-9_-]+)"?\s*[.=]/.exec(line)
    if (key && OVERRIDE_TABLES.includes(key[1])) found.add(key[1])
  }
  return [...found]
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export interface GrokCredentialInput {
  /** The environment the Grok process starts with (instance variables and secrets applied). */
  env: NodeJS.ProcessEnv
  /** The system config folder (default `grokSystemDir()`). */
  systemDir?: string
  now?: number
}

export function grokCredential(input: GrokCredentialInput): GrokCredential {
  const apiKey = variable(input.env, GROK_API_KEY_VARIABLE)
  if (apiKey) return { kind: 'api_key', subject: grokKeySubject(apiKey), key: apiKey }
  const overrides = grokOverrides(input.env)
  if (overrides.length) return { kind: 'unknown', reason: `${overrides.sort().join(', ')} ${overrides.length === 1 ? 'is' : 'are'} set` }
  const home = grokHome(input.env)
  for (const dir of [home, input.systemDir ?? grokSystemDir()]) {
    for (const file of GROK_CONFIG_FILES) {
      const text = readText(join(dir, file))
      const tables = text ? overrideTables(text) : []
      if (tables.length) return { kind: 'unknown', reason: `${join(dir, file)} sets [${tables.join('], [')}]` }
    }
  }
  const raw = readText(join(home, 'auth.json'))
  if (raw === undefined) return { kind: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unknown', reason: 'auth.json cannot be read' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unknown', reason: 'auth.json cannot be read' }
  const now = input.now ?? Date.now()
  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[0].startsWith(GROK_AUTH_ISSUER) && Boolean(entry[1]) && typeof entry[1] === 'object')
    .map(([, entry]) => {
      const expires = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : typeof entry.expires_at === 'number' ? entry.expires_at * (entry.expires_at < 1e12 ? 1000 : 1) : NaN
      const valid = Number.isFinite(expires) ? expires > now : typeof entry.key === 'string' && Boolean(entry.key)
      const refreshable = typeof entry.refresh_token === 'string' && Boolean(entry.refresh_token)
      const state: 'signed_in' | 'refreshing' | 'expired' = valid ? 'signed_in' : refreshable ? 'refreshing' : 'expired'
      return {
        state,
        ...(typeof entry.user_id === 'string' && entry.user_id ? { subject: entry.user_id } : {}),
        methodLabel: entry.auth_mode === 'api_key' ? 'API key' : 'Grok account'
      }
    })
  if (!entries.length) return { kind: 'none' }
  const rank = { signed_in: 0, refreshing: 1, expired: 2 }
  const best = entries.sort((a, b) => rank[a.state] - rank[b.state])[0]
  // Two accounts in one home: Grok's choice between them cannot be read.
  const accounts = new Set(entries.filter((entry) => entry.state !== 'expired').map((entry) => entry.subject))
  if (accounts.size > 1) return { kind: 'unknown', reason: 'auth.json holds more than one account' }
  return { kind: 'account', ...best }
}
