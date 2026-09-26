import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

it.each([false, true])('settles an admitted context read before trash while preserving writer fencing (writer=%s)', async (writer) => {
  const f = await lifecycleHarness()
  let release = () => {}
  let lease: ReturnType<typeof tryAcquireExecutionLease> = null
  let measurement: Promise<unknown> | undefined
  let trash: Promise<unknown> | undefined
  try {
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'context polling coordination' })
    const location = f.services.threads.getThreadDir(thread.id)
    writeFileSync(join(location, 'sole-copy.txt'), 'preserved during polling')
    await f.rpc.request('threads.trash', { threadId: thread.id })
    await f.rpc.request('threads.restore', { threadId: thread.id })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const context = vi.spyOn(f.services.orchestrator, 'getContextUsage').mockImplementation(async () => { await hold; return {} as never })
    const peer = await f.connect()
    measurement = peer.request('orchestrator.contextUsage', { threadId: thread.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:orchestrator.contextUsage']).toBe(1))
    if (writer) {
      lease = tryAcquireExecutionLease(location, { source: 'polling-qualification-writer' })
      expect(lease).not.toBeNull()
    }
    let settled = false
    trash = f.rpc.request('threads.trash', { threadId: thread.id }).finally(() => { settled = true })
    const outcome = trash.then(() => ({ ok: true, error: '' }), (error) => ({ ok: false, error: String(error) }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
    expect(readFileSync(join(location, 'sole-copy.txt'), 'utf8')).toBe('preserved during polling')
    release(); await measurement
    const result = await outcome
    context.mockRestore()
    if (writer) {
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/active|busy|lease|writer|owned/i)
      expect(existsSync(join(location, 'sole-copy.txt'))).toBe(true)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
    } else {
      expect(result).toEqual({ ok: true, error: '' })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(readFileSync(join(location, 'sole-copy.txt'), 'utf8')).toBe('preserved during polling')
    }
  } finally {
    release(); await measurement?.catch(() => {}); await trash?.catch(() => {})
    if (lease) releaseExecutionLeaseHandle(lease)
    vi.restoreAllMocks(); await f.close()
  }
})

it('keeps a context read that exceeds the settle bound fenced without moving task data', async () => {
  const f = await lifecycleHarness()
  let release = () => {}
  let measurement: Promise<unknown> | undefined
  try {
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'stalled context reader' })
    const location = f.services.threads.getThreadDir(thread.id)
    writeFileSync(join(location, 'sole-copy.txt'), 'still active')
    const hold = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(f.services.orchestrator, 'getContextUsage').mockImplementation(async () => { await hold; return {} as never })
    const peer = await f.connect()
    measurement = peer.request('orchestrator.contextUsage', { threadId: thread.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:orchestrator.contextUsage']).toBe(1))
    await expect(f.rpc.request('threads.trash', { threadId: thread.id })).rejects.toThrow(/profile requests are still active.*contextUsage/)
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
    expect(readFileSync(join(location, 'sole-copy.txt'), 'utf8')).toBe('still active')
  } finally {
    release(); await measurement?.catch(() => {}); vi.restoreAllMocks(); await f.close()
  }
})
