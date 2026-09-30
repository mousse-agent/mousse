import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceLifecycleError } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { LifecyclePurgePreview } from '../src/shared/resourceLifecycle'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

afterEach(() => vi.restoreAllMocks())

describe('resource error boundary and frozen purge recovery', () => {
  it('preserves explicit lifecycle error codes and classifications across the real daemon socket', async () => {
    const f = await lifecycleHarness()
    try {
      const client = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const dispatch = f.main.domains.dispatch.bind(f.main.domains)
      let failure: ResourceLifecycleError
      vi.spyOn(f.main.domains, 'dispatch').mockImplementation((context, method, params) => {
        if (method === 'integrations.snapshot') throw failure
        return dispatch(context, method, params)
      })
      for (const [code, category] of [
        ['busy', 'conflict'], ['stale', 'conflict'], ['unavailable', 'unavailable'],
        ['ambiguous', 'internal'], ['unsupported', 'unsupported']
      ] as const) {
        failure = new ResourceLifecycleError(code, `Fixture lifecycle ${code}.`)
        await expect(client.request('integrations.snapshot', {})).rejects.toMatchObject({
          code, message: `Fixture lifecycle ${code}.`, errorInfo: { category, retryable: false }
        })
      }
    } finally { await f.close() }
  })

  it('keeps a native sharing failure pending and retries the same frozen ledger without exposing its raw path', async () => {
    const f = await lifecycleHarness()
    try {
      const client = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY])
      const { thread } = await client.request<{ thread: Thread }>('threads.create', { name: 'Controlled busy resource' })
      const directory = f.services.threads.getThreadDir(thread.id)
      mkdirSync(join(directory, 'owned'), { recursive: true })
      const bytes = Buffer.from([0, 255, 21, 4])
      writeFileSync(join(directory, 'owned', 'payload.bin'), bytes)
      await client.request('threads.trash', { threadId: thread.id })
      const record = f.services.threads.lifecycleStore.require(thread.id)
      const path = join(record.location, 'owned', 'payload.bin')
      const { preview } = await client.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
      expect(preview.blockers).toEqual([])
      const raw = "EBUSY: sharing violation at '/Users/privateFixture/secret-resource.bin'"
      // Only this disposable service's first physical-removal step is injected.
      // The actual purge ownership, ledger, protocol and subsequent removal run.
      const remove = vi.spyOn(f.services.lifecycle.cleanup as unknown as { remove: (...args: unknown[]) => Promise<void> }, 'remove')
        .mockRejectedValueOnce(Object.assign(new Error(raw), { code: 'EBUSY' }))
      const failure = await client.request('threads.purge', { threadId: thread.id, operationId: 'controlled-busy-purge',
        expectedGeneration: preview.generation, previewDigest: preview.digest }).catch((error) => error)
      expect(failure).toMatchObject({ code: 'resource_purge_io_error',
        errorInfo: { category: 'conflict', retryable: false }, details: { code: 'EBUSY' } })
      expect(failure.message).toMatch(/locked|permission/)
      expect(JSON.stringify(failure)).not.toMatch(/privateFixture|secret-resource|sharing violation/)
      const pending = f.services.threads.lifecycleStore.require(thread.id)
      expect(pending.state).toBe('purge-started')
      expect(pending.purge?.completedAt).toBeUndefined()
      expect(pending.purge?.items.every((item) => item.status === 'pending')).toBe(true)
      expect(pending.purge?.error).toBe(failure.message)
      expect(pending.blockedReason).toBe(failure.message)
      expect(JSON.stringify(pending)).not.toMatch(/privateFixture|secret-resource|sharing violation/)
      expect(readFileSync(path)).toEqual(bytes)
      await expect(client.request('threads.restore', { threadId: thread.id })).rejects.toMatchObject({
        code: 'unavailable', message: 'Cannot restore a purge-started task', errorInfo: { category: 'unavailable', retryable: false }
      })
      await client.request('threads.purge', { threadId: thread.id, operationId: 'controlled-busy-purge' })
      const complete = f.services.threads.lifecycleStore.require(thread.id)
      expect(complete.state).toBe('purged')
      expect(complete.purge).toMatchObject({ operationId: pending.purge!.operationId, digest: pending.purge!.digest,
        startedAt: pending.purge!.startedAt, ownedTaskIds: pending.purge!.ownedTaskIds, completedAt: expect.any(String) })
      expect(complete.purge!.error).toBeUndefined()
      expect(complete.blockedReason).toBeUndefined()
      expect(existsSync(record.location)).toBe(false)
      expect(remove).toHaveBeenCalledTimes(preview.items.length + 1)
    } finally { await f.close() }
  })
})
