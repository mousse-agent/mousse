import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import type { LifecyclePurgePreview } from '../src/shared/resourceLifecycle'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { archived } from './support/archived'

it.each([false, true])('drains browser polls and preserves the final fence for a late writer (writer=%s)', async (writer) => {
  const f = await lifecycleHarness()
  let release = () => {}, poll: Promise<unknown> | undefined, latePoll: Promise<unknown> | undefined, trash: Promise<unknown> | undefined
  let lease: ReturnType<typeof tryAcquireExecutionLease> = null
  try {
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'browser poll trash' })
    const location = f.services.threads.getThreadDir(thread.id)
    writeFileSync(join(location, 'preserved.txt'), 'only copy')
    const peer = await f.connect(f.alice.id, ['browser.viewer.v1'])
    const browser = f.services.platform.browser, status = browser.accessStatus()
    const hold = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
    poll = peer.request('browser.access.status', { profileId: f.alice.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
    let settled = false
    // The app's delete of an archived thread: its trash waits for the admitted polls.
    archived(f.services.threads, thread.id)
    trash = f.rpc.request('threads.delete', { threadId: thread.id }).finally(() => { settled = true })
    const outcome = trash.then(() => ({ ok: true, error: '' }), (error) => ({ ok: false, error: String(error) }))
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:threads.delete']).toBe(1))
    // Fresh short writes and completion traffic keep their ordinary admission;
    // they are included in the settle condition, never silently exempted.
    await expect(peer.request('threads.create', { name: 'short concurrent write' })).resolves.toHaveProperty('thread.id')
    latePoll = peer.request('browser.access.status', { profileId: f.alice.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(2))
    if (writer) { lease = tryAcquireExecutionLease(location, { source: 'late-polling-writer' }); expect(lease).not.toBeNull() }
    expect(settled).toBe(false)
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
    expect(readFileSync(join(location, 'preserved.txt'), 'utf8')).toBe('only copy')
    release(); await Promise.all([poll, latePoll])
    const result = await outcome
    if (writer) {
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/active|busy|lease|writer|owned/i)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(readFileSync(join(location, 'preserved.txt'), 'utf8')).toBe('only copy')
    } else {
      expect(result.ok).toBe(true)
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(location)).toBe(false)
    }
    await expect(peer.request('threads.create', { name: 'admission resumed' })).resolves.toHaveProperty('thread.id')
  } finally { release(); await poll?.catch(() => {}); await latePoll?.catch(() => {}); await trash?.catch(() => {}); if (lease) releaseExecutionLeaseHandle(lease); vi.restoreAllMocks(); await f.close() }
})

it('retains a stalled browser poll and task bytes after the drain deadline without disrupting other request admission', async () => {
  const f = await lifecycleHarness()
  let release = () => {}, poll: Promise<unknown> | undefined
  try {
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'stalled browser poll' })
    const location = f.services.threads.getThreadDir(thread.id)
    writeFileSync(join(location, 'preserved.txt'), 'only copy')
    const peer = await f.connect(f.alice.id, ['browser.viewer.v1'])
    const browser = f.services.platform.browser, status = browser.accessStatus()
    const hold = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
    poll = peer.request('browser.access.status', { profileId: f.alice.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
    archived(f.services.threads, thread.id)
    await expect(f.rpc.request('threads.delete', { threadId: thread.id })).rejects.toThrow(/profile requests are still active.*browser.access.status/)
    expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1)
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
    expect(readFileSync(join(location, 'preserved.txt'), 'utf8')).toBe('only copy')
    await expect(peer.request('threads.create', { name: 'resumed after rejection' })).resolves.toHaveProperty('thread.id')
  } finally { release(); await poll?.catch(() => {}); vi.restoreAllMocks(); await f.close() }
})

it('settles admitted browser polls before the delete that finishes a purge', async () => {
  const f = await lifecycleHarness()
  let release = () => {}, poll: Promise<unknown> | undefined, operation: Promise<unknown> | undefined
  try {
    const { thread } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'purge with GUI polling' })
    f.services.threads.setThreadSettled(thread.id, true)
    await f.services.trashThread(thread.id)
    const peer = await f.connect(f.alice.id, ['browser.viewer.v1'])
    const browser = f.services.platform.browser, status = browser.accessStatus()
    const hold = new Promise<void>((resolve) => { release = resolve })
    const mock = vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
    poll = peer.request('browser.access.status', { profileId: f.alice.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
    // The thread a delete left in the trash: Delete again finishes it, once the poll has settled.
    operation = f.rpc.request('threads.delete', { threadId: thread.id })
    await vi.waitFor(() => expect(f.services.getOwnedActivity()['rpc:threads.delete']).toBe(1))
    expect(existsSync(f.services.threads.lifecycleStore.require(thread.id).location)).toBe(true)
    release(); await poll
    await operation
    mock.mockRestore()
    expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
    await expect(peer.request('threads.list', {})).resolves.toHaveProperty('threads')
  } finally { release(); await poll?.catch(() => {}); await operation?.catch(() => {}); vi.restoreAllMocks(); await f.close() }
})
