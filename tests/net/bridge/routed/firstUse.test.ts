/** What the owner is told, once for each device, the first time that device changes a thread here. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '../hub/fixture'
import { cleanupAll } from './routerFixture'
import { routedOwner } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
  await cleanupAll()
})

describe('the first change a device makes on a thread here', () => {
  it('is told to the owner once, named by the device, and written to the audit', async () => {
    const told: Array<{ name: string; threadId?: string }> = []
    const o = await routedOwner({ terminals: { deviceName: () => 'Studio Mac', onFirstUse: (info) => told.push(info) } })
    const thread = o.thread('A thread')
    // Reading is not working on it.
    await o.ok('threads.get', { threadId: thread.id })
    expect(told).toEqual([])
    await o.ok('threads.rename', { threadId: thread.id, name: 'Renamed' })
    await o.ok('threads.rename', { threadId: thread.id, name: 'Renamed again' })
    expect(told).toEqual([{ node: o.f.callerNode, name: 'Studio Mac', threadId: thread.id }])
    const rows = o.audit.recent(20, o.f.callerNode).filter((row) => row.method === 'thread.first_use')
    expect(rows).toEqual([expect.objectContaining({ kind: 'change', outcome: 'first_use', thread: thread.id })])
  }, 120_000)

  it('is not told again after the audit says it was, for example after a restart', async () => {
    const told: unknown[] = []
    const o = await routedOwner({ terminals: { onFirstUse: (info) => told.push(info) } })
    o.audit.record({ node: o.f.callerNode, method: 'thread.first_use', outcome: 'first_use', kind: 'change' })
    const thread = o.thread('A thread')
    await o.ok('threads.rename', { threadId: thread.id, name: 'Renamed' })
    expect(told).toEqual([])
  }, 120_000)

  it('is not told for a change that was refused', async () => {
    const told: unknown[] = []
    const o = await routedOwner({ terminals: { onFirstUse: (info) => told.push(info) } })
    const reply = await o.call('threads.rename', { threadId: 'not-a-thread', name: 'x' })
    expect(reply.ok).toBe(false)
    expect(told).toEqual([])
  }, 120_000)
})
