import { afterEach, describe, expect, it, vi } from 'vitest'
import { interruptWithDeadline, loadWithDeadline, recoverActiveRun, SessionLoadTimeoutError } from '../../src/mms/harness/supervise'

const ref = { provider: 'acp', instanceId: 'acp:agent', model: 'm' }

describe('interruptWithDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('returns the native cancel when it settles in time', async () => {
    const terminate = vi.fn()
    expect(await interruptWithDeadline({ interrupt: async () => 'interrupted', terminate }, ref)).toBe('interrupted')
    expect(terminate).not.toHaveBeenCalled()
  })

  it('kills the process tree and forgets the session when the cancel misses its deadline', async () => {
    vi.useFakeTimers()
    const terminate = vi.fn()
    const forgetConversation = vi.fn()
    const result = interruptWithDeadline({ interrupt: () => new Promise(() => {}), terminate, forgetConversation }, ref, { threadId: 'thread-1' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('interrupted')
    expect(terminate).toHaveBeenCalledExactlyOnceWith(ref)
    expect(forgetConversation).toHaveBeenCalledExactlyOnceWith('thread-1')
  })

  it('kills at once when the cancel fails', async () => {
    const terminate = vi.fn()
    expect(await interruptWithDeadline({ interrupt: async () => { throw new Error('pipe closed') }, terminate }, ref)).toBe('interrupted')
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('leaves a runtime without terminate to its own cancel', async () => {
    vi.useFakeTimers()
    let settle!: (value: 'not_active') => void
    const result = interruptWithDeadline({ interrupt: () => new Promise((resolve) => { settle = resolve }) }, ref)
    await vi.advanceTimersByTimeAsync(20_000)
    settle('not_active')
    expect(await result).toBe('not_active')
  })
})

describe('loadWithDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('fails typed after 90 s and runs the timeout action once', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const result = loadWithDeadline('session-1', new Promise(() => {}), onTimeout)
    const failed = expect(result).rejects.toBeInstanceOf(SessionLoadTimeoutError)
    await vi.advanceTimersByTimeAsync(90_000)
    await failed
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('passes a load that finishes in time through', async () => {
    expect(await loadWithDeadline('session-1', Promise.resolve('ready'), () => { throw new Error('unused') })).toBe('ready')
  })
})

describe('recoverActiveRun', () => {
  const ownership = { nativeAgentId: 'agent-1', recordedRunIds: new Set(['run-a']) }

  it('cancels the thread’s own run once and sends the current message again', async () => {
    const cancelRun = vi.fn(async () => {})
    const resend = vi.fn(async () => 'sent')
    expect(await recoverActiveRun({ agentId: 'agent-1', runId: 'run-a' }, ownership, { cancelRun, resend })).toEqual({ recovered: true, value: 'sent' })
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith('run-a')
    expect(resend).toHaveBeenCalledOnce()
  })

  it.each([
    ['another agent', { agentId: 'agent-2', runId: 'run-a' }],
    ['a run Mousse did not record', { agentId: 'agent-1', runId: 'run-x' }],
    ['an unnamed run', { agentId: 'agent-1' }]
  ])('never touches %s', async (_name, conflict) => {
    const cancelRun = vi.fn(async () => {})
    const resend = vi.fn(async () => 'sent')
    expect(await recoverActiveRun(conflict, ownership, { cancelRun, resend })).toEqual({ recovered: false, reason: 'not_owned' })
    expect(cancelRun).not.toHaveBeenCalled()
    expect(resend).not.toHaveBeenCalled()
  })
})
