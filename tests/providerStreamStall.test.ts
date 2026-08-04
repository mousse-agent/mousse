import { describe, expect, it, vi } from 'vitest'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream
} from '@earendil-works/pi-ai'
import {
  assertAssistantResponseSucceeded,
  consumeAssistantStream,
  ProviderStreamStallError
} from '../src/mms/orchestrator/LlmClient'
import {
  isConnectionFailure,
  retryConnectionFailures
} from '../src/mms/orchestrator/connectionRetry'

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
    expect(() => assertAssistantResponseSucceeded(failed)).toThrow(/Codex error/)
    expect(() =>
      assertAssistantResponseSucceeded({ ...failed, stopReason: 'aborted' })
    ).not.toThrow()
  })

  it('classifies a stall as retryable and bounds retries without replaying a successful attempt', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderStreamStallError(10))
      .mockResolvedValueOnce('recovered')
    const retries: number[] = []

    expect(isConnectionFailure(new ProviderStreamStallError(10))).toBe(true)
    await expect(
      retryConnectionFailures(operation, (attempt) => retries.push(attempt), {
        delayMs: 0,
        wait: async () => {}
      })
    ).resolves.toBe('recovered')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(retries).toEqual([1])
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
})
