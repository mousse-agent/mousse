import { describe, expect, it } from 'vitest'
import { retryContextOverflowOnce } from '../src/mms/orchestrator/OrchestratorService'

describe('context overflow recovery', () => {
  it('compacts and retries exactly once', async () => {
    let calls = 0
    let compactions = 0
    await expect(retryContextOverflowOnce(async () => {
      calls += 1
      throw new Error('maximum context length exceeded')
    }, () => {
      compactions += 1
      return true
    })).rejects.toThrow('maximum context length')
    expect(calls).toBe(2)
    expect(compactions).toBe(1)
  })

  it('does not compact unrelated failures', async () => {
    let compactions = 0
    await expect(retryContextOverflowOnce(async () => {
      throw new Error('authentication failed')
    }, () => {
      compactions += 1
      return true
    })).rejects.toThrow('authentication failed')
    expect(compactions).toBe(0)
  })
})
