/**
 * PR 2 §5 "Connection inventory": every way a `pi:*` provider connects today keeps working on the
 * RPC engine. One row per provider pi-ai ships plus Mousse's own (`cursor`), so a provider added by
 * an upgrade fails here until it has a row.
 */
import { createHash } from 'node:crypto'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Api, Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { piCredentialSubject, piRpcProfileOptions, type PiProfileAuth } from '../../src/mms/harness/drivers/pi/profile'
import { piOwnProviderKeys } from '../../src/mms/harness/pi/envKeys'
import { piRuntimePaths } from '../../src/mms/harness/pi/launch'

type Method =
  /** Stored key → the native registration's `apiKey.resolve` (`/pi/catalog`, first request only). */
  | 'key'
  /** Stored key plus ids beside it → the ids reach the child's environment. */
  | 'key+env'
  /** The machine's cloud sign-in, inherited (Bedrock with the AWS single-attempt pins). */
  | 'ambient'
  /** pi-ai sign-in → stock `toAuth`, Mousse's broker refreshes. A stored key works too. */
  | 'oauth'
  /** Stays on the legacy loop (PR 4 / PR D). */
  | 'legacy'

const METHODS: Record<string, Method> = {
  'amazon-bedrock': 'ambient',
  'ant-ling': 'key',
  // Key only: a Claude subscription never runs on Pi.
  anthropic: 'key',
  'azure-openai-responses': 'key',
  baseten: 'key',
  cerebras: 'key',
  'cloudflare-ai-gateway': 'key+env',
  'cloudflare-workers-ai': 'key+env',
  cursor: 'legacy',
  deepseek: 'key',
  fireworks: 'key',
  'github-copilot': 'oauth',
  google: 'key',
  'google-vertex': 'ambient',
  groq: 'key',
  huggingface: 'key',
  'kimi-coding': 'oauth',
  minimax: 'key',
  'minimax-cn': 'key',
  mistral: 'key',
  moonshotai: 'key',
  'moonshotai-cn': 'key',
  nvidia: 'key',
  openai: 'key',
  'openai-codex': 'legacy',
  opencode: 'key',
  'opencode-go': 'key',
  openrouter: 'oauth',
  'qwen-token-plan': 'key',
  'qwen-token-plan-cn': 'key',
  'qwen-token-plan-individual': 'key',
  radius: 'oauth',
  together: 'key',
  'vercel-ai-gateway': 'key',
  xai: 'oauth',
  xiaomi: 'key',
  'xiaomi-token-plan-ams': 'key',
  'xiaomi-token-plan-cn': 'key',
  'xiaomi-token-plan-sgp': 'key',
  zai: 'key',
  'zai-coding-cn': 'key'
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const MODEL = (provider: string) => ({ id: `${provider}-model`, name: 'M', api: 'openai-completions', provider, baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }) as unknown as Model<Api>

function profile(credentials: Record<string, Record<string, unknown>>, env: NodeJS.ProcessEnv = {}) {
  const auth: PiProfileAuth = {
    has: (id) => Boolean(credentials[id]),
    storedApiKey: (id) => (credentials[id]?.type === 'api_key' ? (credentials[id].key as string) : undefined),
    models: { getModels: (id?: string) => (id ? [MODEL(id)] : []) },
    credentials: { get: (id: string) => credentials[id] as never }
  }
  return piRpcProfileOptions({ auth: () => auth, runtime: piRuntimePaths(process.platform === 'win32' ? 'C:\\mousse' : '/mousse'), env })!
}

describe('Pi connection methods', () => {
  it('has one row for every provider', () => {
    expect(Object.keys(METHODS).sort()).toEqual([...builtinProviders().map((provider) => provider.id), 'cursor'].sort())
  })

  it('routes each row to its engine', () => {
    const driver = piDriver({ client: () => { throw new Error('unused') }, rpc: profile({}) })
    for (const [id, method] of Object.entries(METHODS))
      expect(driver.engine?.(`pi:${id}`, undefined).effective, id).toBe(method === 'legacy' ? 'legacy' : 'rpc')
  })

  it('keeps pi-ai sign-in for the OAuth rows and only for them', () => {
    const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]))
    for (const [id, method] of Object.entries(METHODS)) {
      if (method === 'legacy' || id === 'anthropic') continue
      expect(Boolean(providers.get(id)?.auth.oauth), id).toBe(method === 'oauth')
    }
  })

  it('hands a stored key over through the catalogue, never a Claude subscription token', () => {
    const options = profile({ groq: { type: 'api_key', key: 'gsk-test' }, openrouter: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } })
    expect(options.apiKey?.('groq')).toBe('gsk-test')
    expect(options.apiKey?.('openrouter')).toBeUndefined()
    expect(options.catalog('groq')).toMatchObject({ provider: { id: 'groq', builtin: true, models: [{ id: 'groq-model' }] }, revision: 1 })
  })

  it('passes the ids stored beside a Cloudflare key into the child, not the key', () => {
    const options = profile({ 'cloudflare-ai-gateway': { type: 'api_key', key: 'cf-key', env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' } } })
    expect(options.credentialEnv?.('cloudflare-ai-gateway')).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' })
    expect(options.credentialEnv?.('groq')).toBeUndefined()
  })

  it('re-adds only the instance’s own environment key', () => {
    expect(piOwnProviderKeys('openrouter')).toEqual(['OPENROUTER_API_KEY'])
    expect(piOwnProviderKeys('anthropic')).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('moves the catalogue revision on only when the catalogue changed', () => {
    let listed = [MODEL('groq')]
    const auth: PiProfileAuth = { has: () => false, storedApiKey: () => undefined, models: { getModels: () => listed }, credentials: { get: () => undefined } }
    const options = piRpcProfileOptions({ auth: () => auth, runtime: piRuntimePaths(process.platform === 'win32' ? 'C:\\mousse' : '/mousse'), customModels: () => [{ id: 'mine', capabilities: { efforts: [], images: false } }] })!
    const first = options.catalog('groq')
    expect(first.provider.models.map((model) => model.id)).toEqual(['groq-model', 'mine'])
    expect(options.catalog('groq').revision).toBe(first.revision)
    listed = [MODEL('groq'), { ...MODEL('groq'), id: 'new' }]
    expect(options.catalog('groq').revision).toBe(first.revision + 1)
  })

  it('names each credential by a stable one-way subject', () => {
    expect(piCredentialSubject('groq', { type: 'api_key', key: 'k' }, {})).toBe(`apikey:${sha('k')}`)
    expect(piCredentialSubject('openrouter', undefined, { OPENROUTER_API_KEY: 'env-k' })).toBe(`apikey:${sha('env-k')}`)
    const jwt = (sub: string, exp: number) => `x.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.y`
    // A refresh (new access token, same subject) keeps the identity; another account changes it.
    const before = piCredentialSubject('github-copilot', { type: 'oauth', access: jwt('u1', 1) }, {})
    expect(before).toMatch(/^oauth:/)
    expect(piCredentialSubject('github-copilot', { type: 'oauth', access: jwt('u1', 2) }, {})).toBe(before)
    expect(piCredentialSubject('github-copilot', { type: 'oauth', access: jwt('u2', 1) }, {})).not.toBe(before)
    expect(piCredentialSubject('kimi-coding', { type: 'oauth', access: 'opaque', accountId: 'acct-1' }, {})).toMatch(/^oauth:/)
    expect(piCredentialSubject('kimi-coding', { type: 'oauth', access: 'opaque' }, {})).toBeUndefined()
    // Copilot's tokens are opaque: its GitHub token (kept by a refresh) names the account.
    const copilot = piCredentialSubject('github-copilot', { type: 'oauth', access: 'tid=1;proxy-ep=x', refresh: 'ghu_one' }, {})
    expect(copilot).toMatch(/^oauth:/)
    expect(piCredentialSubject('github-copilot', { type: 'oauth', access: 'tid=2;proxy-ep=x', refresh: 'ghu_one' }, {})).toBe(copilot)
    expect(piCredentialSubject('github-copilot', { type: 'oauth', access: 'tid=1;proxy-ep=x', refresh: 'ghu_two' }, {})).not.toBe(copilot)
    expect(piCredentialSubject('amazon-bedrock', undefined, { AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' })).toMatch(/^ambient:/)
    expect(piCredentialSubject('amazon-bedrock', undefined, {})).toBeUndefined()
    // Never the secret itself.
    expect(piCredentialSubject('groq', { type: 'api_key', key: 'secret-key' }, {})).not.toContain('secret-key')
  })
})
