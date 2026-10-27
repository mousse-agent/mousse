import type { ModelCapabilities } from '../../../shared/harness/types'
import { ChatGptAuthError, MESSAGES, transient } from './errors'
import { getJson, isRecord, retryAt } from './http'

/**
 * The models a ChatGPT plan may use: `GET /models` with the plan's access token. Only entries with
 * `visibility: 'list'` are kept, in the server's order. The optional fields are read leniently.
 */

export interface ChatGptModel {
  id: string
  label: string
  capabilities: ModelCapabilities
}

const MODELS_TIMEOUT_MS = 15_000
const SLUG = /^[\w.-]{1,128}$/
const EFFORT = /^[\w-]{1,32}$/

function efforts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const found = value
    .map((level) => (isRecord(level) ? level.effort : undefined))
    .filter((effort): effort is string => typeof effort === 'string' && EFFORT.test(effort))
  return [...new Set(found)]
}

function contextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function label(value: unknown, slug: string): string {
  if (typeof value !== 'string') return slug
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 128 ? trimmed : slug
}

/** Parses a models response. Unusable entries are skipped; a body without `models[]` is an error. */
export function parseChatGptModels(body: unknown): ChatGptModel[] {
  if (!isRecord(body) || !Array.isArray(body.models)) throw new ChatGptAuthError('protocol', 'invalid_response', MESSAGES.modelsFailed)
  const seen = new Set<string>()
  const models: ChatGptModel[] = []
  for (const entry of body.models) {
    if (!isRecord(entry) || entry.visibility !== 'list' || typeof entry.slug !== 'string' || !SLUG.test(entry.slug)) continue
    if (seen.has(entry.slug)) continue
    seen.add(entry.slug)
    const window = contextWindow(entry.context_window)
    models.push({
      id: entry.slug,
      label: label(entry.display_name, entry.slug),
      capabilities: {
        efforts: efforts(entry.supported_reasoning_levels),
        images: Array.isArray(entry.input_modalities) && entry.input_modalities.includes('image'),
        ...(window ? { contextWindow: window } : {})
      }
    })
  }
  return models
}

/** Lists the plan's models. A 401 fails `auth_expired` so the caller rechecks the sign-in. */
export async function fetchChatGptModels(apiBaseUrl: string, accessToken: string, signal?: AbortSignal): Promise<ChatGptModel[]> {
  let response
  try {
    response = await getJson(`${apiBaseUrl.replace(/\/+$/, '')}/models`, {
      timeoutMs: MODELS_TIMEOUT_MS,
      headers: { authorization: `Bearer ${accessToken}` },
      signal
    })
  } catch {
    if (signal?.aborted) throw new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
    throw transient(MESSAGES.modelsFailed)
  }
  if (response.status === 401) throw new ChatGptAuthError('auth_expired', 'unauthorized', MESSAGES.modelsUnauthorized)
  if (response.status === 429 || response.status >= 500) throw transient(MESSAGES.modelsFailed, response.status, retryAt(response.retryAfter))
  if (!response.ok) throw new ChatGptAuthError('protocol', 'invalid_response', MESSAGES.modelsFailed)
  return parseChatGptModels(response.body)
}
