import { describe, expect, it, vi } from 'vitest'
import {
  ConnectionRetriesExhaustedError,
  retryConnectionFailures
} from '../src/mms/orchestrator/connectionRetry'

describe('connection retry state transitions', () => {
  it('records each of five retry transitions and then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('connected')
    const retries: number[] = []
    const wait = vi.fn(async () => {})

    await expect(
      retryConnectionFailures(operation, (attempt) => retries.push(attempt), { delayMs: 0, wait })
    ).resolves.toBe('connected')

    expect(retries).toEqual([1, 2])
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('retries transient Codex server errors that arrive with a request id', async () => {
    const codexError = new Error(
      'Codex error: An error occurred while processing your request. You can retry your request. Please include the request ID be0fccad-64fb-411a-885b-d79ba7239230.'
    )
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(codexError)
      .mockResolvedValue('recovered')
    const retries: number[] = []

    await expect(
      retryConnectionFailures(operation, (attempt) => retries.push(attempt), {
        delayMs: 0,
        wait: async () => {}
      })
    ).resolves.toBe('recovered')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(retries).toEqual([1])
  })

  it('retries provider WebSocket transport failures', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('WebSocket error'))
      .mockResolvedValue('reconnected')
    const retries: number[] = []

    await expect(retryConnectionFailures(operation, (attempt) => retries.push(attempt), {
      delayMs: 0,
      wait: async () => {}
    })).resolves.toBe('reconnected')

    expect(retries).toEqual([1])
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('stops after five retries and enters the exhausted state', async () => {
    const operation = vi.fn(async () => {
      throw new Error('network error')
    })
    const retries: number[] = []

    await expect(
      retryConnectionFailures(operation, (attempt) => retries.push(attempt), {
        delayMs: 0,
        wait: async () => {}
      })
    ).rejects.toBeInstanceOf(ConnectionRetriesExhaustedError)

    expect(retries).toEqual([1, 2, 3, 4, 5])
    expect(operation).toHaveBeenCalledTimes(6)
  })

  it('does not retry non-connection failures', async () => {
    const operation = vi.fn(async () => {
      throw new Error('Invalid API key')
    })
    const onRetry = vi.fn()

    await expect(retryConnectionFailures(operation, onRetry)).rejects.toThrow('Invalid API key')
    expect(onRetry).not.toHaveBeenCalled()
  })
})
