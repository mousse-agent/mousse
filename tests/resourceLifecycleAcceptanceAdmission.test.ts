import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import {
  acquireExecutionLease, releaseExecutionLeaseHandle, waitAcquireExecutionLease,
  withQueueMutationLock, withThreadDataMutationLock, type ThreadLeaseHandle
} from '../src/mms/queue/ThreadExecutionLease'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

describe('Phase 1 stale producer acceptance', () => {
  it.each([false, true])('rejects an already queued lease across trash (restore=%s) without recreating the old path', async (restore) => {
    const f = await lifecycleHarness()
    let lease: ThreadLeaseHandle | undefined
    let queuedLease: ThreadLeaseHandle | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'queued path producer' })
      const path = f.services.threads.getThreadDir(thread.id)
      lease = acquireExecutionLease(path)
      // Freeze only retry timers; framed socket requests and filesystem operations
      // remain real. This forces the next acquisition after the complete ABA move.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // The first synchronous acquisition observes a held lease. Its next attempt
      // must retain the original generation even if restore reuses the same path.
      const pending = waitAcquireExecutionLease(path, { retryDelayMs: 250, maxAttempts: 3 })
        .then((handle) => { queuedLease = handle; return { acquired: true, error: '' } },
          (error: Error) => ({ acquired: false, error: error.message }))
      releaseExecutionLeaseHandle(lease); lease = undefined
      await f.rpc.request('threads.trash', { threadId: thread.id })
      expect(existsSync(path)).toBe(false)
      if (restore) await f.rpc.request('threads.restore', { threadId: thread.id })
      await vi.advanceTimersByTimeAsync(250)
      const result = await pending
      expect(result.acquired, result.error || 'stale queued producer acquired ownership').toBe(false)
      expect(result.error).toMatch(/stale|generation|lifecycle|trash|admission/i)
      expect(existsSync(path)).toBe(restore)
      if (restore) {
        const fresh = acquireExecutionLease(path)
        releaseExecutionLeaseHandle(fresh)
      }
    } finally {
      vi.useRealTimers()
      if (lease) releaseExecutionLeaseHandle(lease)
      if (queuedLease) releaseExecutionLeaseHandle(queuedLease)
      await f.close()
    }
  })

  it('fences cached data and queue lock paths before callbacks can recreate trashed data', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'stale callbacks' })
      const path = f.services.threads.getThreadDir(thread.id)
      await f.rpc.request('threads.trash', { threadId: thread.id })
      let called = false
      const staleWrite = () => { called = true; writeFileSync(join(path, 'late-output.txt'), 'late effect') }
      expect(() => withThreadDataMutationLock(path, staleWrite)).toThrow()
      expect(() => withQueueMutationLock(path, staleWrite)).toThrow()
      expect(called).toBe(false)
      expect(existsSync(path)).toBe(false)
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(existsSync(join(path, 'late-output.txt'))).toBe(false)
    } finally { await f.close() }
  })
})
