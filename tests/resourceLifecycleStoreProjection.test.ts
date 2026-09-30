import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

describe('retained standalone conversation projections', () => {
  for (const normalizeLegacyOrder of [false, true]) it(`preserves hidden child entries through ${normalizeLegacyOrder ? 'legacy order normalization' : 'visible reordering'} and parent restore`, async () => {
    const f = await lifecycleHarness()
    try {
      const { thread: parent } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'parent' })
      const child = f.services.threads.ensureExecutionThread(`projection/${randomUUID()}`, 'retained child', undefined, { parentTaskId: parent.id })
      const childPath = f.services.threads.getThreadDir(child.id)
      const conversation = [{ id: randomUUID(), role: 'user', content: 'Retain this child conversation', timestamp: new Date().toISOString() }]
      writeFileSync(join(childPath, 'messages.json'), JSON.stringify(conversation))
      const { thread: first } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'first survivor' })
      const { thread: second } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'second survivor' })
      await f.rpc.request('threads.trash', { threadId: parent.id })
      const indexPath = join(f.services.getProfileHomeDir(), 'threads-index.json')
      const childBefore = (JSON.parse(readFileSync(indexPath, 'utf8')) as Thread[]).find((row) => row.id === child.id)
      expect(childBefore).toBeDefined()
      if (normalizeLegacyOrder) {
        const rows = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<Partial<Thread>>
        delete rows.find((row) => row.id === first.id)!.order
        writeFileSync(indexPath, JSON.stringify(rows))
        // Creating a task computes order through the real legacy normalization path.
        await f.rpc.request('threads.create', { name: 'normalize surviving legacy order' })
      } else {
        await f.rpc.request('threads.reorder', { threadIds: [first.id, second.id] })
      }
      const hiddenAfter = (JSON.parse(readFileSync(indexPath, 'utf8')) as Thread[]).find((row) => row.id === child.id)
      expect(hiddenAfter).toEqual(childBefore)
      expect(f.services.threads.getThread(child.id)).toBeUndefined()
      await f.rpc.request('threads.restore', { threadId: parent.id })
      const { threads } = await f.rpc.request<{ threads: Thread[] }>('threads.list', {})
      expect(threads.some((thread) => thread.id === child.id)).toBe(true)
      expect(f.services.threads.getThread(child.id)?.id).toBe(child.id)
      expect(JSON.parse(readFileSync(join(childPath, 'messages.json'), 'utf8'))).toEqual(conversation)
    } finally { await f.close() }
  })
})
