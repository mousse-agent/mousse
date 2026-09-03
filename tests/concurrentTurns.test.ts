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
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import type { MacroEngine } from '../src/mms/macros/MacroEngine'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { getDefaultSettings } from '../src/shared/settings'

function createOrchestrator(home: string, store: ThreadDataStore): OrchestratorService {
  process.env.MOUSSE_HOME = home
  const orch = new OrchestratorService(
    new AgentRegistry(),
    new TaskQueue(),
    new WorktreeManager(home),
    new PtyManager(),
    new HeadlessAgentRunner(),
    { listProviders: () => [] } as unknown as MacroEngine,
    { get: () => getDefaultSettings() } as never,
    {} as never
  )
  orch.setThreadStore(store)
  return orch
}

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
      ;(orch as any).llm = {
        getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
        getContextInputs: async () => ({
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'probe-sig'
        }),
        generateTitle: async () => 'Probe Title',
        chat: async (_messages: unknown, _onTool: unknown, opts: any) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          // Force overlap: both turns must be inside chat() at once.
          await new Promise((r) => setTimeout(r, 200))
          inFlight -= 1
          const aborted = Boolean(opts?.signal?.aborted)
          return {
            text: aborted ? '' : 'hello from probe',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            modelName: 'probe',
            totalResponseTimeMs: 1,
            totalTokensUsed: 2,
            tokensPerSecond: undefined,
            contextInputs: { signature: 'probe-sig' },
            toolEvents: [],
            aborted,
            nativeMessages: []
          }
        }
      }

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
