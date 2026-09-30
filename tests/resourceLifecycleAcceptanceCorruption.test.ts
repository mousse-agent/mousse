import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'

describe('Phase 1 durable authority failure acceptance', () => {
  it('preserves queued input when inventory rejects trash, then cancels replay only on successful trash', async () => {
    const f = await lifecycleHarness()
    let corruptPath: string | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'pending input preservation' })
      const path = f.services.threads.getThreadDir(thread.id)
      const queued = enqueueMessage([], { threadId: thread.id, content: 'unconsumed user input' }).items
      f.services.threads.saveMessageQueue(thread.id, queued)
      corruptPath = join(path, 'workspace.json')
      writeFileSync(corruptPath, '{truncated-workspace-ownership')
      await expect(f.rpc.request('threads.trash', { threadId: thread.id })).rejects.toThrow()
      expect(JSON.parse(readFileSync(join(path, 'queue.json'), 'utf8'))).toEqual(queued)
      unlinkSync(corruptPath); corruptPath = undefined
      await f.rpc.request('threads.trash', { threadId: thread.id })
      await f.rpc.request('threads.restore', { threadId: thread.id })
      expect(f.services.threads.loadMessageQueue(thread.id)).toEqual([])
      expect(f.services.threads.loadThreadData(thread.id).messages).toEqual([])
    } finally {
      if (corruptPath && existsSync(corruptPath)) unlinkSync(corruptPath)
      await f.close()
    }
  })

  it('retains a task whose legacy child ownership data cannot be read', async () => {
    const f = await lifecycleHarness()
    let agentsPath: string | undefined
    let beforeAgents: Buffer | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'ambiguous legacy ownership' })
      const path = f.services.threads.getThreadDir(thread.id)
      agentsPath = join(path, 'agents.json')
      beforeAgents = readFileSync(agentsPath)
      writeFileSync(agentsPath, '[{"id":"lost-child","worktreePath":')
      writeFileSync(join(path, 'sole-copy.txt'), 'unknown legacy owner payload')
      for (const method of ['threads.delete', 'threads.trash', 'threads.purge']) {
        await expect(f.rpc.request(method, { threadId: thread.id })).rejects.toThrow()
        expect(readFileSync(join(path, 'sole-copy.txt'), 'utf8')).toBe('unknown legacy owner payload')
        expect(readFileSync(agentsPath, 'utf8')).toBe('[{"id":"lost-child","worktreePath":')
      }
    } finally {
      if (agentsPath && beforeAgents) writeFileSync(agentsPath, beforeAgents)
      await f.close()
    }
  })

  it.each(['corrupt-record', 'future-record', 'future-manifest'])('%s fails closed before lifecycle or ordinary metadata mutations', async (kind) => {
    const f = await lifecycleHarness()
    let damagedPath: string | undefined
    let original: Buffer | undefined
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'protected authority' })
      const path = f.services.threads.getThreadDir(thread.id)
      writeFileSync(join(path, 'sole-copy.txt'), 'never discard this')
      damagedPath = kind === 'future-manifest'
        ? join(f.home, 'profiles', f.alice.id, 'lifecycle', 'manifest.json')
        : join(f.home, 'profiles', f.alice.id, 'lifecycle', 'tasks', `${thread.id}.json`)
      expect(existsSync(damagedPath)).toBe(true)
      original = readFileSync(damagedPath)
      if (kind === 'corrupt-record') writeFileSync(damagedPath, '{truncated')
      else writeFileSync(damagedPath, JSON.stringify({ ...JSON.parse(original.toString()), schemaVersion: 999, minimumWriterVersion: 999 }))
      const beforeMeta = readFileSync(join(path, 'meta.json'))
      for (const method of ['threads.delete', 'threads.trash', 'threads.restore', 'threads.purge', 'threads.rename']) {
        await expect(f.rpc.request(method, { threadId: thread.id, name: 'must never be written' })).rejects.toThrow()
        expect(readFileSync(join(path, 'meta.json'))).toEqual(beforeMeta)
        expect(readFileSync(join(path, 'sole-copy.txt'), 'utf8')).toBe('never discard this')
      }
    } finally {
      if (damagedPath && original) writeFileSync(damagedPath, original)
      await f.close()
    }
  })

  it('concurrent restore and forbidden purge settle on one complete restorable task', async () => {
    const f = await lifecycleHarness()
    try {
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'restore race' })
      const path = f.services.threads.getThreadDir(thread.id)
      writeFileSync(join(path, 'sole-copy.txt'), 'race payload')
      await f.rpc.request('threads.trash', { threadId: thread.id })
      const peer = await f.connect()
      const [restore, purge] = await Promise.allSettled([
        f.rpc.request<{ thread: Thread }>('threads.restore', { threadId: thread.id }),
        peer.request('threads.purge', { threadId: thread.id })
      ])
      expect(restore.status).toBe('fulfilled')
      expect(purge.status).toBe('rejected')
      expect(readFileSync(join(path, 'sole-copy.txt'), 'utf8')).toBe('race payload')
      expect((await f.rpc.request<{ thread: Thread }>('threads.get', { threadId: thread.id })).thread.id).toBe(thread.id)
      const records = (await f.rpc.request<{ threads: Thread[] }>('threads.list', {})).threads
      expect(records.filter((item) => item.id === thread.id)).toHaveLength(1)
    } finally { await f.close() }
  })
})
