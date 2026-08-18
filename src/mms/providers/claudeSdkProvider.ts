/**
 * Claude models go through the official Anthropic/Claude SDK (`@anthropic-ai/sdk`):
 * live `models.list()`, and every Messages stream uses an SDK client.
 * pi-ai stays the orchestrator event/tool layer; it does not own the Anthropic catalog.
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  createProvider,
  type AnthropicOptions,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
  type ProviderAuth,
  type SimpleStreamOptions,
  type StreamOptions
} from '@earendil-works/pi-ai'
import {
  stream as streamClaudeMessages,
  streamSimple as streamClaudeMessagesSimple
} from '@earendil-works/pi-ai/api/anthropic-messages'

export const CLAUDE_PROVIDER_ID = 'anthropic'
const CLAUDE_BASE_URL = 'https://api.anthropic.com'

const DEFAULT_CLAUDE_MODEL: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  api: 'anthropic-messages',
  provider: CLAUDE_PROVIDER_ID,
  baseUrl: CLAUDE_BASE_URL,
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 1_000_000,
  maxTokens: 128_000
}

export function createClaudeSdkClient(input: { apiKey?: string; authToken?: string } = {}): Anthropic {
  if (input.authToken) {
    return new Anthropic({ authToken: input.authToken, baseURL: CLAUDE_BASE_URL })
  }
  return new Anthropic({ apiKey: input.apiKey, baseURL: CLAUDE_BASE_URL })
}

export function createClaudeSdkClientFromCredential(credential?: Credential): Anthropic | undefined {
  if (!credential) {
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (authToken) return createClaudeSdkClient({ authToken })
    if (apiKey) return createClaudeSdkClient({ apiKey })
    return undefined
  }
  if (credential.type === 'api_key' && credential.key) {
    return createClaudeSdkClientFromSecret(credential.key)
  }
  if (credential.type === 'oauth' && credential.access) {
    return createClaudeSdkClient({ authToken: credential.access })
  }
  return undefined
}

function createClaudeSdkClientFromSecret(secret: string): Anthropic {
  if (secret.startsWith('sk-ant-oat') || secret.startsWith('sk-ant-ort')) {
    return createClaudeSdkClient({ authToken: secret })
  }
  return createClaudeSdkClient({ apiKey: secret })
}

export function toClaudePiModels(
  infos: Array<{ id: string; display_name?: string }>,
  template: Model<'anthropic-messages'> = DEFAULT_CLAUDE_MODEL
): Model<'anthropic-messages'>[] {
  return infos.map((info) => ({
    ...template,
    id: info.id,
    name: info.display_name?.trim() || info.id,
    api: 'anthropic-messages',
    provider: CLAUDE_PROVIDER_ID,
    baseUrl: CLAUDE_BASE_URL
  }))
}

export async function fetchClaudeSdkModels(
  credential: Credential | undefined,
  template: Model<'anthropic-messages'> = DEFAULT_CLAUDE_MODEL,
  signal?: AbortSignal
): Promise<Model<'anthropic-messages'>[]> {
  const client = createClaudeSdkClientFromCredential(credential)
  if (!client) return []

  const infos: Array<{ id: string; display_name?: string }> = []
  const page = await client.models.list({ limit: 100 }, { signal })
  for await (const model of page) {
    if (!model.id) continue
    infos.push({ id: model.id, display_name: model.display_name })
  }
  return toClaudePiModels(infos, template)
}

function withClaudeSdkClient<T extends StreamOptions>(options?: T): T & AnthropicOptions {
  const next = { ...(options ?? {}) } as T & AnthropicOptions
  if (next.client) return next
  const headerAuth = authorizationToken(next.headers)
  const client = headerAuth
    ? createClaudeSdkClient({ authToken: headerAuth })
    : next.apiKey
      ? createClaudeSdkClientFromSecret(next.apiKey)
      : createClaudeSdkClientFromCredential()
  if (client) next.client = client
  return next
}

function authorizationToken(headers?: StreamOptions['headers']): string | undefined {
  if (!headers) return undefined
  const raw = headers.Authorization ?? headers.authorization
  if (typeof raw !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match?.[1]
}

export function createClaudeSdkProvider(
  baseline: readonly Model<'anthropic-messages'>[],
  auth: ProviderAuth
) {
  const template = baseline[0] ?? DEFAULT_CLAUDE_MODEL
  const models = baseline.length > 0 ? baseline : [DEFAULT_CLAUDE_MODEL]

  return createProvider({
    id: CLAUDE_PROVIDER_ID,
    name: 'Anthropic',
    baseUrl: CLAUDE_BASE_URL,
    auth,
    models,
    fetchModels: async (context) => {
      if (!context.allowNetwork) return models
      try {
        const listed = await fetchClaudeSdkModels(context.credential, template, context.signal)
        if (listed.length === 0) return models
        const byId = new Map(listed.map((model) => [model.id, model]))
        for (const model of models) {
          if (!byId.has(model.id)) byId.set(model.id, model)
        }
        return [...byId.values()]
      } catch {
        return models
      }
    },
    api: {
      stream: (model, context, options) =>
        streamClaudeMessages(
          model as Model<'anthropic-messages'>,
          context,
          withClaudeSdkClient(options as StreamOptions)
        ),
      streamSimple: (model, context, options) =>
        streamClaudeMessagesSimple(
          model as Model<'anthropic-messages'>,
          context,
          withClaudeSdkClient(options as SimpleStreamOptions)
        )
    }
  })
}

export async function registerClaudeSdkProvider(
  models: MutableModels,
  credentials: CredentialStore
): Promise<void> {
  const existing = models.getProvider(CLAUDE_PROVIDER_ID)
  if (!existing) return
  const baseline = existing.getModels() as readonly Model<'anthropic-messages'>[]
  const credential = await credentials.read(CLAUDE_PROVIDER_ID)
  let listed: Model<'anthropic-messages'>[] = []
  try {
    listed = await fetchClaudeSdkModels(credential, baseline[0] ?? DEFAULT_CLAUDE_MODEL)
  } catch {
    listed = []
  }
  models.setProvider(
    createClaudeSdkProvider(listed.length > 0 ? listed : baseline, existing.auth)
  )
}

export async function refreshClaudeSdkProvider(
  models: MutableModels,
  credentials: CredentialStore
): Promise<void> {
  await registerClaudeSdkProvider(models, credentials)
}
