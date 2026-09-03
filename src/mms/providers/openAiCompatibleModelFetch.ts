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

interface RemoteModelRow {
  id: string
  name?: string
}

async function fetchRemoteModelRows(options: {
  baseUrl: string
  apiKey?: string
  providerId: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<RemoteModelRow[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) return []
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  const response = await fetchImpl(modelsUrl(options.baseUrl), {
    method: 'GET',
    headers,
    signal: options.signal
  })
  if (!response.ok) {
    throw new Error(`Model list HTTP ${response.status} for ${options.providerId}`)
  }
  const body = (await response.json()) as { data?: Array<{ id?: string; name?: string }> }
  const rows = Array.isArray(body.data) ? body.data : []
  const out: RemoteModelRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: typeof row.name === 'string' ? row.name : undefined })
  }
  return out
}

/**
 * Pick the baseline template whose API matches a new remote model id.
 * Multi-API gateways (OpenCode Zen/Go) serve claude/qwen via anthropic-messages,
 * gemini via google-generative-ai, gpt/grok/muse via openai-responses, and the
 * rest via openai-completions. Reusing the wrong API makes the model uncallable.
 */
function inferTemplateForModelId(
  id: string,
  templatesByApi: Map<string, Model<Api>>,
  fallback: Model<Api>
): Model<Api> {
  const lower = id.toLowerCase()
  const pick = (...apis: string[]): Model<Api> | undefined => {
    for (const api of apis) {
      const template = templatesByApi.get(api)
      if (template) return template
    }
    return undefined
  }
  if (
    lower.includes('claude') ||
    lower.includes('fable') ||
    lower.includes('qwen') ||
    lower.includes('anthropic')
  ) {
    return pick('anthropic-messages') ?? fallback
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    return pick('google-generative-ai') ?? fallback
  }
  if (
    lower.includes('gpt') ||
    lower.includes('grok') ||
    lower.includes('muse') ||
    lower.includes('spark') ||
    lower.includes('codex') ||
    lower.includes('luna') ||
    lower.includes('sol-') ||
    lower.includes('terra') ||
    /^(o\d|gpt|grok|muse)/.test(lower)
  ) {
    return pick('openai-responses') ?? fallback
  }
  return pick('openai-completions', 'openai-responses') ?? fallback
}

export async function fetchOpenAiCompatibleModelList(options: {
  baseUrl: string
  apiKey?: string
  providerId: string
  template: Model<Api>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<Model<Api>[]> {
  const rows = await fetchRemoteModelRows({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    providerId: options.providerId,
    signal: options.signal,
    fetchImpl: options.fetchImpl
  })
  const out = rows.map((row) => asModelTemplate(options.template, row.id, row.name))
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
      if (context.stored?.models?.length) {
        dynamic = context.stored.models.filter((model) => model.provider === provider.id) as Model<Api>[]
      }
      if (!context.allowNetwork || context.signal.aborted) return

      const templates = baseline()
      if (templates.length === 0) return

      const apiKey =
        context.credential?.type === 'api_key'
          ? context.credential.key
          : context.credential?.type === 'oauth'
            ? context.credential.access
            : undefined

      // Multi-API gateways (OpenCode Zen/Go) expose several baseUrls, e.g.
      // https://opencode.ai/zen (anthropic-messages) and
      // https://opencode.ai/zen/v1 (openai-*). Only the /v1 base serves
      // /v1/models (the other 404s), so try the most specific base first
      // instead of blindly using templates[0].
      const templatesByBaseUrl = new Map<string, Model<Api>[]>()
      for (const model of templates) {
        const baseUrl = model.baseUrl?.replace(/\/+$/, '')
        if (!baseUrl) continue
        const bucket = templatesByBaseUrl.get(baseUrl) ?? []
        bucket.push(model)
        templatesByBaseUrl.set(baseUrl, bucket)
      }
      const baseUrls = [...templatesByBaseUrl.keys()].sort((a, b) => {
        const aV1 = a.includes('/v1') ? 0 : 1
        const bV1 = b.includes('/v1') ? 0 : 1
        if (aV1 !== bV1) return aV1 - bV1
        return b.length - a.length
      })
      if (baseUrls.length === 0) return
      const fallbackTemplate = templates.find((model) => model.baseUrl?.includes('/v1')) ?? templates[0]!

      const templatesByApi = new Map<string, Model<Api>>()
      for (const model of templates) {
        if (model.api && !templatesByApi.has(model.api)) templatesByApi.set(model.api, model)
      }
      const baselineById = new Map(templates.map((model) => [model.id, model]))

      // Zen's /v1/models is public; attempt refresh even without a stored key
      // so the picker isn't stuck on the outdated static catalog. Authed
      // endpoints still send the bearer token when available.
      let rows: RemoteModelRow[] | undefined
      let lastError: unknown
      for (const baseUrl of baseUrls) {
        try {
          const fetched = await fetchRemoteModelRows({
            baseUrl,
            apiKey,
            providerId: provider.id,
            signal: context.signal
          })
          if (fetched.length > 0) {
            rows = fetched
            break
          }
        } catch (error) {
          lastError = error
        }
        if (context.signal.aborted) return
      }
      if (!rows) {
        if (lastError) {
          // Keep baseline / last stored catalog on network or auth failure.
        }
        return
      }

      try {
        const refreshed = rows.map((row) => {
          const baselineMatch = baselineById.get(row.id)
          // Reuse the baseline entry when the id is known so reasoning flags,
          // context windows, and the correct API (responses vs completions vs
          // anthropic-messages) are preserved.
          if (baselineMatch) return baselineMatch
          return asModelTemplate(inferTemplateForModelId(row.id, templatesByApi, fallbackTemplate), row.id, row.name)
        })
        // Prefer remote list but keep any baseline models missing from the API
        // (some gateways omit legacy ids while still serving them).
        const byId = new Map(refreshed.map((m) => [m.id, m]))
        for (const model of templates) {
          if (!byId.has(model.id)) byId.set(model.id, model)
        }
        dynamic = Array.from(byId.values())
        await context.publish({ persist: { models: dynamic, checkedAt: Date.now() } })
      } catch {
        // Keep baseline / last stored catalog on network or auth failure.
      }
    }
  }
}
