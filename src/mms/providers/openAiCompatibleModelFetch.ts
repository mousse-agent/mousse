/**
 * Dynamic model listing for OpenAI-compatible `/v1/models` endpoints via pi-ai Models.refresh.
 * Merges remote IDs into the static catalog using a template model from the provider baseline.
 */
import type { Api, Model, Provider } from '@earendil-works/pi-ai'

const OPENAI_COMPAT_PROVIDER_IDS = new Set([
  'openai',
  'openrouter',
  'groq',
  'cerebras',
  'xai',
  'deepseek',
  'mistral',
  'together',
  'fireworks',
  'nvidia',
  'huggingface',
  'opencode',
  'opencode-go',
  'vercel-ai-gateway'
])

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  return `${trimmed}/models`
}

function humanizeModelId(id: string): string {
  const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return leaf
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function asModelTemplate(template: Model<Api>, id: string, name?: string): Model<Api> {
  return {
    ...template,
    id,
    name: name?.trim() || humanizeModelId(id)
  }
}

export async function fetchOpenAiCompatibleModelList(options: {
  baseUrl: string
  apiKey: string
  providerId: string
  template: Model<Api>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<Model<Api>[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) return [options.template]

  const response = await fetchImpl(modelsUrl(options.baseUrl), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json'
    },
    signal: options.signal
  })
  if (!response.ok) {
    throw new Error(`Model list HTTP ${response.status} for ${options.providerId}`)
  }
  const body = (await response.json()) as { data?: Array<{ id?: string; name?: string }> }
  const rows = Array.isArray(body.data) ? body.data : []
  const out: Model<Api>[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(asModelTemplate(options.template, id, typeof row.name === 'string' ? row.name : undefined))
  }
  return out.length > 0 ? out : [options.template]
}

/**
 * Attach `refreshModels` to OpenAI-compatible providers that lack one, so
 * `Models.refresh()` can pull live catalogs when credentials exist.
 */
export function enhanceProvidersWithOpenAiCompatibleFetch(providers: readonly Provider[]): void {
  for (const provider of providers) {
    if (!OPENAI_COMPAT_PROVIDER_IDS.has(provider.id)) continue
    if (provider.refreshModels) continue

    const baseline = (): Model<Api>[] => {
      try {
        return provider.getModels() as Model<Api>[]
      } catch {
        return []
      }
    }

    let dynamic: Model<Api>[] | undefined

    const originalGet = provider.getModels.bind(provider)
    provider.getModels = () => {
      if (dynamic && dynamic.length > 0) return dynamic
      return originalGet()
    }

    provider.refreshModels = async (context) => {
      const stored = await context.store.read()
      if (stored?.models?.length) {
        dynamic = stored.models.filter((m) => m.provider === provider.id) as Model<Api>[]
      }
      if (!context.allowNetwork || context.signal?.aborted) return

      const templates = baseline()
      const template = templates[0]
      if (!template?.baseUrl) return

      const apiKey =
        context.credential?.type === 'api_key'
          ? context.credential.key
          : context.credential?.type === 'oauth'
            ? context.credential.access
            : undefined
      if (!apiKey) return

      try {
        const refreshed = await fetchOpenAiCompatibleModelList({
          baseUrl: template.baseUrl,
          apiKey,
          providerId: provider.id,
          template,
          signal: context.signal
        })
        // Prefer remote list but keep any baseline models missing from the API
        // (some gateways omit legacy ids while still serving them).
        const byId = new Map(refreshed.map((m) => [m.id, m]))
        for (const model of templates) {
          if (!byId.has(model.id)) byId.set(model.id, model)
        }
        dynamic = Array.from(byId.values())
        await context.store.write({ models: dynamic, checkedAt: Date.now() })
      } catch {
        // Keep baseline / last stored catalog on network or auth failure.
      }
    }
  }
}
