/**
 * Memory the daemon holds for threads nobody is using.
 *
 * Startup: the restart pass (`ThreadRuntimeManager.restoreOnStartup`) reads the agents and tasks of every thread that
 * is not settled. It reads them from the thread's state alone: no transcript is loaded, and none is kept in the
 * thread database cache.
 *
 * Release: a thread that ran and then sat idle is released from memory (`ThreadResidency`). Its session and its thread
 * database cache entry go, and the heap returns to where it was before the thread loaded.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ThreadRuntimeManager } from '../src/mms/runtime/ThreadRuntimeManager'
import type { ChatMessage, Task } from '../src/shared/types'
import { createOrchestrator } from './run/phase6Fixture'

vi.setConfig({ testTimeout: 120_000 })

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

function heapUsed(): number {
  for (let i = 0; i < 3; i++) gc()
  return process.memoryUsage().heapUsed
}

const MB = 1024 * 1024

/** About `kb` KB of transcript: a prompt, a long reply, repeated. */
function transcript(kb: number, seed: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; messages.length * 2 < kb; i++) {
    messages.push({ id: `${seed}-u${i}`, role: 'user', content: `${seed} question ${i} `.padEnd(400, 'q'), timestamp: '2026-01-01T00:00:00.000Z' } as ChatMessage)
    messages.push({ id: `${seed}-a${i}`, role: 'assistant', content: `${seed} answer ${i} `.padEnd(3_600, 'a'), timestamp: '2026-01-01T00:00:01.000Z' } as ChatMessage)
  }
  return messages
}

describe('startup does not load transcripts', () => {
  let home: string
  const previous = { home: process.env.MOUSSE_HOME, sqlite: process.env.MOUSSE_SQLITE_THREAD_STORE }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-idle-memory-')))
    process.env.MOUSSE_HOME = home
    process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
  })

  afterEach(() => {
    // The search index worker may still hold its database open for a moment.
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the OS */ }
    if (previous.home === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previous.home
    if (previous.sqlite === undefined) delete process.env.MOUSSE_SQLITE_THREAD_STORE
    else process.env.MOUSSE_SQLITE_THREAD_STORE = previous.sqlite
  })

  /** `count` started threads of about `kb` KB each; the third has a task left in progress. */
  function seed(count: number, kb: number): { ids: string[]; taskThread: string } {
    const store = new ThreadDataStore(new ProjectManager())
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const thread = store.createThread(`Thread ${i}`, undefined, undefined, { started: true })
      store.mutateThreadData(thread.id, () => ({ messages: transcript(kb, `t${i}`) }))
      ids.push(thread.id)
    }
    const task = { id: 'task-1', description: 'left running', status: 'in_progress', createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Task
    store.mutateThreadData(ids[2]!, () => ({ tasks: [task] }))
    expect(store.usesThreadDb(ids[0]!)).toBe(true)
    store.closeThreadStorage()
    return { ids, taskThread: ids[2]! }
  }

  it('the restart pass over 100 started threads loads no transcript and keeps none in memory', () => {
    const { ids, taskThread } = seed(100, 200)
    // A new store, as a restarted daemon has.
    const store = new ThreadDataStore(new ProjectManager())
    const runtimes = new ThreadRuntimeManager()
    runtimes.attach({ threadStore: store, orchestrator: { setRuntimeManager: () => undefined, bindRuntimeRegistries: () => undefined } as never, ptyManager: { isAlive: () => false } as never, questions: {} as never })

    try {
      const before = heapUsed()
      runtimes.restoreOnStartup()
      const after = heapUsed()

      const stats = store.threadDbCacheStats()
      expect(stats.stateReads).toBeGreaterThanOrEqual(ids.length)
      // Only the thread whose task is marked interrupted is read whole, to save that change.
      expect(stats.coldLoads).toBeLessThanOrEqual(1)
      expect(stats.threads).toBeLessThanOrEqual(1)
      // 100 threads of 200 KB are 20 MB of text; the restart pass holds runtimes and agents, not transcripts.
      expect((after - before) / MB).toBeLessThan(4)
      // The state read is the thread's real state.
      expect(runtimes.get(taskThread)?.tasks.list().map((task) => task.status)).toEqual(['interrupted'])
    } finally {
      store.closeThreadStorage()
    }
    const reread = new ThreadDataStore(new ProjectManager())
    expect(reread.loadThreadWorkState(taskThread).tasks.map((task) => task.status)).toEqual(['interrupted'])
    reread.closeThreadStorage()
  })

  it('a daemon start over 100 started threads loads none of them', async () => {
    const { ids } = seed(100, 40)
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    try {
      await mms.start()
      // Startup queue recovery runs after start; let it finish.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const stats = mms.threads.threadDbCacheStats()
      // Only the thread whose task is marked interrupted is read whole, to save that change.
      expect(stats.coldLoads).toBeLessThanOrEqual(1)
      expect(stats.threads).toBeLessThanOrEqual(1)
      for (const id of ids) expect(mms.orchestrator.hasSession(id)).toBe(false)
    } finally {
      await mms.stop()
    }
  })
})

describe('thread database cache byte cap', () => {
  let dir: string
  let client: ThreadDbClient

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cache-cap-')))
    client = new ThreadDbClient({ script: null })
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function threads(count: number, kb: number): string[] {
    const writer = new ThreadDbStore(client)
    return Array.from({ length: count }, (_, i) => {
      const threadDir = join(dir, `t${i}`)
      mkdirSync(threadDir)
      client.callSync('create', threadDir)
      writer.save(threadDir, { messages: transcript(kb, `t${i}`) })
      return threadDir
    })
  }

  it('drops the least recently used threads past the byte cap and keeps the one in use', () => {
    const dirs = threads(6, 300)
    const store = new ThreadDbStore(client, { threads: 64, bytes: 1 * MB })
    for (const threadDir of dirs) store.load(threadDir)
    const stats = store.cacheStats()
    expect(stats.bytes).toBeLessThanOrEqual(1 * MB)
    expect(stats.threads).toBe(3)
    expect(store.isWarm(dirs[5]!)).toBe(true)
    expect(store.isWarm(dirs[0]!)).toBe(false)
    // A use moves a thread to the front: loading 0 again drops 3, the least recently used, not 4.
    store.info(dirs[4]!)
    store.load(dirs[0]!)
    expect(store.isWarm(dirs[3]!)).toBe(false)
    expect(store.isWarm(dirs[4]!)).toBe(true)
    // A thread larger than the cap on its own stays while it is in use.
    const big = new ThreadDbStore(client, { threads: 64, bytes: 100 * 1024 })
    big.load(dirs[1]!)
    expect(big.isWarm(dirs[1]!)).toBe(true)
  })

  it('passes over threads a session holds', () => {
    const dirs = threads(4, 300)
    const store = new ThreadDbStore(client, { threads: 64, bytes: 1 * MB })
    store.pinned = (threadDir) => threadDir === dirs[0]
    for (const threadDir of dirs) store.load(threadDir)
    expect(store.isWarm(dirs[0]!)).toBe(true)
    expect(store.isWarm(dirs[1]!)).toBe(false)
    expect(store.isWarm(dirs[3]!)).toBe(true)
  })

  it('counts what saves add and what forget drops', () => {
    const [threadDir] = threads(1, 10)
    const store = new ThreadDbStore(client)
    const data = store.load(threadDir!)
    const loaded = store.cacheStats().bytes
    expect(loaded).toBeGreaterThan(10 * 1024)
    store.save(threadDir!, { messages: [...data.messages, ...transcript(100, 'more')] })
    expect(store.cacheStats().bytes - loaded).toBeGreaterThan(100 * 1024)
    store.forget(threadDir!)
    expect(store.cacheStats()).toEqual({ threads: 0, bytes: 0 })
  })

  /** About `kb` KB of tasks: state, not rows. */
  const tasks = (kb: number, seed: string) => Array.from({ length: kb }, (_, i) => ({ id: `${seed}-task-${i}`, description: ''.padEnd(1_000, 'd') }))

  it('counts state a save grows, and drops threads past the cap for it', () => {
    const dirs = threads(3, 1)
    const store = new ThreadDbStore(client, { threads: 64, bytes: 100 * 1024 })
    for (const threadDir of dirs) {
      store.load(threadDir)
      store.save(threadDir, { tasks: tasks(200, threadDir) as never })
    }
    // Each thread now holds about 200 KB of tasks: only the one in use stays under a 100 KB cap.
    const stats = store.cacheStats()
    expect(stats.threads).toBe(1)
    expect(stats.bytes).toBeGreaterThan(200 * 1024)
    expect(store.isWarm(dirs[2]!)).toBe(true)
  })

  it('counts state a save removes', () => {
    const [threadDir] = threads(1, 1)
    const store = new ThreadDbStore(client)
    store.load(threadDir!)
    const before = store.cacheStats().bytes
    store.save(threadDir!, { tasks: tasks(100, 't') as never })
    expect(store.cacheStats().bytes - before).toBeGreaterThan(100 * 1024)
    store.save(threadDir!, { tasks: [] })
    expect(store.cacheStats().bytes - before).toBeLessThan(1024)
    store.save(threadDir!, { mousseAgentSessions: [{ id: 's1', messages: [] }] as never })
    const withSessions = store.cacheStats().bytes
    store.save(threadDir!, { mousseAgentSessions: null })
    expect(store.cacheStats().bytes).toBeLessThan(withSessions)
  })

  it('counts state another writer changes, and drops threads past the cap for it', () => {
    const dirs = threads(2, 1)
    const writer = new ThreadDbStore(client)
    const store = new ThreadDbStore(client, { threads: 64, bytes: 100 * 1024 })
    for (const threadDir of dirs) store.load(threadDir)
    const before = store.cacheStats().bytes
    expect(store.cacheStats().threads).toBe(2)
    // Another process saves 150 KB of tasks to the first thread; this store catches up when it next uses it.
    writer.save(dirs[0]!, { tasks: tasks(150, 'other') as never })
    store.info(dirs[0]!)
    // 150 tasks of about 1 KB each; the other thread was dropped for them.
    expect(store.cacheStats().bytes).toBeGreaterThan(150_000)
    expect(store.cacheStats().threads).toBe(1)
    expect(store.isWarm(dirs[0]!)).toBe(true)
    expect(store.isWarm(dirs[1]!)).toBe(false)
    // And removes them: the size comes back down.
    writer.save(dirs[0]!, { tasks: [] })
    store.info(dirs[0]!)
    expect(store.cacheStats().bytes).toBeLessThan(before)
  })

  it('reads state without loading a thread it does not hold, and from memory when it does', () => {
    const [threadDir] = threads(1, 50)
    const writer = new ThreadDbStore(client)
    writer.save(threadDir!, { agents: [{ id: 'a1' }] as never, tasks: [{ id: 't1' }, { id: 't2' }] as never })
    const store = new ThreadDbStore(client)
    expect(store.readState(threadDir!)).toEqual({ agents: [{ id: 'a1' }], tasks: [{ id: 't1' }, { id: 't2' }], sessions: 0 })
    expect(store.coldLoads).toBe(0)
    expect(store.stateReads).toBe(1)
    expect(store.isWarm(threadDir!)).toBe(false)
    store.load(threadDir!)
    writer.save(threadDir!, { tasks: [{ id: 't3' }] as never })
    expect(store.readState(threadDir!).tasks).toEqual([{ id: 't3' }])
    expect(store.stateReads).toBe(1)
  })
})

describe('releasing idle threads frees what they held', () => {
  let home: string
  const previous = { home: process.env.MOUSSE_HOME, sqlite: process.env.MOUSSE_SQLITE_THREAD_STORE }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-idle-release-memory-')))
    process.env.MOUSSE_HOME = home
    process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
  })

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the OS */ }
    if (previous.home === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previous.home
    if (previous.sqlite === undefined) delete process.env.MOUSSE_SQLITE_THREAD_STORE
    else process.env.MOUSSE_SQLITE_THREAD_STORE = previous.sqlite
  })

  it('5 threads of 1,100 messages, loaded and then idle, leave the heap where it started once released', () => {
    const writer = new ThreadDataStore(new ProjectManager())
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const thread = writer.createThread(`Long ${i}`, undefined, undefined, { started: true })
      // 550 turns: 1,100 messages of about 2.2 MB.
      writer.mutateThreadData(thread.id, () => ({ messages: transcript(2_200, `long${i}`) }))
      expect(writer.loadThreadData(thread.id).messages).toHaveLength(1_100)
      ids.push(thread.id)
    }
    writer.closeThreadStorage()

    const store = new ThreadDataStore(new ProjectManager())
    const orch = createOrchestrator(home, store)
    // Saved as the profile saves (`persistOrchestratorThread`).
    orch.setPersistCallback((threadId) => {
      if (!threadId || !orch.hasSession(threadId)) return
      store.mutateThreadData(threadId, () => ({ messages: orch.liveMessagesForSave(threadId) as ChatMessage[], llmContext: orch.getNativeContext(threadId) }))
    })
    let clock = Date.parse('2026-11-10T12:00:00.000Z')
    orch.residency.now = () => clock
    try {
      const before = heapUsed()
      for (const id of ids) orch.getOrCreateSession(id)
      const loaded = heapUsed()
      // Each thread holds about its stored size while loaded.
      expect((loaded - before) / MB).toBeGreaterThan(8)
      expect(store.threadDbCacheStats().threads).toBe(5)

      clock += 11 * 60_000
      expect(orch.residency.sweepNow().sort()).toEqual([...ids].sort())
      const after = heapUsed()
      for (const id of ids) expect(orch.hasSession(id)).toBe(false)
      expect(store.threadDbCacheStats()).toMatchObject({ threads: 0, bytes: 0 })
      expect(orch.residency.counters).toMatchObject({ released: 5, unsavedAtRelease: 0, staleUses: 0 })
      expect(Math.abs(after - before) / MB).toBeLessThan(1)

      // Released threads open as before.
      expect(orch.getOrCreateSession(ids[0]!).messages).toHaveLength(1_100)
    } finally {
      store.closeThreadStorage()
    }
  })
})
