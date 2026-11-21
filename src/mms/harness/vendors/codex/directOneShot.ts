import type { Model } from '@earendil-works/pi-ai'
import { stream as codexResponsesStream } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { OneShotSpec } from '../../driver'
import { assertAssistantResponseSucceeded, consumeAssistantStream } from '../../drivers/pi/stream'

/** The ChatGPT backend Codex itself answers a ChatGPT sign-in from, on OpenAI's own model provider. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

/** pi-ai's Codex Responses transport; tests substitute it. */
export type CodexDirectStream = typeof codexResponsesStream

/**
 * A one-shot as one direct request with no tools to the ChatGPT backend, for a Codex instance on
 * OpenAI's own provider signed in with ChatGPT. An app-server turn cannot be used for a model with
 * subagent tools (`codexOneShotRunsOn`); a plain request offers no tool at all, whatever the model.
 *
 * `token` is the access token Codex itself holds (`getAuthStatus`, never refreshed by Mousse); it is
 * only sent as the request's credential, never kept, logged or written. One attempt over HTTP (no
 * WebSocket fallback, no retry), stopped by `signal`.
 */
export async function runCodexDirectOneShot(
  request: { model: string; effort?: string; token: string; spec: OneShotSpec },
  signal: AbortSignal,
  send: CodexDirectStream = codexResponsesStream
): Promise<{ text: string }> {
  const { spec } = request
  const model: Model<'openai-codex-responses'> = {
    id: request.model,
    name: request.model,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CHATGPT_CODEX_BASE_URL,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // No reasoning field unless an effort is named: the backend then uses the model's own default.
    reasoning: false,
    contextWindow: 0,
    maxTokens: 0
  }
  // The system text and one user message; no tools are declared.
  const context = normalizeContext({
    systemPrompt: spec.system,
    messages: [{ role: 'user', content: spec.prompt, timestamp: Date.now() }]
  })
  spec.onActivity()
  const events = send(model, context, {
    apiKey: request.token,
    signal,
    transport: 'sse',
    maxRetries: 0,
    cacheRetention: 'none',
    ...(request.effort ? { reasoningEffort: request.effort as never } : {})
  })
  const message = await consumeAssistantStream(events, {}, { signal, onProgress: () => spec.onActivity() })
  signal.throwIfAborted()
  assertAssistantResponseSucceeded(message)
  return { text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') }
}
