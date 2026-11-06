import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

/** Archive first, then delete: only an archived thread is deleted, for good, with its subagent threads. */
describe('threads.delete', () => {
  it('refuses a thread that is not archived, from any client, and leaves it as it was', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'still in use' })
      const folder = f.services.threads.getThreadDir(thread.id)
      for (const client of [f.rpc, cli]) {
        await expect(client.request('threads.delete', { threadId: thread.id })).rejects.toMatchObject({ code: 'thread_not_archived', message: 'Archive the thread before deleting it.' })
      }
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(existsSync(join(folder, 'meta.json'))).toBe(true)
    } finally { await f.close() }
  })

  it('deletes an archived thread and its subagent threads for good, with no trash left behind', async () => {
    const f = await lifecycleHarness()
    try {
      const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })
      const parent = f.services.threads.createThread('Archived parent')
      const child = f.services.threads.createThread('Its subagent', undefined, undefined, { lineage: subagentOf(parent.id) })
      const grandchild = f.services.threads.createThread('Its nested subagent', undefined, undefined, { lineage: subagentOf(child.id, parent.id) })
      const folders = [parent, child, grandchild].map((thread) => f.services.threads.getThreadDir(thread.id))
      await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
      const reply = await f.rpc.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      const ids = new Set(reply.threads.map((thread) => thread.id))
      for (const thread of [parent, child, grandchild]) {
        expect(ids.has(thread.id), thread.name).toBe(false)
        expect(f.services.threads.getThread(thread.id), thread.name).toBeUndefined()
      }
      expect(f.services.threads.lifecycleStore.require(parent.id).state).toBe('purged')
      for (const folder of folders) expect(existsSync(folder), folder).toBe(false)
      // Nothing waits in a trash: the inventory lists no thread that could be restored.
      const inventory = await f.rpc.request<{ lifecycles: Array<{ taskId: string; state: string }> }>('threads.inventory', {})
      expect(inventory.lifecycles.filter((record) => record.state === 'trashed')).toEqual([])
    } finally { await f.close() }
  })

  it('discards unpublished work only for the app; anyone else is refused and the thread goes back to Archived', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'sole copy scratch' })
      const path = f.services.threads.getThreadDir(thread.id)
      mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
      writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
      writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: thread.id, workspaceRelativePath: 'terminal-workspace' }))
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })

      // The CLI asks to discard too, but only a person in the app may: refused, and nothing is lost.
      await expect(cli.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toMatchObject({ code: 'thread_has_unpublished_work' })
      const kept = f.services.threads.getThread(thread.id)
      expect(kept?.settledAt).toBeTruthy()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')

      // The app asks after its confirmation; the thread and its only copy go for good.
      await f.rpc.request('threads.delete', { threadId: thread.id, discard: true })
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(path)).toBe(false)
    } finally { await f.close() }
  })
})
