import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Thread } from '../src/shared/types'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

const fault = vi.hoisted(() => ({ from: '', attempts: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: ((from, to) => {
    if (String(from) === fault.from) {
      fault.attempts++
      throw Object.assign(new Error('acceptance: rename denied by filesystem'), { code: 'EACCES' })
    }
    return fs.renameSync(from, to)
  }) as typeof fs.renameSync }
})

it('a filesystem rename failure preserves exact unconsumed input and original task bytes', async () => {
  const f = await lifecycleHarness()
  try {
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'rename failure recovery' })
    const path = f.services.threads.getThreadDir(thread.id)
    f.services.threads.saveMessageQueue(thread.id, enqueueMessage([], { threadId: thread.id, content: 'sole unconsumed user request' }).items)
    const queue = readFileSync(join(path, 'queue.json'))
    const meta = readFileSync(join(path, 'meta.json'))
    fault.from = path; fault.attempts = 0
    await expect(f.rpc.request('threads.trash', { threadId: thread.id })).rejects.toMatchObject({ code: 'handler_error', details: { supportId: expect.any(String) } })
    expect(fault.attempts, 'the actual directory rename boundary must have been attempted').toBeGreaterThan(0)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(join(path, 'queue.json'))).toEqual(queue)
    expect(readFileSync(join(path, 'meta.json'))).toEqual(meta)
    fault.from = ''
    // Legacy clients omit operationId. Retrying the same requested transition
    // must resume the durable failed move without requiring a daemon restart.
    await f.rpc.request('threads.trash', { threadId: thread.id })
    await f.rpc.request('threads.restore', { threadId: thread.id })
    expect(f.services.threads.loadMessageQueue(thread.id)).toEqual([])
    const audit = JSON.parse(readFileSync(join(path, 'lifecycle-cancelled-queue.json'), 'utf8')) as Array<{ queue: unknown }>
    expect(audit.some((entry) => JSON.stringify(entry.queue) === JSON.stringify(JSON.parse(queue.toString())))).toBe(true)
  } finally { fault.from = ''; await f.close() }
})
