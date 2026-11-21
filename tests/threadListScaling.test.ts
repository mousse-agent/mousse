/**
 * Thread list work costs what one thread costs, not what every thread costs. Each test counts the expensive thing (an
 * index write, a file check, a lifecycle record read, an index reconcile) and compares what the fast path lists with
 * what a store reading everything from disk lists.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { THREAD_DB_FILE } from '../src/mms/data/threadDb/threadDbEngine'
import type { TaskLifecycleRecord } from '../src/shared/resourceLifecycle'
import type { Thread } from '../src/shared/types'

/** The store's own file steps behind every list: what these tests count. */
interface Internals {
  writeJsonAtomic(path: string, value: unknown): void
  readJsonFile(path: string, fallback: unknown): unknown
  stamp(path: string): string | undefined
  readRevisionToken(projectId: string): string | undefined
  threadDb(): { client: { callIndex(...args: unknown[]): Promise<unknown> } }
  firstSweep?: Promise<void>
}
const internals = (store: ThreadDataStore): Internals => store as unknown as Internals

const STANDALONE = 40
const PROJECTS = 3
const PER_PROJECT = 10

let root: string
let home: string
const stores: ThreadDataStore[] = []
const previousHome = process.env.MOUSSE_HOME

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-list-scaling-')))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.MOUSSE_HOME = home
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.stopSearchIndexSweep()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* left for the OS */ }
})

/** A store over the profile, as a daemon (or, opened again, the next start after a crash) has it. */
function open(): { store: ThreadDataStore; projects: ProjectManager } {
  const projects = new ProjectManager(home)
  const store = new ThreadDataStore(projects, home)
  projects.setThreadStore(store)
  stores.push(store)
  return { store, projects }
}

function seed() {
  const { store, projects } = open()
  const standalone = Array.from({ length: STANDALONE }, (_, index) => store.createThread(`Standalone ${index}`, undefined, undefined, { started: true }))
  const projectThreads: Thread[] = []
  for (let p = 0; p < PROJECTS; p += 1) {
    const folder = join(root, `project-${p}`)
    mkdirSync(folder)
    const project = projects.openProject(folder)
    for (let index = 0; index < PER_PROJECT; index += 1) projectThreads.push(store.createThread(`Project ${p} thread ${index}`, project.id, folder, { started: true }))
  }
  return { store, projects, standalone, projectThreads }
}

/** The list keyed by id, for comparing two stores' lists whatever their order. */
const byId = (threads: Thread[]): Record<string, Thread> => Object.fromEntries(threads.map((thread) => [thread.id, thread]))
/** Lets the microtasks of this stretch of work run: what a store checked in it is checked again after. */
const nextStretch = () => new Promise((resolve) => setImmediate(resolve))
const indexWrites = (store: ThreadDataStore): (() => number) => {
  const spy = vi.spyOn(internals(store), 'writeJsonAtomic')
  return () => spy.mock.calls.filter(([path]) => String(path).endsWith('threads-index.json')).length
}

describe('the standalone thread index', () => {
  it('is written once for a burst of list changes, within a second, with nothing lost', () => {
    const { store, standalone } = seed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writes = indexWrites(store)
    // What every turn's end writes (its last reply and how it ended), and a pin, for every thread.
    for (const thread of standalone) {
      store.setThreadLastReply(thread.id, `Reply of ${thread.name}`)
      store.setThreadLastRun(thread.id, 'done')
      store.setThreadPinned(thread.id, true)
    }
    expect(writes()).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(writes()).toBe(1)
    // A store that reads only the files lists exactly what this one does.
    const reread = open().store
    expect(byId(reread.listAllThreads())).toEqual(byId(store.listAllThreads()))
    expect(reread.getThread(standalone[3].id)).toMatchObject({ lastReply: 'Reply of Standalone 3', lastRun: 'done', pinnedAt: expect.any(String) })
  })

  it('gets a new thread at once: a crash loses at most a second of list metadata, never a thread', () => {
    const { store } = seed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const made = store.createThread('Made just now', undefined, undefined, { started: true })
    store.setThreadLastReply(made.id, 'Held for a second')
    // The next start after a crash at this moment reads the files as they are.
    const restarted = open().store
    expect(restarted.listAllThreads().map((thread) => thread.id)).toContain(made.id)
    expect(restarted.getThread(made.id)?.lastReply).toBeUndefined()
    // The thread's own metadata already has it.
    expect(restarted.threadOnDisk(made.id)?.lastReply).toBe('Held for a second')
  })

  it("keeps a thread another store added when it writes the changes it held", () => {
    const { store, standalone } = seed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    store.setThreadLastReply(standalone[1].id, 'Held')
    const made = open().store.createThread('Made by another process', undefined, undefined, { started: true })
    vi.advanceTimersByTime(1_000)
    const reread = open().store
    expect(reread.getThread(made.id)?.name).toBe('Made by another process')
    expect(reread.getThread(standalone[1].id)?.lastReply).toBe('Held')
  })

  it('is written when the store closes', () => {
    const { store, standalone } = seed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    store.setThreadLastRun(standalone[2].id, 'failed')
    store.closeThreadStorage()
    expect(open().store.getThread(standalone[2].id)?.lastRun).toBe('failed')
  })
})

describe('thread lookups', () => {
  it('check the lists against the disk once per stretch of work, however many lookups it makes', async () => {
    const { store, standalone, projectThreads } = seed()
    const expected = store.listAllThreads()
    await nextStretch()
    const stamps = vi.spyOn(internals(store), 'stamp')
    const revisions = vi.spyOn(internals(store), 'readRevisionToken')
    for (let index = 0; index < 25; index += 1) {
      expect(store.listAllThreads()).toEqual(expected)
      expect(store.getThread(standalone[index].id)?.id).toBe(standalone[index].id)
      expect(store.getThread(projectThreads[index].id)?.id).toBe(projectThreads[index].id)
    }
    // The index file, and each project's folder and list revision: once.
    expect(stamps.mock.calls.length).toBeLessThanOrEqual(PROJECTS + 1)
    expect(revisions.mock.calls.length).toBeLessThanOrEqual(PROJECTS)
    await nextStretch()
    stamps.mockClear()
    store.listAllThreads()
    store.listAllThreads()
    expect(stamps.mock.calls.length).toBe(PROJECTS + 1)
    expect(byId(open().store.listAllThreads())).toEqual(byId(expected))
  })

  it("see another store's change made in the same stretch of work", () => {
    const { store, projectThreads } = seed()
    store.listAllThreads()
    open().store.updateThreadMeta(projectThreads[4].id, { name: 'Renamed elsewhere' })
    expect(store.listAllThreads().find((thread) => thread.id === projectThreads[4].id)?.name).toBe('Renamed elsewhere')
  })

  it('answer an id that is no thread from memory after the first time, without reading the index or every record', async () => {
    const { store } = seed()
    store.listAllThreads()
    await nextStretch()
    const gets = vi.spyOn(store.lifecycleStore, 'get')
    const reads = vi.spyOn(internals(store), 'readJsonFile')
    const missing = randomUUID()
    for (let index = 0; index < 20; index += 1) expect(store.getThread(missing)).toBeUndefined()
    // Each lookup reads that id's own record only; the index is in memory.
    expect(gets.mock.calls.length).toBeLessThanOrEqual(20)
    expect(reads.mock.calls.filter(([path]) => String(path).endsWith('threads-index.json'))).toHaveLength(0)
    expect(open().store.getThread(missing)).toBeUndefined()
    // Made since by another process: found.
    open().store.createThread('Now it exists', undefined, undefined, { id: missing, started: true })
    expect(store.getThread(missing)?.name).toBe('Now it exists')
  })

  it("read no other thread when a bot run reuses its thread or a send moves a thread to the top", async () => {
    const { store, standalone } = seed()
    store.ensureExecutionThread('bot:helper', 'Helper', undefined, undefined, { botOwned: true })
    store.listAllThreads()
    await nextStretch()
    const gets = vi.spyOn(store.lifecycleStore, 'get')
    for (let index = 0; index < 5; index += 1) {
      store.ensureExecutionThread('bot:helper', 'Helper', undefined, undefined, { botOwned: true })
      store.touchThreadUserActivity(standalone[index].id)
      store.listAllThreads()
      await nextStretch()
    }
    const perRun = gets.mock.calls.length / 5
    expect(store.listThreads()[0]?.id).toBe(standalone[4].id)
    // Reading the lists again costs a record read per thread; each run and send now costs a few for its own thread.
    gets.mockClear()
    ;(store as unknown as { invalidateListCache(): void }).invalidateListCache()
    store.listAllThreads()
    const relist = gets.mock.calls.length
    expect(relist).toBeGreaterThanOrEqual(STANDALONE + PROJECTS * PER_PROJECT)
    expect(perRun).toBeLessThan(relist / 2)
    store.flushStandaloneIndex()
    expect(byId(open().store.listAllThreads())).toEqual(byId(store.listAllThreads()))
  })
})

describe('the search index', () => {
  it("is reconciled once after start and then hourly, not every minute, and drops a trashed thread's rows", async () => {
    const { store, standalone } = seed()
    const calls = vi.spyOn(internals(store).threadDb().client, 'callIndex').mockResolvedValue(0)
    const reconciles = () => calls.mock.calls.filter(([op]) => op === 'indexReconcile').length
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    store.startSearchIndexSweep()
    await internals(store).firstSweep
    expect(reconciles()).toBe(1)
    const gets = vi.spyOn(store.lifecycleStore, 'get')
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(reconciles()).toBe(1)
    // Nothing visited every thread meanwhile.
    expect(gets).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    for (let wait = 0; wait < 100 && reconciles() < 2; wait += 1) await nextStretch()
    expect(reconciles()).toBe(2)

    // A thread kept in thread.db goes to the trash: its rows are dropped, not left for the next reconcile.
    const thread = standalone[0]
    const original = store.getThreadDir(thread.id)
    const trashed = join(root, 'trash', thread.id)
    cpSync(original, trashed, { recursive: true })
    writeFileSync(join(trashed, THREAD_DB_FILE), '')
    store.projectLifecycleIndex({ taskId: thread.id, location: trashed, originalLocation: original } as TaskLifecycleRecord)
    await store.flushSearchIndex()
    expect(calls).toHaveBeenCalledWith('indexUpdate', home, [{ threadId: thread.id, dir: trashed, drop: true }])
  })
})
