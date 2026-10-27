import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CustomModel } from '../../../../shared/harness/types'
import { piInstanceId } from '../../../../shared/providerInstances'
import type { ProviderAuthService } from '../../../providers/ProviderAuthService'
import type { ToolRegistry } from '../../../run/mcp/appTools/registry'
import { customModelDefinition } from '../../catalog'
import type { PiEngineCatalog, PiMousseTool } from '../../pi/engine'
import { piRuntimePaths, type PiRuntimePaths } from '../../pi/launch'
import { PI_PROVIDER_ENV_KEYS } from '../../pi/envKeys'
import { oauthSubject, type PiOAuthSource } from '../../pi/oauthBroker'
import type { PiRpcDriverOptions } from './engines/rpc'

/**
 * The profile's inputs to the Pi RPC engine (PR 2 §5, "Connection inventory"): where the packaged
 * runtime is, each provider's full Mousse catalogue, its stored key and the ids stored beside it,
 * Mousse's tools with their class, and the stable subject of the credential an instance runs with.
 */

/** What the inputs read of `ProviderAuthService`. */
export type PiProfileAuth = Pick<ProviderAuthService, 'has' | 'storedApiKey'> & {
  models: Pick<ProviderAuthService['models'], 'getModels'>
  credentials: Pick<ProviderAuthService['credentials'], 'get'> & Partial<Pick<ProviderAuthService['credentials'], 'modify'>>
}

export interface PiProfileInputs {
  auth: () => PiProfileAuth | undefined
  /** The runtime Mousse ships; undefined when this build has none (every instance stays on the loop). */
  runtime: PiRuntimePaths | undefined
  /** The user's custom models of an instance (Settings → Providers → Models). */
  customModels?: (instanceId: string) => readonly CustomModel[]
  /** Mousse's app tools (the Mousse MCP server's registry). */
  registry?: () => Pick<ToolRegistry, 'listForThread'>
  /** Mousse's OAuth credentials for Pi's OAuth providers (`piOAuthBroker`). */
  oauth?: PiOAuthSource
  /** The process environment ambient credentials come from (test seam). */
  env?: NodeJS.ProcessEnv
}

/**
 * The packaged runtime beside the code that runs this (`out/<bundle>/…` under the app root, or
 * `app.asar` whose runtime is unpacked), or undefined when the build has none.
 */
export function findPiRuntime(from: string = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)): PiRuntimePaths | undefined {
  let dir = dirname(from)
  for (let depth = 0; depth < 6; depth += 1) {
    const paths = piRuntimePaths(dir.replace(/app\.asar\.unpacked$/, 'app.asar'))
    if (existsSync(paths.entry) && existsSync(paths.extension)) return paths
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Providers whose credential is the machine's own cloud sign-in (profile and region decide the account). */
const AMBIENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'amazon-bedrock': ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK'],
  'google-vertex': ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS']
})

/**
 * The stable subject of the credential `providerId` runs with, already one-way: `apikey:<hash>` for
 * a stored or own-environment key, `oauth:<hash>` of a claim a refresh keeps, `ambient:<hash>` of
 * the cloud profile and region (with none set, the default credential chain, one subject); undefined
 * when none can be established (the history is then handed over on every turn).
 */
export function piCredentialSubject(providerId: string, credential: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key) return `apikey:${sha256(credential.key)}`
  if (credential?.type === 'oauth') {
    const claim = oauthSubject(credential, providerId)
    return claim ? `oauth:${sha256(`${providerId}|${claim}`)}` : undefined
  }
  const ambient = AMBIENT[providerId]
  if (ambient) {
    return `ambient:${sha256(`${providerId}|${ambient.map((name) => env[name] ?? '').join('|')}`)}`
  }
  for (const name of PI_PROVIDER_ENV_KEYS[providerId] ?? []) {
    const value = env[name]
    if (value) return `apikey:${sha256(value)}`
  }
  return undefined
}

const BUILTIN_IDS = new Set(builtinProviders().map((provider) => provider.id))

/** The profile's `rpc` options for the `pi` driver, or undefined when this build ships no runtime. */
export function piRpcProfileOptions(inputs: PiProfileInputs): PiRpcDriverOptions | undefined {
  const runtime = inputs.runtime
  if (!runtime) return undefined
  // A catalogue's revision moves on whenever what it lists changes, so a warm process re-registers it.
  const revisions = new Map<string, { signature: string; revision: number }>()
  const credential = (providerId: string) => inputs.auth()?.credentials.get(providerId) as unknown as Record<string, unknown> | undefined
  return {
    runtime: () => runtime,
    catalog: (providerId): PiEngineCatalog => {
      const listed = inputs.auth()?.models.getModels(providerId) ?? []
      const template = listed[0]
      const custom = template
        ? (inputs.customModels?.(piInstanceId(providerId)) ?? []).filter((entry) => !listed.some((model) => model.id === entry.id)).map((entry) => customModelDefinition(template, entry))
        : []
      const models: Model<Api>[] = [...listed, ...custom]
      const signature = sha256(JSON.stringify(models.map((model) => [model.id, model.api, model.baseUrl, model.contextWindow, model.maxTokens, model.reasoning, model.input])))
      const previous = revisions.get(providerId)
      const revision = !previous ? 1 : previous.signature === signature ? previous.revision : previous.revision + 1
      revisions.set(providerId, { signature, revision })
      return { provider: { id: providerId, builtin: BUILTIN_IDS.has(providerId), models }, revision }
    },
    apiKey: (providerId) => {
      const auth = inputs.auth()
      // `has` refuses a Claude subscription token stored as an Anthropic key.
      return auth?.has(providerId) ? auth.storedApiKey(providerId) : undefined
    },
    credentialEnv: (providerId) => {
      const stored = credential(providerId)
      const env = stored?.type === 'api_key' ? stored.env : undefined
      if (!env || typeof env !== 'object') return undefined
      return Object.fromEntries(Object.entries(env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    },
    ...(inputs.oauth ? { oauth: inputs.oauth } : {}),
    identity: async (providerId) => {
      const env = inputs.env ?? process.env
      const subject = piCredentialSubject(providerId, credential(providerId), env)
      if (subject || credential(providerId)?.type !== 'oauth') return subject
      // A sign-in whose token names no account (an opaque or never-expiring token, and one stored
      // before Mousse minted ids) gets a credential id now; refreshes keep it (`FileCredentialStore`).
      await inputs.auth()?.credentials.modify?.(providerId, async (current) => {
        const stored = current as unknown as Record<string, unknown> | undefined
        return stored?.type === 'oauth' && !stored.credentialId ? ({ ...stored, credentialId: randomUUID() } as unknown as typeof current) : undefined
      })
      return piCredentialSubject(providerId, credential(providerId), env)
    },
    ...(inputs.registry
      ? {
          mousseTools: (threadId: string): PiMousseTool[] => inputs.registry!().listForThread(threadId).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            class: tool.class
          }))
        }
      : {})
  }
}
