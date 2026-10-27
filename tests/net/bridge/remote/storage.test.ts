import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_REMOTE_METHODS, validateRemoteParams } from '../../../../src/mms/bridge/remote'
import { executeBridgeHubLocal, validateBridgeHubLocal } from '../../../../src/mms/bridge/hub/local'
import { HUB_METHODS } from '../../../../src/mms/bridge/hub/validation'
import { NetError, newId } from '../../../../src/shared/net'
import type { StorageUsageSnapshot } from '../../../../src/shared/storage'
import { cleanup, fixture } from '../hub/fixture'

afterEach(cleanup)

/** Every string anywhere in a value. */
function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, found)
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { found.push(key); strings(item, found) }
  return found
}

describe('remote storage.usage', () => {
  it('is a read-only method that takes no parameters', () => {
    expect(BRIDGE_REMOTE_METHODS['storage.usage']).toEqual({ capability: 'read', mutating: false })
    expect(HUB_METHODS['storage.usage']).toEqual({ capability: 'read', mutating: false })
    expect(() => validateRemoteParams('storage.usage', {})).not.toThrow()
    // A remote caller cannot force a rescan of another computer's disk, or name anything else.
    for (const bad of [{ refresh: true }, { refresh: false }, { path: '/etc' }, { projectId: 'p' }, null, [], 'refresh'])
      expect(() => validateRemoteParams('storage.usage', bad)).toThrow()
    const target = newId('node')
    expect(validateBridgeHubLocal('bridge.hub.storage', { target })).toEqual({ target })
    expect(() => validateBridgeHubLocal('bridge.hub.storage', { target, refresh: true })).toThrow()
    expect(() => validateBridgeHubLocal('bridge.hub.storage', {})).toThrow()
  })

  it('answers a node with the read capability with names and totals, and no path', async () => {
    const f = await fixture(['read'])
    await f.connect()
    const thread = f.mms.threads.createThread('Quarterly plan')
    writeFileSync(join(f.mms.threads.getThreadDir(thread.id), 'payload.bin'), Buffer.alloc(64 * 1024, 1))
    const measure = vi.spyOn(f.mms.storageUsage, 'measure')
    const usage = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.storage', { target: f.targetNode })) as StorageUsageSnapshot
    expect(measure).toHaveBeenCalledWith({ refresh: false })
    expect(usage.entries.find((entry) => entry.kind === 'threads' && entry.threadId === thread.id)!.bytes).toBeGreaterThanOrEqual(64 * 1024)
    expect(usage.names.threads[thread.id]).toBe('Quarterly plan')
    expect(typeof usage.measuredAt).toBe('string')
    // Nothing in the reply is a path: no separator, no part of the profile's location.
    const everything = strings(usage)
    expect(everything.filter((value) => /[\\/]/.test(value))).toEqual([])
    const homes = [f.targetPath, f.mms.getHomeDir()]
    for (const home of homes) expect(JSON.stringify(usage)).not.toContain(home.replaceAll('\\', '\\\\'))
    // The second request is the cache: no rescan.
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.storage', { target: f.targetNode })
    expect(measure).toHaveBeenCalledTimes(2)
    expect(measure.mock.calls.every(([options]) => options?.refresh === false)).toBe(true)
  })

  it('delivers the reply for a profile with 240 threads with long English and CJK names, which the hub accepts', async () => {
    const f = await fixture(['read'])
    await f.connect()
    // The cache holds 240 measured threads; the profile lists them with long names.
    const listed = Array.from({ length: 240 }, (_, index) => ({
      id: `thread-${index}`,
      name: index % 2
        ? `线程${index}：${'季度规划与后续事项的详细记录'.repeat(20)}`.slice(0, 200)
        : `Thread ${index}: ${'quarterly planning notes and follow ups '.repeat(8)}`.slice(0, 200),
      createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', order: index
    }))
    vi.spyOn(f.mms.threads, 'listAllThreads').mockReturnValue(listed)
    const results = listed.map((thread, index) => ({ id: index.toString(16).padStart(16, '0'), kind: 'threads', threadId: thread.id, bytes: 2048 + index, files: 1, measuredAt: 1_700_000_000_000, generation: 1 }))
    mkdirSync(f.mms.threads.lifecycleStore.root, { recursive: true })
    writeFileSync(join(f.mms.threads.lifecycleStore.root, 'storage-usage.json'), JSON.stringify({ schemaVersion: 1, generation: 1, complete: true, durationMs: 3, results }))
    const usage = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.storage', { target: f.targetNode })) as StorageUsageSnapshot
    expect(Buffer.byteLength(JSON.stringify(usage))).toBeLessThanOrEqual(56 * 1024)
    const total = usage.entries.filter((entry) => entry.kind === 'threads').reduce((sum, entry) => sum + entry.bytes, 0)
    expect(total).toBe(results.reduce((sum, row) => sum + row.bytes, 0))
  })

  it('refuses a node that lacks the read capability, and refuses a request that asks for a rescan', async () => {
    const chatOnly = await fixture(['chat'])
    await chatOnly.connect()
    const measure = vi.spyOn(chatOnly.mms.storageUsage, 'measure')
    await expect(executeBridgeHubLocal(chatOnly.hub(), 'bridge.hub.storage', { target: chatOnly.targetNode })).rejects.toMatchObject({ code: 'forbidden' })
    expect(measure).not.toHaveBeenCalled()
    await cleanup()

    const reader = await fixture(['read'])
    await reader.connect()
    const readerMeasure = vi.spyOn(reader.mms.storageUsage, 'measure')
    await expect(reader.hub().call(reader.targetNode, 'storage.usage', { refresh: true } as never)).rejects.toMatchObject({ code: 'bad_request' })
    expect(readerMeasure).not.toHaveBeenCalled()
  })

  it('rejects with a network error, which the settings page shows as unavailable, when the session to the machine is closed', async () => {
    const f = await fixture(['read'])
    await f.connect()
    f.caller().close()
    f.target().close()
    const failure = await executeBridgeHubLocal(f.hub(), 'bridge.hub.storage', { target: f.targetNode }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(NetError)
    expect(typeof (failure as NetError).code).toBe('string')
  })
})
