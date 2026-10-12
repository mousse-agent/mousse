/**
 * A steer/send that lands after the model finished streaming but before the
 * final response is fully written (post-LLM finalizing) must still be treated
 * as mid-turn: steers accepted, sends queued — never a concurrent turn and
 * never silently dropped.
 */
import { mkdtempSync, rmSync } from 'fs'
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

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('late-turn steer/send during finalizing', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-late-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('steer is accepted and send is queued while the final response finalizes', async () => {
    const projectRepo = mkdtempSync(join(tmpdir(), 'mousse-late-repo-'))
    try {
      const thread = store.createThread('late')
      orch.getOrCreateSession(thread.id).projectCwd = projectRepo

      let releaseFinalizing: (() => void) | null = null
      const finalizingGate = new Promise<void>((r) => {
        releaseFinalizing = r
      })
      let enteredFinalizing = false
      let inFlight = 0
      let maxInFlight = 0
      let chatCalls = 0
      const lastUserPerCall: string[] = []

      // The probe response carries one harmless action so the test can hold
      // the turn inside post-LLM finalizing deterministically.
      ;(orch as any).llm = {
        getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
        getContextInputs: async () => ({
          systemPromptText: '',
          mcpToolsText: '',
          otherToolsText: '',
          signature: 'probe-sig'
        }),
        generateTitle: async () => 'Probe Title',
        chat: async (messages: any, _onTool: unknown, opts: any) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            chatCalls += 1
            const arr = Array.isArray(messages) ? messages : []
            const lastUser = [...arr].reverse().find((m: any) => m?.role === 'user')
            const text =
              typeof lastUser?.content === 'string'
                ? lastUser.content
                : Array.isArray(lastUser?.content)
                  ? lastUser.content.map((p: any) => p?.text ?? '').join('')
                  : ''
            lastUserPerCall.push(text)
            await new Promise((r) => setTimeout(r, 20))
            const aborted = Boolean(opts?.signal?.aborted)
            return {
              text: aborted
                ? ''
                : 'final answer\n```mousse-actions\n{"actions":[{"type":"message","content":"gated"}]}\n```',
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
          } finally {
            inFlight -= 1
          }
        }
      }
      const realExecuteAction = (orch as any).executeAction.bind(orch)
      let executeActionCalls = 0
      ;(orch as any).executeAction = async (action: any, ...rest: any[]) => {
        executeActionCalls += 1
        if (executeActionCalls === 1) {
          // First turn is now past the LLM and inside finalizing: hold it
          // here so the steer/send below land in that exact window.
          enteredFinalizing = true
          await finalizingGate
        }
        return realExecuteAction(action, ...rest)
      }

      const p1 = orch.send('first', false, { threadId: thread.id })
      await waitFor(() => enteredFinalizing, 10_000, 'finalizing gate')

      // Steer and send now race the in-progress final render.
      const steered = orch.steerActiveTurn('late steer', thread.id)
      expect(steered).toBe(true)
      const r2 = await orch.send('second', false, { threadId: thread.id })
      expect(r2.queued).toBe(true)

      releaseFinalizing?.()
      const r1 = await p1
      expect(r1.queued).not.toBe(true)

      // Both the queued send and the leftover steer follow-up must drain as
      // sequential turns — never concurrently with the first.
      await waitFor(
        () => chatCalls >= 3 && !orch.isActiveTurnRunning(thread.id),
        15_000,
        'follow-up turns to drain'
      )
      expect(maxInFlight).toBe(1)
      expect(chatCalls).toBe(3)

      const contents = orch.getMessages(thread.id).map((m) => m.content)
      expect(contents).toContain('first')
      expect(contents).toContain('second')
      // The steer echo is added exactly once, when accepted mid-turn.
      expect(contents.filter((c) => c === 'late steer')).toHaveLength(1)
      // The leftover steer ran as a follow-up turn after the last drain.
      expect(lastUserPerCall.some((t) => t.includes('second'))).toBe(true)
      expect(lastUserPerCall.some((t) => t.includes('late steer'))).toBe(true)
    } finally {
      rmSync(projectRepo, { recursive: true, force: true })
    }
  }, 30_000)
})
