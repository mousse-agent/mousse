import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

it('restores a pre-Phase1 trashed thread after profile startup without requiring an existing lifecycle record', async () => {
  const threadId = randomUUID()
  let original = '', trashPath = ''
  const f = await lifecycleHarness({ prepareProfile(profileHome) {
    original = join(profileHome, 'thread-data', 'standalone', threadId)
    trashPath = join(profileHome, 'trash', 'threads', `${threadId}-legacy`)
    mkdirSync(trashPath, { recursive: true })
    const timestamp = new Date().toISOString()
    const record = { threadId, originalPath: original, trashPath, tombstonedAt: timestamp }
    writeFileSync(join(trashPath, 'meta.json'), JSON.stringify({ id: threadId, name: 'legacy recoverable task', order: 0, createdAt: timestamp, updatedAt: timestamp }))
    for (const name of ['messages', 'agents', 'tasks', 'queue']) writeFileSync(join(trashPath, `${name}.json`), '[]')
    writeFileSync(join(trashPath, 'tombstone.json'), JSON.stringify(record))
    writeFileSync(join(trashPath, 'sole-copy.bin'), Buffer.from([23, 0, 255, 96]))
    writeFileSync(join(profileHome, 'trash', 'threads', 'index.json'), JSON.stringify([record]))
  } })
  try {
    expect(existsSync(original)).toBe(false)
    const discovered = await f.rpc.request<{ lifecycles: { taskId: string; state: string }[]; migrationDiagnostics: unknown[] }>('threads.inventory', {})
    expect(discovered.migrationDiagnostics).toEqual([])
    expect(discovered.lifecycles).toContainEqual(expect.objectContaining({ taskId: threadId, state: 'trashed' }))
    await expect(f.rpc.request('threads.purge', { threadId })).rejects.toThrow()
    const restored = await f.rpc.request<{ thread: Thread }>('threads.restore', { threadId })
    expect(restored.thread.id).toBe(threadId)
    expect(readFileSync(join(original, 'sole-copy.bin'))).toEqual(Buffer.from([23, 0, 255, 96]))
    expect(existsSync(trashPath)).toBe(false)
    expect((await f.rpc.request<{ threads: Thread[] }>('threads.list', {})).threads.filter((thread) => thread.id === threadId)).toHaveLength(1)
    await f.rpc.request('threads.rename', { threadId, name: 'restored legacy task accepts fresh writes' })
    expect((await f.rpc.request<{ thread: Thread }>('threads.get', { threadId })).thread.name).toBe('restored legacy task accepts fresh writes')
  } finally { await f.close() }
})

it('reports malformed legacy trash through the public inventory and refuses mutation while preserving its bytes', async () => {
  let index = ''
  const bytes = '{an incomplete legacy index'
  const f = await lifecycleHarness({ prepareProfile(profileHome) {
    const trashRoot = join(profileHome, 'trash', 'threads')
    mkdirSync(trashRoot, { recursive: true })
    index = join(trashRoot, 'index.json')
    writeFileSync(index, bytes)
  } })
  try {
    const discovered = await f.rpc.request<{ migrationDiagnostics: { reason: string }[] }>('threads.inventory', {})
    expect(discovered.migrationDiagnostics.length).toBeGreaterThan(0)
    expect(discovered.migrationDiagnostics.every((entry) => !!entry.reason)).toBe(true)
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'unrelated preserved active task' })
    const path = f.services.threads.getThreadDir(thread.id)
    const meta = readFileSync(join(path, 'meta.json'))
    for (const method of ['threads.delete', 'threads.trash', 'threads.restore', 'threads.purge']) {
      await expect(f.rpc.request(method, { threadId: thread.id })).rejects.toThrow()
    }
    expect(readFileSync(index, 'utf8')).toBe(bytes)
    expect(readFileSync(join(path, 'meta.json'))).toEqual(meta)
  } finally { await f.close() }
})
