import type { Api, Credential, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

const CODEX_PROVIDER_ID = 'openai-codex'
const FALLBACK_CLIENT_VERSION = '0.155.1'
const CODEX_VERSION_URL = 'https://registry.npmjs.org/@openai%2fcodex/latest'
const MODEL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const OPENAI_MODELS = new Map<string, Model<Api>>(
  getBuiltinModels('openai').map((model) => [model.id, model])
)

interface CodexModelInfo {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  supported_reasoning_levels?: unknown
  input_modalities?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

function thinkingLevelMap(info: CodexModelInfo): ThinkingLevelMap | undefined {
  if (!Array.isArray(info.supported_reasoning_levels)) return undefined
  const available = new Set(
    info.supported_reasoning_levels
      .map((level) => level && typeof level === 'object' ? level.effort : undefined)
      .filter((effort): effort is string => typeof effort === 'string')
  )
  const map: ThinkingLevelMap = { off: null }
  for (const effort of MODEL_EFFORTS) map[effort] = available.has(effort) ? effort : null
  return map
}

function toModel(info: CodexModelInfo, baseline: Map<string, Model<Api>>, fallback: Model<Api>): Model<Api> {
  const id = info.slug as string
  const known = baseline.get(id)
  const apiModel = OPENAI_MODELS.get(id)
  const template = known ?? apiModel ?? fallback
  const contextWindow = Number(info.context_window)
  const maxTokens = Number(info.max_output_tokens)
  const levels = thinkingLevelMap(info)
  const reasoning = levels
    ? Object.values(levels).some((level) => level !== null)
    : (known?.reasoning ?? apiModel?.reasoning ?? false)
  return {
    ...template,
    id,
    name: typeof info.display_name === 'string' && info.display_name.trim()
      ? info.display_name.trim()
      : id,
    provider: CODEX_PROVIDER_ID,
    api: 'openai-codex-responses',
    baseUrl: fallback.baseUrl,
    reasoning,
    // An unknown model has no trustworthy price in the bundled catalog.
    cost: known || apiModel ? template.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(levels ? { thinkingLevelMap: levels } : {}),
    ...(Array.isArray(info.input_modalities)
      ? { input: info.input_modalities.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image') }
      : {})
  }
}

/** The Codex catalog is version gated. Use the current published Codex client version. */
async function currentCodexVersion(fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetchImpl(CODEX_VERSION_URL, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)])
    })
    if (!response.ok) return FALLBACK_CLIENT_VERSION
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(body.version)
      ? body.version
      : FALLBACK_CLIENT_VERSION
  } catch {
    return FALLBACK_CLIENT_VERSION
  }
}

export async function fetchOpenAiCodexModels(options: {
  credential: Credential
  baseline: readonly Model<Api>[]
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<Model<Api>[]> {
  if (options.credential.type !== 'oauth' || !options.credential.access) return []
  const accountId = accountIdFromToken(options.credential.access)
  if (!accountId || options.baseline.length === 0) return []
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const clientVersion = await currentCodexVersion(fetchImpl, options.signal)
  const baseUrl = options.baseline[0]!.baseUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/codex/models?client_version=${encodeURIComponent(clientVersion)}`
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.credential.access}`,
      'chatgpt-account-id': accountId,
      originator: 'pi'
    },
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(8_000)])
  })
  if (!response.ok) throw new Error(`Codex model list HTTP ${response.status}`)
  const body = (await response.json()) as { models?: unknown }
  if (!Array.isArray(body.models)) return []
  const baseline = new Map(options.baseline.map((model) => [model.id, model]))
  const result = new Map<string, Model<Api>>()
  for (const row of body.models as CodexModelInfo[]) {
    if (!row || typeof row !== 'object' || row.visibility !== 'list') continue
    if (typeof row.slug !== 'string' || !/^[\w.-]{1,128}$/.test(row.slug)) continue
    result.set(row.slug, toModel(row, baseline, options.baseline[0]!))
  }
  return [...result.values()]
}

/** Add the account's live Codex catalog to pi-ai's bundled offline fallback. */
export function enhanceOpenAiCodexProvider(provider: Provider | undefined): void {
  if (!provider || provider.id !== CODEX_PROVIDER_ID || provider.refreshModels) return
  const bundled = provider.getModels() as Model<Api>[]
  let dynamic: Model<Api>[] | undefined
  provider.getModels = () => dynamic?.length ? dynamic : bundled
  provider.refreshModels = async (context) => {
    if (context.stored?.models?.length) {
      const stored = context.stored.models.filter((model) => model.provider === CODEX_PROVIDER_ID) as Model<Api>[]
      if (stored.length) dynamic = stored
    }
    if (!context.allowNetwork || !context.credential || context.signal.aborted) return
    try {
      const listed = await fetchOpenAiCodexModels({
        credential: context.credential,
        baseline: bundled,
        signal: context.signal
      })
      if (listed.length === 0 || context.signal.aborted) return
      await context.publish({ persist: { models: listed, checkedAt: Date.now() }, update: () => { dynamic = listed } })
    } catch {
      // Keep the last good catalog, or the bundled catalog while offline.
    }
  }
}
