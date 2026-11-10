import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'

// A file system whose stats cannot be trusted to change (FAT, exFAT, coarse network times): no signature at all.
vi.mock('../src/mms/data/FileSignature', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mms/data/FileSignature')>()),
  cacheSignature: () => undefined
}))

describe('thread lists on a file system that cannot tell writes apart', () => {
  it('reads the group from disk at every create instead of trusting the cached list', () => {
    const previousHome = process.env.MOUSSE_HOME
    const root = mkdtempSync(join(tmpdir(), 'mousse-untrusted-lists-'))
    process.env.MOUSSE_HOME = join(root, 'home')
    try {
      const projects = new ProjectManager()
      const a = new ThreadDataStore(projects)
      projects.setThreadStore(a)
      const project = projects.openProject(join(root, 'proj'))
      a.createThread('First', project.id)
      a.createThread('Loose')
      a.listAllThreads()
      const store = a as unknown as { scanProjectThreads: () => unknown; readStandaloneIndex: () => unknown }
      const scans = vi.spyOn(store, 'scanProjectThreads')
      const indexReads = vi.spyOn(store, 'readStandaloneIndex')
      a.createThread('Second', project.id)
      a.createThread('Loose second')
      // The creates took their orders from disk; the listing reads the groups again.
      expect(a.listThreads(project.id).map((thread) => thread.name)).toEqual(['Second', 'First'])
      expect(a.listThreads().map((thread) => thread.name)).toEqual(['Loose second', 'Loose'])
      expect(scans).toHaveBeenCalled()
      expect(indexReads).toHaveBeenCalled()
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
