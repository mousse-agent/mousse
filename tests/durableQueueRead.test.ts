/**
 * A read of a thread's durable queue takes the queue lock only when `queue.json` changed since the last locked read,
 * and still returns exactly what the file holds after any change, by this process or another.
 */
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { mutateDurableQueue, readDurableQueue } from '../src/mms/queue/durableQueue'
import { enqueueMessage } from '../src/mms/queue/ThreadMessageQueue'
import * as lease from '../src/mms/queue/ThreadExecutionLease'
import type { QueuedMessage } from '../src/shared/types'

vi.mock('../src/mms/queue/ThreadExecutionLease', async (load) => {
  const actual = await load<typeof import('../src/mms/queue/ThreadExecutionLease')>()
  return { ...actual, withQueueMutationLock: vi.fn(actual.withQueueMutationLock) }
})

let home: string
let store: ThreadDataStore
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-queue-read-'))
  process.env.MOUSSE_HOME = home
  store = new ThreadDataStore(new ProjectManager())
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.MOUSSE_HOME
})

const contents = (items: QueuedMessage[]) => items.map((item) => item.content)
const locks = () => vi.mocked(lease.withQueueMutationLock).mock.calls.length
/** The queue file as another process leaves it: `items` plus one message, written whole. */
function written(threadId: string, items: QueuedMessage[], content: string): string {
  return JSON.stringify(enqueueMessage(items, { threadId, content, source: 'other-process' }).items)
}

// Who changes the queue (this process through the lock, another process by replacing the file, or by writing over it
// in place), and whether the file is there at all.
const changes: { case: string; change: (threadId: string, file: string) => string[] }[] = [
  { case: 'this process enqueues under the lock', change: (threadId) => contents(mutateDurableQueue(store, threadId, (items) => enqueueMessage(items, { threadId, content: 'ours', source: 'test' }).items)) },
  { case: 'another process replaces the file', change: (threadId, file) => {
    const next = written(threadId, store.loadMessageQueue(threadId), 'theirs')
    writeFileSync(`${file}.tmp`, next); renameSync(`${file}.tmp`, file)
    return contents(JSON.parse(next))
  } },
  { case: 'the file is written over in place', change: (threadId, file) => {
    const next = written(threadId, store.loadMessageQueue(threadId), 'in place')
    writeFileSync(file, next)
    return contents(JSON.parse(next))
  } },
  { case: 'the file is removed', change: (_, file) => { unlinkSync(file); return [] } },
  { case: 'the file comes back', change: (threadId, file) => {
    const next = written(threadId, [], 'back')
    writeFileSync(file, next)
    return contents(JSON.parse(next))
  } }
]

it('reads each change to the queue, and an unchanged queue without taking the lock', () => {
  const threadId = store.createThread('Queue').id
  const file = join(store.getThreadDir(threadId), 'queue.json')
  for (const row of changes) {
    const expected = row.change(threadId, file)
    expect(contents(readDurableQueue(store, threadId)), row.case).toEqual(expected)
    const before = locks()
    expect(contents(readDurableQueue(store, threadId)), `${row.case}, read again`).toEqual(expected)
    expect(locks() - before, row.case).toBe(0)
  }
})

it('reads a thread that never had a queue file as empty, taking the lock once, and sees the file when it appears', () => {
  const threadId = store.createThread('No queue yet').id
  const file = join(store.getThreadDir(threadId), 'queue.json')
  rmSync(file, { force: true })
  const before = locks()
  // A running turn's steer poll, ten times a second.
  for (let poll = 0; poll < 10; poll++) expect(readDurableQueue(store, threadId)).toEqual([])
  expect(locks() - before).toBe(1)
  writeFileSync(file, written(threadId, [], 'first queued'))
  expect(contents(readDurableQueue(store, threadId))).toEqual(['first queued'])
})

it('does not keep a queue written between the check and the locked read as the missing file', async () => {
  const actual = await vi.importActual<typeof import('../src/mms/queue/ThreadExecutionLease')>('../src/mms/queue/ThreadExecutionLease')
  const threadId = store.createThread('Raced').id
  const file = join(store.getThreadDir(threadId), 'queue.json')
  rmSync(file, { force: true })
  vi.mocked(lease.withQueueMutationLock).mockImplementationOnce((dir, fn) => {
    writeFileSync(file, written(threadId, [], 'raced'))
    return actual.withQueueMutationLock(dir, fn)
  })
  expect(contents(readDurableQueue(store, threadId))).toEqual(['raced'])
  unlinkSync(file)
  expect(readDurableQueue(store, threadId)).toEqual([])
})

it('gives each reader its own copy', () => {
  const threadId = store.createThread('Copies').id
  mutateDurableQueue(store, threadId, (items) => enqueueMessage(items, { threadId, content: 'one', source: 'test' }).items)
  readDurableQueue(store, threadId)
  const first = readDurableQueue(store, threadId)
  first[0]!.content = 'changed by a caller'
  first.push({ ...first[0]! })
  expect(contents(readDurableQueue(store, threadId))).toEqual(['one'])
})
