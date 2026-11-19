/**
 * A steer/send that lands after the model finished streaming but before the
 * final response is fully written (post-LLM finalizing): the model can no longer
 * read a steer, so it becomes the next turn, first in the queue; a send is queued
 * behind it — never a concurrent turn and never silently dropped.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { createOrchestrator, piAdapter } from './run/phase6Fixture'
import { testHarness } from '../src/mms/run/testkit/harness'

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

  it('a steer is queued as the next turn and a send behind it while the final response finalizes', async () => {
    const projectRepo = mkdtempSync(join(tmpdir(), 'mousse-late-repo-'))
    try {
      const thread = store.createThread('late')
      orch.getOrCreateSession(thread.id).projectCwd = projectRepo

      let inFlight = 0
      let maxInFlight = 0
      let chatCalls = 0
      const lastUserPerCall: string[] = []
      orch.setHarness(testHarness({ adapters: [piAdapter(async (input) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          chatCalls += 1
          lastUserPerCall.push(input.prompt)
          await new Promise((r) => setTimeout(r, 20))
          return 'final answer'
        } finally {
          inFlight -= 1
        }
      })], profileHome: home }))

      // The first turn is past the provider and shows finished while it records its checkpoint: the steer and the send
      // land in that exact window, before the final response is written and the turn settles.
      let steered: ReturnType<OrchestratorService['steerThreadOrEnqueueExternal']> | undefined
      let late: ReturnType<OrchestratorService['send']> | undefined
      const realSetTurnPhase = (orch as any).setTurnPhase.bind(orch)
      ;(orch as any).setTurnPhase = (threadId: string, phase: string, ...rest: unknown[]) => {
        realSetTurnPhase(threadId, phase, ...rest)
        if (phase === 'completed' && !late) {
          // The composer's steer, as the app sends it.
          steered = orch.steerThreadOrEnqueueExternal(thread.id, 'late steer', { source: 'gui-steer' })
          late = orch.send('second', false, { threadId: thread.id })
        }
      }

      const r1 = await orch.send('first', false, { threadId: thread.id })
      expect(r1.queued).not.toBe(true)
      expect(steered).toMatchObject({ steered: false, queued: true })
      expect((await late!).queued).toBe(true)

      // The steer and then the queued send drain as sequential turns — never
      // concurrently with the first.
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
      // The steer shows exactly once, as its own turn.
      expect(contents.filter((c) => c === 'late steer')).toHaveLength(1)
      // The steer runs next, before the send that was queued after it.
      const turnOf = (text: string) => lastUserPerCall.findIndex((t) => t.includes(text))
      expect(turnOf('late steer')).toBe(1)
      expect(turnOf('second')).toBe(2)
    } finally {
      rmSync(projectRepo, { recursive: true, force: true })
    }
  }, 30_000)
})
