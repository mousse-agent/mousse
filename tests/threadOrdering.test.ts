import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
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
})
