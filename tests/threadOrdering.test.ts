import { describe, expect, it } from 'vitest'
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
})
