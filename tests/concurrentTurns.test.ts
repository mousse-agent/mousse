/**
 * Two concurrent sends on different threads of the same project must both run
 * and both complete: no cross-thread serialization or deadlock in the
 * orchestrator, and both execution leases must be released.
 */
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { createOrchestrator, piAdapter } from './run/phase6Fixture'
import { testHarness } from '../src/mms/run/testkit/harness'

describe('concurrent same-project turns', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-conc-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('two concurrent sends on same-project threads both complete', async () => {
    const projectRepo = mkdtempSync(join(tmpdir(), 'mousse-conc-repo-'))
    try {
      const t1 = store.createThread('A')
      const t2 = store.createThread('B')
      // Same project cwd for both threads.
      orch.getOrCreateSession(t1.id).projectCwd = projectRepo
      orch.getOrCreateSession(t2.id).projectCwd = projectRepo

      let inFlight = 0
      let maxInFlight = 0
      orch.setHarness(testHarness({ adapters: [piAdapter(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        // Force overlap: both turns must be inside the provider turn at once.
        await new Promise((r) => setTimeout(r, 200))
        inFlight -= 1
        return 'hello from probe'
      })], profileHome: home }))

      const [r1, r2] = await Promise.all([
        orch.send('msg-a', false, { threadId: t1.id }),
        orch.send('msg-b', false, { threadId: t2.id })
      ])
      expect(r1.queued).not.toBe(true)
      expect(r2.queued).not.toBe(true)
      expect(r1.message).toBe('hello from probe')
      expect(r2.message).toBe('hello from probe')
      expect(maxInFlight).toBe(2)
      expect(orch.getMessages(t1.id).map((m) => m.content)).toContain('msg-a')
      expect(orch.getMessages(t2.id).map((m) => m.content)).toContain('msg-b')
      expect(existsSync(join(store.getThreadDir(t1.id), 'execution.lease'))).toBe(false)
      expect(existsSync(join(store.getThreadDir(t2.id), 'execution.lease'))).toBe(false)
    } finally {
      rmSync(projectRepo, { recursive: true, force: true })
    }
  }, 30_000)
})
