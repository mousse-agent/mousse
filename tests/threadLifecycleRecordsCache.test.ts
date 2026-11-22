/**
 * Ownership passes keep what they read from each thread's database while it is unchanged. On a file system whose
 * times are coarse, a write may leave the database files' stamp as it was; a write from this process is still seen.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// Every stamp the same, as if no file time or size ever changed.
vi.mock('../src/mms/data/threadDb/threadIndex', async (original) => ({ ...await original<object>(), stampOf: () => 'unchanged' }))

const { ProjectManager } = await import('../src/mms/data/ProjectManager')
const { ThreadDataStore } = await import('../src/mms/data/ThreadDataStore')
const { readThreadLifecycleRecordsSync } = await import('../src/mms/data/threadRecords')

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows may hold the database open a moment longer */ }
  }
})

it('sees an agent this process wrote even when the database files look unchanged', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-records-cache-')))
  homes.push(home)
  const threads = new ThreadDataStore(new ProjectManager(home), home, { profileId: 'records-cache-test', allowLegacyProjectData: false })
  threads.setSqliteStoreEnabled(true)
  const thread = threads.createThread('Owner', undefined, undefined, { started: true })
  threads.mutateThreadData(thread.id, () => ({ agents: [{ id: 'a1', worktreePath: '/w/a1', branch: 'mousse/agent/a1' } as never] }))
  const dir = threads.getThreadDir(thread.id)
  const ids = () => (readThreadLifecycleRecordsSync(dir).agents?.data as Array<{ id: string }>).map((agent) => agent.id)
  expect(ids()).toEqual(['a1'])
  threads.mutateThreadData(thread.id, () => ({ agents: [
    { id: 'a1', worktreePath: '/w/a1', branch: 'mousse/agent/a1' } as never,
    { id: 'b1', worktreePath: '/w/b1', branch: 'mousse/agent/b1' } as never
  ] }))
  // Missing b1 here could let cleanup remove its worktree.
  expect(ids()).toEqual(['a1', 'b1'])
})
