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
