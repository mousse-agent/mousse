import { createHash } from 'crypto'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ThinkingLevel
} from '@earendil-works/pi-ai'
import { normalizeProviderError, type ProviderFailureResponse } from '../../../orchestrator/providerErrors'
import type { LlmTextEventHandler, LlmThinkingEventHandler } from '../../turnEvents'

/**
 * Reading one pi-ai provider stream: request options, the inactivity bound, the text and thinking
 * events it reports, and the check that the finished reply did not fail.
 */

export function assertAssistantResponseSucceeded(message: AssistantMessage, response?: ProviderFailureResponse): void {
  // Aborted streams may still carry partial text plus an errorMessage.
  if (message.errorMessage && message.stopReason !== 'aborted') {
    throw normalizeProviderError(message.errorMessage, message.provider, response)
  }
}

export function getReasoningStreamOptions(
  modelApi: string,
  reasoning: ThinkingLevel | 'off',
  signal?: AbortSignal,
  sessionId?: string,
  providerId?: string
) {
  const cacheOptions = sessionId ? { sessionId } : {}
  // OpenCode Go requires this exact header on every request. The generic Pi
  // adapters use sessionId for prompt caching, but translate it into
  // API-specific affinity headers that Console Go does not accept.
  const providerOptions = providerId === 'opencode-go' && sessionId
    ? {
        transformHeaders: (headers: Record<string, string | null>) => ({
          ...headers,
          'user-agent': 'mousse/0.1.1',
          'x-opencode-session': sessionId
        })
      }
    : {}
  return {
    reasoning,
    signal,
    ...cacheOptions,
    ...providerOptions
  }
}

/**
 * Produces a provider-safe prompt-cache affinity key without exposing a thread
 * identifier to providers. Each thread (including an isolated subagent) gets
 * an independent key; all requests in that thread retain the same key.
 */
export function getCacheSessionId(threadId: string | undefined): string | undefined {
  const normalized = threadId?.trim()
  if (!normalized) return undefined
  return `mousse-${createHash('sha256').update(normalized).digest('hex').slice(0, 48)}`
}

/**
 * Default silence budget between provider stream events. A connection that goes
 * quiet for this long is treated as a retryable stall (ProviderStreamStallError)
 * instead of spinning forever — previously only xAI had a bound, so any other
 * provider could hang every concurrent turn on the same network blip with Stop
 * as the only way out.
 */
export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 180_000

/**
 * Resolve the effective per-stream inactivity timeout. An explicit override
 * (including 0 to disable) always wins; otherwise every provider gets the
 * bounded default.
 */
export function resolveStreamInactivityTimeout(
  overrideMs?: number
): number | undefined {
  if (overrideMs !== undefined) return overrideMs
  return DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS
}

export class ProviderStreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider connection timed out after ${timeoutMs}ms without a stream event`)
    this.name = 'ProviderStreamStallError'
  }
}

async function nextStreamEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  onTimeout?: () => void
): Promise<IteratorResult<AssistantMessageEvent>> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return iterator.next()

  return new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
    let settled = false
    const finish = (
      result?: IteratorResult<AssistantMessageEvent>,
      error?: unknown
    ): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result!)
    }
    const onAbort = (): void => finish(undefined, new DOMException('Aborted', 'AbortError'))
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          finish(undefined, new ProviderStreamStallError(timeoutMs))
          onTimeout?.()
        }, timeoutMs)
      : undefined
    signal?.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(
      (result) => finish(result),
      (error) => finish(undefined, error)
    )
  })
}

export async function consumeAssistantStream(
  stream: AssistantMessageEventStream,
  handlers: {
    onThinking?: LlmThinkingEventHandler
    onText?: LlmTextEventHandler
  } = {},
  options: {
    inactivityTimeoutMs?: number
    signal?: AbortSignal
    onTimeout?: () => void
    onProgress?: () => void
  } = {}
): Promise<AssistantMessage> {
  const thinkingContentRef = { current: '' }
  const textContentByIndex = new Map<number, string>()
  const iterator = stream[Symbol.asyncIterator]()

  for (;;) {
    const next = await nextStreamEvent(
      iterator,
      options.inactivityTimeoutMs,
      options.signal,
      options.onTimeout
    )
    if (next.done) break
    const event = next.value
    if (/^(?:text_|thinking_|toolcall_)/.test(event.type)) options.onProgress?.()
    if ((event.type === 'error' && event.error.content.length > 0) || (event.type === 'done' && event.message.content.length > 0)) options.onProgress?.()
    handleThinkingStreamEvent(event, handlers.onThinking, thinkingContentRef)
    handleTextStreamEvent(event, handlers.onText, textContentByIndex)
  }

  const result = await stream.result()
  if (result.content.length > 0) options.onProgress?.()
  return result
}

function handleThinkingStreamEvent(
  event: AssistantMessageEvent,
  onThinking: LlmThinkingEventHandler | undefined,
  thinkingContentRef: { current: string }
): void {
  if (!onThinking) return

  if (event.type === 'thinking_start') {
    thinkingContentRef.current = ''
    onThinking({ phase: 'start', content: '' })
    return
  }

  if (event.type === 'thinking_delta') {
    thinkingContentRef.current += event.delta
    onThinking({ phase: 'delta', content: thinkingContentRef.current })
    return
  }

  if (event.type === 'thinking_end') {
    thinkingContentRef.current = event.content
    onThinking({ phase: 'complete', content: event.content })
  }
}

export function handleTextStreamEvent(
  event: AssistantMessageEvent,
  onText: LlmTextEventHandler | undefined,
  textContentByIndex: Map<number, string>
): void {
  if (!onText) return

  if (event.type === 'text_start') {
    textContentByIndex.set(event.contentIndex, '')
    onText({ phase: 'start', content: '', contentIndex: event.contentIndex })
    return
  }

  if (event.type === 'text_delta') {
    if (!textContentByIndex.has(event.contentIndex)) {
      textContentByIndex.set(event.contentIndex, '')
      onText({ phase: 'start', content: '', contentIndex: event.contentIndex })
    }
    const content = `${textContentByIndex.get(event.contentIndex) ?? ''}${event.delta}`
    textContentByIndex.set(event.contentIndex, content)
    onText({ phase: 'delta', content, contentIndex: event.contentIndex })
    return
  }

  if (event.type === 'text_end') {
    const content = event.content ?? textContentByIndex.get(event.contentIndex) ?? ''
    textContentByIndex.set(event.contentIndex, content)
    onText({ phase: 'complete', content, contentIndex: event.contentIndex })
  }
}
