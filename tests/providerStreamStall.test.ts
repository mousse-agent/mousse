import { describe, expect, it, vi } from 'vitest'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream
} from '@earendil-works/pi-ai'
import {
  assertAssistantResponseSucceeded,
  consumeAssistantStream,
  DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
  ProviderStreamStallError,
  resolveStreamInactivityTimeout
} from '../src/mms/harness/drivers/pi/stream'

const resultMessage: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  api: 'openai-responses',
  provider: 'xai',
  model: 'grok-4.5',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: Date.now()
}

function streamFromNext(
  next: () => Promise<IteratorResult<AssistantMessageEvent>>
): AssistantMessageEventStream {
  return {
    [Symbol.asyncIterator]: () => ({ next }),
    result: async () => resultMessage
  } as unknown as AssistantMessageEventStream
}

describe('provider stream inactivity protection', () => {
  it('turns provider error messages into thrown failures before they can be accepted', () => {
    const failed: AssistantMessage = {
      ...resultMessage,
      content: [],
      stopReason: 'error',
      errorMessage:
        'Codex error: An error occurred while processing your request. You can retry your request. Please include the request ID request-123.'
    }
    expect(() => assertAssistantResponseSucceeded(failed)).toThrow(/temporarily unavailable/)
    try { assertAssistantResponseSucceeded(failed) } catch (error) {
      expect(error).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
    }
    expect(() =>
      assertAssistantResponseSucceeded({ ...failed, stopReason: 'aborted' })
    ).not.toThrow()
  })

  it('fails a silent stream with a retryable connection timeout', async () => {
    const onTimeout = vi.fn()
    const stream = streamFromNext(() => new Promise(() => {}))

    await expect(
      consumeAssistantStream(stream, {}, { inactivityTimeoutMs: 10, onTimeout })
    ).rejects.toBeInstanceOf(ProviderStreamStallError)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('allows delayed events and resets the inactivity window after each event', async () => {
    let index = 0
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: resultMessage },
      { type: 'done', reason: 'stop', message: resultMessage }
    ]
    const stream = streamFromNext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8))
      const event = events[index++]
      return event ? { done: false, value: event } : { done: true, value: undefined }
    })

    await expect(
      consumeAssistantStream(stream, {}, { inactivityTimeoutMs: 20 })
    ).resolves.toBe(resultMessage)
  })

  it('aborts immediately even when the provider iterator never settles', async () => {
    const abort = new AbortController()
    const stream = streamFromNext(() => new Promise(() => {}))
    const pending = consumeAssistantStream(stream, {}, {
      inactivityTimeoutMs: 10_000,
      signal: abort.signal
    })

    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds stream silence for every provider by default (not just xAI)', () => {
    // A dead connection must surface as a retryable stall instead of spinning
    // forever: concurrent turns on other providers used to hang with Stop as
    // the only way out.
    expect(DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS).toBe(180_000)
    expect(resolveStreamInactivityTimeout(undefined)).toBe(
      DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS
    )
  })

  it('respects explicit overrides including 0 to disable the stall bound', () => {
    expect(resolveStreamInactivityTimeout(5_000)).toBe(5_000)
    expect(resolveStreamInactivityTimeout(0)).toBe(0)
  })
})
