import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

it('brings a legacy-index trashed thread back to Archived at profile startup, once, with its bytes', async () => {
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
    // Threads no longer wait in a trash: what was there when that changed is back, archived, nothing lost.
    const discovered = await f.rpc.request<{ lifecycles: { taskId: string; state: string }[]; migrationDiagnostics: unknown[] }>('threads.inventory', {})
    expect(discovered.migrationDiagnostics).toEqual([])
    expect(discovered.lifecycles).toContainEqual(expect.objectContaining({ taskId: threadId, state: 'active' }))
    expect(readFileSync(join(original, 'sole-copy.bin'))).toEqual(Buffer.from([23, 0, 255, 96]))
    expect(existsSync(trashPath)).toBe(false)
    const listed = (await f.rpc.request<{ threads: Thread[] }>('threads.list', {})).threads.filter((thread) => thread.id === threadId)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.settledAt).toBeTruthy()
    // It was done once: the marker says so, and the thread takes fresh writes.
    expect(existsSync(join(f.home, 'profiles', f.alice.id, 'lifecycle', 'trash-returned-to-archive.json'))).toBe(true)
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
    // A diagnostic that names no task makes an unknown task's inventory unanswerable, not "not found".
    await expect(f.rpc.request('threads.inventory', { threadId: 'unknown-task' })).resolves.toMatchObject({ lifecycle: null, inventory: null, migrationDiagnostics: discovered.migrationDiagnostics })
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

it('answers a single-task inventory: from its record, by registering a record-less thread, and with nulls only when a migration diagnostic names that task', async () => {
  const f = await lifecycleHarness({ prepareProfile(profileHome) {
    const trashPath = join(profileHome, 'trash', 'threads', 'broken-legacy-old')
    mkdirSync(trashPath, { recursive: true })
    writeFileSync(join(trashPath, 'meta.json'), JSON.stringify({ id: 'someone-else' }))
    writeFileSync(join(profileHome, 'trash', 'threads', 'index.json'), JSON.stringify([
      { threadId: 'broken-legacy', originalPath: join(profileHome, 'thread-data', 'standalone', 'broken-legacy'), trashPath, tombstonedAt: new Date().toISOString() }
    ]))
  } })
  try {
    type One = { lifecycle: { taskId: string; state: string } | null; inventory: { taskId: string } | null; migrationDiagnostics: { threadId?: string; reason: string }[] }
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'inventoried task' })
    const known = await f.rpc.request<One>('threads.inventory', { threadId: thread.id })
    expect(known.lifecycle).toMatchObject({ taskId: thread.id, state: 'active' })
    expect(known.inventory).toMatchObject({ taskId: thread.id })
    expect(known.migrationDiagnostics).toEqual([expect.objectContaining({ threadId: 'broken-legacy', reason: expect.stringMatching(/metadata identity/) })])
    // A thread that has no lifecycle record yet is registered by the inventory request itself.
    expect(f.services.threads.lifecycleStore.forgetCreatedTask(thread.id)).toBe(true)
    expect((await f.rpc.request<One>('threads.inventory', { threadId: thread.id })).lifecycle).toMatchObject({ taskId: thread.id, state: 'active' })
    // A diagnostic makes only its own task unanswerable; another unknown task is an error.
    expect(await f.rpc.request<One>('threads.inventory', { threadId: 'broken-legacy' })).toMatchObject({ lifecycle: null, inventory: null })
    await expect(f.rpc.request('threads.inventory', { threadId: 'unknown-task' })).rejects.toThrow()
  } finally { await f.close() }
})
