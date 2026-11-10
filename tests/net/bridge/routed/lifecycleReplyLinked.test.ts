/**
 * A lifecycle record of another computer's deleted thread, read over a real link. The folder file ids its purge
 * recorded (NTFS has 64-bit ones) are never sent: the network's strict JSON refuses a number above 2^53, and the
 * caller would see an error for a call that worked.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
import type { TaskLifecycleRecord } from '../../../../src/shared/resourceLifecycle'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

describe('another computer’s purge records over a real link', () => {
  let t: Awaited<ReturnType<typeof linked>>
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  it('arrive without the file ids a purge recorded, even above 2^53', async () => {
    const thread = t.owner.threads.createThread('Deleted on its own computer')
    // Scratch files only this thread has: a purge records the folder's file id before it removes them.
    const folder = t.owner.threads.getThreadDir(thread.id)
    mkdirSync(join(folder, 'terminal-workspace'), { recursive: true })
    writeFileSync(join(folder, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
    writeFileSync(
      join(folder, 'terminal-workspace.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: thread.id, workspaceRelativePath: 'terminal-workspace' })
    )
    t.owner.threads.setThreadSettled(thread.id, true)
    await t.owner.deleteThreadForGood(thread.id, { human: true, discard: true })

    // As an NTFS file index can be: the record's own digest covers it, so it is rewritten with the id.
    const path = t.owner.threads.lifecycleStore.recordPath(thread.id)
    const record = JSON.parse(readFileSync(path, 'utf8')) as TaskLifecycleRecord
    const purge = record.purge!
    const withIds = purge.items.filter((item) => item.rootIdentity)
    expect(withIds.length).toBeGreaterThan(0)
    for (const item of withIds) item.rootIdentity!.ino = 2 ** 60
    const original = {
      schemaVersion: purge.schemaVersion,
      taskId: purge.taskId,
      generation: purge.generation,
      digest: '',
      items: purge.items.map((item) => ({ ...item, status: 'pending', ...(item.discardState ? { discardState: 'pending' } : {}) })),
      ownedTaskIds: purge.ownedTaskIds,
      blockers: purge.blockers,
      retained: purge.retained,
      exclusiveBytes: purge.exclusiveBytes,
      ...(purge.keepWork ? { keepWork: true } : {})
    }
    purge.digest = createHash('sha256').update(JSON.stringify(original)).digest('hex')
    // Another computer is told of a delete that is still going (its folder is in the trash), never of a finished one.
    record.state = 'purge-started'
    mkdirSync(record.location, { recursive: true })
    writeFileSync(join(record.location, 'meta.json'), JSON.stringify({ id: thread.id, name: 'Deleted on its own computer' }))
    writeFileSync(path, JSON.stringify(record))
    // The id is too big for the network's JSON: sent as it is, the reply could not be.
    expect(() => canonicalJson(t.owner.threads.lifecycleStore.require(thread.id))).toThrow('Unsafe JSON number')

    const reply = await t.dispatch('threads.inventory', { threadId: t.qualified(thread.id) })
    expect(reply.lifecycle).toMatchObject({ taskId: t.qualified(thread.id), state: 'purge-started' })
    expect(reply.lifecycle.purge.items.length).toBe(purge.items.length)
    for (const item of reply.lifecycle.purge.items) expect(item).not.toHaveProperty('rootIdentity')
    expect(() => canonicalJson(reply)).not.toThrow()
  }, 90_000)
})
