import { describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore, ordersKeeping } from '../src/mms/data/ThreadDataStore'

function withTemporaryMousseHome(run: (root: string) => void): void {
  const previousHome = process.env.MOUSSE_HOME
  const root = mkdtempSync(join(tmpdir(), 'mousse-thread-ordering-'))
  process.env.MOUSSE_HOME = join(root, 'home')
  try {
    run(root)
  } finally {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}

describe('persisted sidebar ordering', () => {
  it('persists standalone thread order independently of activity timestamps', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const first = threads.createThread('First')
      const second = threads.createThread('Second')

      threads.reorderThreads(undefined, [second.id, first.id])
      threads.saveThreadData(first.id, { messages: [], agents: [], tasks: [] })

      expect(threads.listThreads().map((thread) => thread.id)).toEqual([second.id, first.id])
      const [front, back] = threads.listThreads().map((thread) => thread.order)
      expect(front!).toBeLessThan(back!)
    })
  })

  it('persists settled state and removes a pin while settled', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const thread = threads.createThread('Done')

      threads.setThreadPinned(thread.id, true)
      const settled = threads.setThreadSettled(thread.id, true)

      expect(settled.settledAt).toBeTruthy()
      expect(settled.pinnedAt).toBeUndefined()
      expect(threads.getThread(thread.id)?.settledAt).toBe(settled.settledAt)

      const unsettled = threads.setThreadSettled(thread.id, false)
      expect(unsettled.settledAt).toBeUndefined()
      expect(threads.getThread(thread.id)?.settledAt).toBeUndefined()
    })
  })

  it('marks a thread started only after the first message is saved', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const thread = threads.createThread('New Thread')

      expect(thread.startedAt).toBeUndefined()
      expect(threads.isThreadStarted(thread.id)).toBe(false)

      threads.saveThreadData(thread.id, {
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hello',
            timestamp: new Date().toISOString()
          }
        ],
        agents: [],
        tasks: []
      })

      expect(threads.getThread(thread.id)?.startedAt).toBeTruthy()
      expect(threads.isThreadStarted(thread.id)).toBe(true)
    })
  })

  it('bumps a thread to the front on user activity, not agent saves', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const older = threads.createThread('Older')
      const newer = threads.createThread('Newer')
      expect(threads.listThreads().map((thread) => thread.id)).toEqual([newer.id, older.id])

      const started = threads.touchThreadUserActivity(older.id)
      expect(started?.bumped).toBe(true)
      expect(threads.listThreads().map((thread) => thread.id)).toEqual([older.id, newer.id])

      threads.saveThreadData(newer.id, {
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'agent reply',
            timestamp: new Date().toISOString()
          }
        ],
        agents: [],
        tasks: []
      })
      expect(threads.listThreads().map((thread) => thread.id)).toEqual([older.id, newer.id])

      const again = threads.touchThreadUserActivity(older.id)
      expect(again?.newlyStarted).toBe(false)
      expect(again?.bumped).toBe(false)
    })
  })

  it('can mark a draft started before the first message is persisted', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const thread = threads.createThread('New Thread')

      const first = threads.markThreadStarted(thread.id)
      expect(first?.newlyStarted).toBe(true)
      expect(first?.thread.startedAt).toBeTruthy()
      expect(threads.getThread(thread.id)?.startedAt).toBe(first?.thread.startedAt)
      expect(threads.isThreadStarted(thread.id)).toBe(true)

      const second = threads.markThreadStarted(thread.id)
      expect(second?.newlyStarted).toBe(false)
      expect(second?.thread.startedAt).toBe(first?.thread.startedAt)
    })
  })

  it('treats legacy titled project threads as started even without startedAt', () => {
    withTemporaryMousseHome((root) => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const project = projects.openProject(join(root, 'proj'))
      const thread = threads.createThread('Real title from before startedAt', project.id)

      expect(thread.startedAt).toBeUndefined()
      expect(threads.isThreadStarted(thread.id)).toBe(true)
      expect(threads.listAllThreads().find((entry) => entry.id === thread.id)?.startedAt).toBeTruthy()
    })
  })

  it('keeps project threads isolated and reorders projects explicitly', () => {
    withTemporaryMousseHome((root) => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const firstProject = projects.openProject(join(root, 'first'))
      const secondProject = projects.openProject(join(root, 'second'))
      const firstThread = threads.createThread('First', firstProject.id)
      const secondThread = threads.createThread('Second', firstProject.id)
      const otherThread = threads.createThread('Other', secondProject.id)

      threads.reorderThreads(firstProject.id, [secondThread.id, firstThread.id])
      expect(threads.listThreads(firstProject.id).map((thread) => thread.id)).toEqual([
        secondThread.id,
        firstThread.id
      ])
      expect(() => threads.reorderThreads(firstProject.id, [otherThread.id, firstThread.id])).toThrow(
        'Threads may only be reordered within their current group'
      )

      projects.reorderProjects([secondProject.id, firstProject.id])
      expect(projects.listProjects().map((project) => project.id)).toEqual([
        secondProject.id,
        firstProject.id
      ])
    })
  })

  it('lists a new thread first without reading its group from disk again', () => {
    withTemporaryMousseHome((root) => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const project = projects.openProject(join(root, 'proj'))
      const older = threads.createThread('Older', project.id)
      const loose = threads.createThread('Loose')
      threads.listAllThreads()

      const store = threads as unknown as { scanProjectThreads: () => unknown; readStandaloneIndex: () => unknown }
      const scans = vi.spyOn(store, 'scanProjectThreads')
      const indexReads = vi.spyOn(store, 'readStandaloneIndex')
      const newer = threads.createThread('Newer', project.id)
      const newerLoose = threads.createThread('Newer loose')
      const listed = threads.listAllThreads()

      expect(scans).not.toHaveBeenCalled()
      expect(indexReads).not.toHaveBeenCalled()
      expect(listed.map((thread) => thread.id)).toEqual([newerLoose.id, loose.id, newer.id, older.id])
      expect(newer.order).toBeLessThan(older.order)
      expect(threads.getThread(newer.id)?.name).toBe('Newer')

      // The same lists come back from disk.
      const fresh = new ThreadDataStore(projects)
      expect(fresh.listAllThreads().map((thread) => [thread.id, thread.order])).toEqual(
        listed.map((thread) => [thread.id, thread.order])
      )
    })
  })

  it('reads the lists from disk again after a create that failed part way', () => {
    withTemporaryMousseHome(() => {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      threads.createThread('First')
      threads.listAllThreads()
      const store = threads as unknown as { addToStandaloneIndex: () => void; readStandaloneIndex: () => unknown }
      vi.spyOn(store, 'addToStandaloneIndex').mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      expect(() => threads.createThread('Broken')).toThrow('disk full')

      const indexReads = vi.spyOn(store, 'readStandaloneIndex')
      threads.listAllThreads()
      expect(indexReads).toHaveBeenCalled()
    })
  })

  describe('lists another process changed on disk', () => {
    // Each store is what one process holds: its own caches over the same files. B stands for the other process
    // (another daemon session, the CLI, a restore from the trash); a hand edit of meta.json is checked too.
    function twoStores(root: string) {
      const projectsA = new ProjectManager()
      const a = new ThreadDataStore(projectsA)
      projectsA.setThreadStore(a)
      const project = projectsA.openProject(join(root, 'proj'))
      const projectsB = new ProjectManager()
      const b = new ThreadDataStore(projectsB)
      projectsB.setThreadStore(b)
      return { a, b, project }
    }
    const names = (threads: { name: string }[]) => threads.map((thread) => thread.name)

    it('lists threads the other store added, and orders a new one below every order on disk', () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        a.createThread('A first', project.id)
        a.createThread('A loose')
        a.listAllThreads()
        const fromB = b.createThread('B in project', project.id)
        const looseFromB = b.createThread('B loose')

        const mine = a.createThread('A second', project.id)
        const mineLoose = a.createThread('A loose second')
        expect(names(a.listThreads(project.id))).toEqual(['A second', 'B in project', 'A first'])
        expect(names(a.listThreads())).toEqual(['A loose second', 'B loose', 'A loose'])
        expect(mine.order).toBeLessThan(fromB.order)
        expect(mineLoose.order).toBeLessThan(looseFromB.order)
        const orders = a.listAllThreads().filter((thread) => thread.projectId === project.id).map((thread) => thread.order)
        expect(new Set(orders).size).toBe(orders.length)
      })
    })

    it('shows a thread the other store settled or discarded, at the next create', () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        const done = a.createThread('Done', project.id)
        const unused = a.createThread('Unused', project.id)
        a.listAllThreads()
        b.setThreadSettled(done.id, true)
        b.discardUnusedThread(unused.id)

        a.createThread('Next', project.id)
        const listed = a.listThreads(project.id)
        expect(listed.find((thread) => thread.id === done.id)?.settledAt).toBeTruthy()
        expect(listed.some((thread) => thread.id === unused.id)).toBe(false)
      })
    })

    it('lists a thread folder put there by hand (a restore from a backup) at the next create', () => {
      withTemporaryMousseHome((root) => {
        const { a, project } = twoStores(root)
        const thread = a.createThread('Original', project.id)
        a.listAllThreads()
        // No Mousse writer: only the project's thread folder changes, not its list revision.
        const copyId = randomUUID()
        const copyDir = join(dirname(a.getThreadDir(thread.id)), copyId)
        cpSync(a.getThreadDir(thread.id), copyDir, { recursive: true })
        const metaPath = join(copyDir, 'meta.json')
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), id: copyId, name: 'Restored by hand', order: -50 }))

        const next = a.createThread('Next', project.id)
        expect(a.listThreads(project.id).find((entry) => entry.id === copyId)?.name).toBe('Restored by hand')
        expect(next.order).toBeLessThan(-50)
      })
    })

    it('keeps the cached lists after its own writes, so a create after a rename reads nothing again', () => {
      withTemporaryMousseHome((root) => {
        const { a, project } = twoStores(root)
        const thread = a.createThread('First', project.id)
        a.listAllThreads()
        a.updateThreadMeta(thread.id, { name: 'Renamed' })
        a.setThreadPinned(thread.id, true)
        const scans = vi.spyOn(a as unknown as { scanProjectThreads: () => unknown }, 'scanProjectThreads')
        a.createThread('Second', project.id)
        expect(scans).not.toHaveBeenCalled()
        expect(a.listThreads(project.id).find((entry) => entry.id === thread.id)?.name).toBe('Renamed')
      })
    })

    // Review repro 1: the signature was taken after the scan, so a thread added during it was certified as absent.
    it('reads the group again when the other store adds a thread while this one is reading it', () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        a.createThread('First', project.id)
        const store = a as unknown as { scanProjectThreads: (path: string) => unknown; invalidateListCache: () => void }
        store.invalidateListCache()
        const scan = store.scanProjectThreads.bind(a)
        let added: { id: string; order: number } | undefined
        vi.spyOn(store, 'scanProjectThreads').mockImplementationOnce((path: string) => {
          const read = scan(path)
          added = b.createThread('Added mid-read', project.id)
          return read
        })
        a.listThreads(project.id)
        const next = a.createThread('Next', project.id)
        expect(a.listThreads(project.id).some((entry) => entry.id === added!.id)).toBe(true)
        expect(next.order).toBeLessThan(added!.order)
      })
    })

    // Review repro 2: only the group a create touched was checked, so another project's new thread stayed missing.
    it("lists another project's new thread in the full list after a create in a different project", () => {
      withTemporaryMousseHome((root) => {
        const projectsA = new ProjectManager()
        const a = new ThreadDataStore(projectsA)
        projectsA.setThreadStore(a)
        const project = projectsA.openProject(join(root, 'proj'))
        const other = projectsA.openProject(join(root, 'other'))
        const projectsB = new ProjectManager()
        const b = new ThreadDataStore(projectsB)
        projectsB.setThreadStore(b)
        a.createThread('In P', project.id)
        a.createThread('In Q', other.id)
        a.listAllThreads()
        const fromB = b.createThread('B in Q', other.id)
        a.createThread('A again in P', project.id)
        expect(a.listAllThreads().some((entry) => entry.id === fromB.id)).toBe(true)
        // A fallback read with nothing created in between finds it too.
        const looseFromB = b.createThread('B loose')
        expect(a.listAllThreads().some((entry) => entry.id === looseFromB.id)).toBe(true)
      })
    })

    // Review repro 3: an unusable revision path read as "no revision", and a failed revision write was invisible to others.
    it('never reuses a list over a revision it cannot read, and a write that cannot publish one changes nothing', () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        const thread = a.createThread('Before', project.id)
        a.listAllThreads()
        // The revision's path becomes a folder: it can be neither read nor written.
        const revision = (a as unknown as { listRevisionPath: (id: string) => string }).listRevisionPath(project.id)
        rmSync(revision, { force: true })
        mkdirSync(revision)
        expect(() => b.updateThreadMeta(thread.id, { name: 'After' })).toThrow(/thread list revision/)
        expect(JSON.parse(readFileSync(join(a.getThreadDir(thread.id), 'meta.json'), 'utf8')).name).toBe('Before')
        // A rename written without going through a store (a writer that could not publish) shows: the list is read again.
        const metaPath = join(a.getThreadDir(thread.id), 'meta.json')
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), name: 'Written anyway' }))
        expect(a.listThreads(project.id).find((entry) => entry.id === thread.id)?.name).toBe('Written anyway')
      })
    })

    // Review repro: B renames an existing thread after A computed its new thread's order. Another process would wait for
    // A's lock; a second store in this process enters it (the lock is re-entrant per process), the closest a test gets.
    it("shows another store's rename made while this store was computing a new thread's order", () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        const existing = a.createThread('Existing', project.id)
        a.listAllThreads()
        const store = a as unknown as { projectOrderUnderLock: (id: string, trusted: boolean) => number }
        const order = store.projectOrderUnderLock.bind(a)
        vi.spyOn(store, 'projectOrderUnderLock').mockImplementationOnce((id: string, trusted: boolean) => {
          const next = order(id, trusted)
          b.updateThreadMeta(existing.id, { name: 'Renamed by B' })
          return next
        })
        a.createThread('New', project.id)
        expect(a.listThreads(project.id).find((entry) => entry.id === existing.id)?.name).toBe('Renamed by B')
      })
    })

    // Review repro: B finishes a create after A wrote its thread, before A records the project's new revision.
    it("lists another store's thread made just before this store records its write", () => {
      withTemporaryMousseHome((root) => {
        const { a, b, project } = twoStores(root)
        a.createThread('First', project.id)
        a.listAllThreads()
        const store = a as unknown as {
          publishListRevision: (id: string, phase: 'pending' | 'done') => string
          groupSignature: (id?: string) => string | undefined
        }
        const publish = store.publishListRevision.bind(a)
        const signature = store.groupSignature.bind(a)
        let published = false
        let made: { id: string; order: number } | undefined
        vi.spyOn(store, 'publishListRevision').mockImplementation((id: string, phase: 'pending' | 'done') => {
          const token = publish(id, phase)
          if (phase === 'done') published = true
          return token
        })
        // B's create lands after A published its revision and before A reads the signature it records.
        vi.spyOn(store, 'groupSignature').mockImplementation((id?: string) => {
          if (published && !made && id === project.id) made = b.createThread('Made by B', project.id)
          return signature(id)
        })
        const mine = a.createThread('Mine', project.id)
        vi.restoreAllMocks()
        const listed = a.listThreads(project.id)
        expect(listed.some((entry) => entry.id === made!.id)).toBe(true)
        expect(new Set(listed.map((entry) => entry.order)).size).toBe(listed.length)
        expect(mine.order).not.toBe(made!.order)
      })
    })

    it('does not reuse a list while another writer left the revision pending', () => {
      withTemporaryMousseHome((root) => {
        const { a, project } = twoStores(root)
        const thread = a.createThread('Before', project.id)
        a.listAllThreads()
        const revision = (a as unknown as { listRevisionPath: (id: string) => string }).listRevisionPath(project.id)
        // Another process marked it pending and wrote the metadata, then stopped before marking it done.
        writeFileSync(revision, 'pending:' + randomUUID())
        const metaPath = join(a.getThreadDir(thread.id), 'meta.json')
        writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), name: 'Half-finished writer' }))
        a.createThread('Next', project.id)
        expect(a.listThreads(project.id).find((entry) => entry.id === thread.id)?.name).toBe('Half-finished writer')
      })
    })
  })

  describe('the list lock is the innermost lock, and a write that cannot have it changes nothing', () => {
    /** A lock file as another live process leaves it while it holds the lock (this test runner's parent process). */
    const holdAsAnotherProcess = (path: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      const now = new Date().toISOString()
      writeFileSync(path, JSON.stringify({ pid: process.ppid, processInstanceId: 'another-process', token: randomUUID(), acquiredAt: now, heartbeatAt: now }))
    }
    const gatePath = (store: ThreadDataStore, taskId: string) => join((store.lifecycleStore as unknown as { root: string }).root, 'gates', taskId, 'gate.lock')
    const listLockPath = (store: ThreadDataStore, projectId: string) => (store as unknown as { listLockPath: (id: string) => string }).listLockPath(projectId)
    const revisionOf = (store: ThreadDataStore, projectId: string) => readFileSync((store as unknown as { listRevisionPath: (id: string) => string }).listRevisionPath(projectId), 'utf8')
    const orderOnDisk = (store: ThreadDataStore, id: string) => JSON.parse(readFileSync(join(store.getThreadDir(id), 'meta.json'), 'utf8')).order as number
    /** Runs `work` with the clock jumping a second per read, so the list lock's wait runs out at once. */
    const pastTheWait = <T>(work: () => T): T => {
      let now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000))
      try { return work() } finally { clock.mockRestore() }
    }

    function store(root: string) {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      return { threads, project: projects.openProject(join(root, 'proj')) }
    }

    // Review repro: a lifecycle gate busy in another process, met under the list lock, stopped a reorder part way.
    it("changes no row of a reorder when one row's lifecycle gate is busy, and leaves the revision done", () => {
      withTemporaryMousseHome((root) => {
        const { threads, project } = store(root)
        const made = ['One', 'Two', 'Three'].map((name) => threads.createThread(name, project.id))
        const before = made.map((thread) => orderOnDisk(threads, thread.id))
        // A first read from disk backfills unstarted threads (`ensureStartedAt`); the revision is taken after it.
        threads.listThreads(project.id)
        const revision = revisionOf(threads, project.id)
        const busy = gatePath(threads, made[0]!.id)
        holdAsAnotherProcess(busy)
        // The listed order reversed: every row but one moves, the busy one among them.
        const reversed = threads.listThreads(project.id).map((thread) => thread.id).reverse()
        expect(() => threads.reorderThreads(project.id, reversed)).toThrow(/busy/)
        expect(made.map((thread) => orderOnDisk(threads, thread.id))).toEqual(before)
        expect(revisionOf(threads, project.id)).toBe(revision)
        // A single write refused the same way leaves the revision done too, so lists stay reusable.
        expect(() => threads.updateThreadMeta(made[0]!.id, { name: 'Renamed' })).toThrow(/busy/)
        expect(revisionOf(threads, project.id)).toBe(revision)
        rmSync(busy)
        threads.reorderThreads(project.id, reversed)
        expect(threads.listThreads(project.id).map((thread) => thread.id)).toEqual(reversed)
      })
    })

    // Review repro: every drag rewrote every row of the project, holding the list lock and every row's gate for seconds.
    it('moving one thread among 300 writes one row and holds the list lock briefly', () => {
      withTemporaryMousseHome((root) => {
        const { threads, project } = store(root)
        // One thread made by the store, and 299 copies of its folder (a listing registers each, as for an older thread).
        const first = threads.createThread('Thread 0', project.id)
        const folder = threads.getThreadDir(first.id)
        const meta = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'))
        for (let i = 1; i < 300; i += 1) {
          const id = randomUUID()
          const copy = join(dirname(folder), id)
          cpSync(folder, copy, { recursive: true })
          writeFileSync(join(copy, 'meta.json'), JSON.stringify({ ...meta, id, name: 'Thread ' + i, order: meta.order - i }))
        }
        const listed = threads.listThreads(project.id).map((thread) => thread.id)
        const internals = threads as unknown as {
          writeJsonAtomic: (path: string, value: unknown) => void
          withProjectListLock: <T>(projectId: string, fn: () => T) => T
        }
        const writeJson = internals.writeJsonAtomic.bind(threads)
        const lock = internals.withProjectListLock.bind(threads)
        const written: string[] = []
        const held: number[] = []
        vi.spyOn(internals, 'writeJsonAtomic').mockImplementation((path: string, value: unknown) => {
          if (path.endsWith('meta.json')) written.push((value as { id: string }).id)
          return writeJson(path, value)
        })
        vi.spyOn(internals, 'withProjectListLock').mockImplementation(<T>(projectId: string, fn: () => T): T => lock(projectId, () => {
          const started = performance.now()
          try { return fn() } finally { held.push(performance.now() - started) }
        }))
        try {
          // The last thread to the top, then one from the middle further down.
          const first = [listed[299]!, ...listed.slice(0, 299)]
          threads.reorderThreads(project.id, first)
          expect(written).toEqual([listed[299]])
          const second = [...first]
          const [moved] = second.splice(100, 1)
          second.splice(200, 0, moved!)
          threads.reorderThreads(project.id, second)
          expect(written).toEqual([listed[299], moved])
          expect(threads.listThreads(project.id).map((thread) => thread.id)).toEqual(second)
          expect(new ThreadDataStore(new ProjectManager()).listThreads(project.id).map((thread) => thread.id)).toEqual(second)
          expect(Math.max(...held)).toBeLessThan(250)
        } finally {
          vi.restoreAllMocks()
        }
      })
    }, 120_000)

    // Review repro: a trash in another process during a rename moved a folder; the rename certified the list with it.
    it("drops its list when another process moves a thread folder while it writes, instead of certifying it", () => {
      withTemporaryMousseHome((root) => {
        const { threads, project } = store(root)
        const kept = threads.createThread('Kept', project.id)
        const trashed = threads.createThread('Trashed elsewhere', project.id)
        threads.listThreads(project.id)
        const folder = threads.getThreadDir(trashed.id)
        const internals = threads as unknown as { publishListRevision: (id: string, phase: 'pending' | 'done') => string }
        const publish = internals.publishListRevision.bind(threads)
        vi.spyOn(internals, 'publishListRevision').mockImplementation((id: string, phase: 'pending' | 'done') => {
          const token = publish(id, phase)
          // Another process's trash moves the folder out of the project outside this lock, while the rename writes.
          if (phase === 'pending' && existsSync(folder)) renameSync(folder, join(root, 'moved-away'))
          return token
        })
        try {
          threads.updateThreadMeta(kept.id, { name: 'Renamed' })
        } finally {
          vi.restoreAllMocks()
        }
        expect(threads.listThreads(project.id).map((thread) => thread.id)).toEqual([kept.id])
      })
    })

    // Review repro: a create that timed out on the list lock left an active lifecycle record and an empty folder.
    it('a create that cannot have the list lock in time makes nothing, and says the thread list is busy', () => {
      withTemporaryMousseHome((root) => {
        const { threads, project } = store(root)
        threads.createThread('Existing', project.id)
        const folders = readdirSync(dirname(threads.getThreadDir(threads.listThreads(project.id)[0]!.id)))
        holdAsAnotherProcess(listLockPath(threads, project.id))
        const id = randomUUID()
        expect(() => pastTheWait(() => threads.createThread('New', project.id, undefined, { id }))).toThrow('Thread list busy, try again.')
        expect(threads.lifecycleStore.get(id)).toBeUndefined()
        expect(readdirSync(dirname(threads.getThreadDir(threads.listThreads(project.id)[0]!.id)))).toEqual(folders)
        rmSync(listLockPath(threads, project.id))
        expect(threads.createThread('New', project.id, undefined, { id }).id).toBe(id)
      })
    })

    // Review repro: a discard that timed out on the list lock had already forgotten the lifecycle record.
    it('a discard that cannot have the list lock in time leaves the thread as it was', () => {
      withTemporaryMousseHome((root) => {
        const { threads, project } = store(root)
        const unused = threads.createThread('Unused', project.id)
        const folder = threads.getThreadDir(unused.id)
        holdAsAnotherProcess(listLockPath(threads, project.id))
        expect(() => pastTheWait(() => threads.discardUnusedThread(unused.id))).toThrow('Thread list busy, try again.')
        expect(threads.lifecycleStore.get(unused.id)?.state).toBe('active')
        expect(existsSync(folder)).toBe(true)
        rmSync(listLockPath(threads, project.id))
        threads.discardUnusedThread(unused.id)
        expect(threads.lifecycleStore.get(unused.id)).toBeUndefined()
        expect(existsSync(folder)).toBe(false)
      })
    })
  })
})

describe('the orders a reorder gives', () => {
  const rising = (orders: number[]) => orders.every((order, index) => index === 0 || order > orders[index - 1]!)

  it('keeps every row it can, and moves the others between their neighbours', () => {
    expect(ordersKeeping([-3, -2, -1])).toEqual([-3, -2, -1])
    // The last row to the top, the first to the bottom, one into a gap.
    expect(ordersKeeping([-1, -3, -2])).toEqual([-4, -3, -2])
    expect(ordersKeeping([-2, -1, -3])).toEqual([-2, -1, 0])
    expect(ordersKeeping([0, 2, 1])).toEqual([0, 0.5, 1])
    // Equal orders (an older build's) and an unreadable one are given orders of their own.
    expect(ordersKeeping([1, 1, 1])).toEqual([-1, 0, 1])
    expect(ordersKeeping([Number.NaN, 0])).toEqual([-1, 0])
  })

  it('numbers every row again only when a gap is too small to split', () => {
    expect(ordersKeeping([1, 5, 1 + Number.EPSILON])).toEqual([0, 1, 2])
  })

  it('reverses 5000 rows in a rising order, without nesting', () => {
    const orders = ordersKeeping(Array.from({ length: 5000 }, (_unused, index) => -index))
    expect(orders).toHaveLength(5000)
    expect(rising(orders)).toBe(true)
  })
})
