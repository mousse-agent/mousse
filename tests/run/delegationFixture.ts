import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { ProviderCapabilities } from '../../src/mms/harness/adapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine, type DelegationRequest } from '../../src/mms/run/RunEngine'
import { normalizeSubagentTitle } from '../../src/mms/run/delegation/subagentAddress'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'

const T0 = Date.parse('2026-10-12T00:00:00.000Z')

/** Steer only by queueing: rule 4 must leave rows pending for such a parent. */
export const QUEUE_ONLY_CAPABILITIES: ProviderCapabilities = { ...PI_TEST_CAPABILITIES, steer: 'queue_only' }

/**
 * One run database, engine and reconciler on a fake clock, with a delegation host that names child
 * threads `child-<n>` (forks `fork-<n>`) and records the requests it saw, the threads it holds and the threads it was
 * asked to delete. `fault` sees every database checkpoint. Call `dispose` in `afterEach`.
 */
export function delegationFixture(
  options: { pid?: number; profileHome?: string; fault?: (point: string) => void } = {}
) {
  const profileHome = options.profileHome ?? mkdtempSync(join(tmpdir(), 'mousse-delegation-'))
  let clock = T0
  const db = new ProfileDatabase({ profileHome, clock: () => clock, fault: options.fault })
  const store = new RunStore(db)
  const now = () => new Date(clock).toISOString()
  const outbox = new EffectOutbox(store, { now })
  const tools = new ToolInvocations(store)
  const engine = new RunEngine({ store, outbox, tools, now, pid: options.pid ?? 1 })
  const capabilities = new Map<string, ProviderCapabilities>()
  const reconciler = new Reconciler({
    store,
    outbox,
    tools,
    now,
    capabilitiesFor: (threadId) => capabilities.get(threadId) ?? PI_TEST_CAPABILITIES
  })
  const requests: DelegationRequest[] = []
  /** Child threads the host holds (created and not deleted). */
  const threads = new Set<string>()
  const deleted: string[] = []
  /** Titles the host holds for its child threads, by thread id, with the parent that asked for them. */
  const titled = new Map<string, { parentThreadId: string; title: string }>()
  /** Whether a thread still exists for the host (`threadLive`); every thread does by default. */
  const gone = new Set<string>()
  let children = 0
  engine.setDelegationHost({
    createThread: (input) => {
      if (input.kind === 'delegation') requests.push(input.request)
      children += 1
      const threadId = `${input.kind === 'fork' ? 'fork' : 'child'}-${children}`
      threads.add(threadId)
      if (input.kind === 'delegation' && input.request.title) titled.set(threadId, { parentThreadId: input.request.parentThreadId, title: input.request.title })
      return { threadId }
    },
    deleteThread: (threadId) => {
      threads.delete(threadId)
      titled.delete(threadId)
      deleted.push(threadId)
    },
    titleConflicts: (parentThreadId, title) => [...titled]
      .filter(([threadId, held]) => !gone.has(threadId) && held.parentThreadId === parentThreadId && normalizeSubagentTitle(held.title) === normalizeSubagentTitle(title))
      .map(([threadId]) => threadId),
    threadLive: (threadId) => !gone.has(threadId),
    buildChildTurnPayload: ({ childThreadId, childRunId, prompt }) => ({ threadId: childThreadId, runId: childRunId, prompt })
  })

  /** A parent run in `running` on `threadId`. */
  const runningRun = async (threadId = 'parent', clientRequestId = `send:${threadId}:${Date.now()}:${Math.random()}`) => {
    const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    return engine.markRunning(sent.runId)
  }

  /** Starts and finishes `runId` as the turn executor would. */
  const finish = (runId: string, text = 'child result') => {
    if (engine.getRun(runId)!.status === 'queued') engine.markStarting(runId)
    if (engine.getRun(runId)!.status === 'starting') engine.markRunning(runId)
    return engine.markTerminal(runId, 'completed', undefined, { resultText: text })
  }

  const delegate = (parentRunId: string, toolCallId: string, overrides: Partial<DelegationRequest> = {}) => {
    const parent = engine.getRun(parentRunId)!
    return engine.requestDelegation({
      parentThreadId: parent.threadId,
      parentRunId,
      clientRequestId: `delegation:${parentRunId}:${toolCallId}`,
      prompt: 'Inspect the module',
      workspace: 'isolated',
      wake: 'always',
      ...overrides
    })
  }

  return {
    profileHome,
    db,
    store,
    outbox,
    tools,
    engine,
    reconciler,
    capabilities,
    requests,
    threads,
    deleted,
    gone,
    now,
    advance: (ms: number) => {
      clock += ms
    },
    runningRun,
    finish,
    delegate,
    dispose: (keepHome = false) => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      if (!keepHome) rmSync(profileHome, { recursive: true, force: true })
    }
  }
}

export type DelegationFixture = ReturnType<typeof delegationFixture>
