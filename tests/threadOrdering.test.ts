import { describe, expect, it, vi } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'

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
      expect(threads.listThreads().map((thread) => thread.order)).toEqual([0, 1])
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
})
