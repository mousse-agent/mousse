import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderCapabilities } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine, type DelegationRequest } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'

const T0 = Date.parse('2026-10-12T00:00:00.000Z')

/** Steer only by queueing: rule 4 must leave rows pending for such a parent. */
export const QUEUE_ONLY_CAPABILITIES: ProviderCapabilities = { ...PI_LOOP_CAPABILITIES, steer: 'queue_only' }

/**
 * One run database, engine and reconciler on a fake clock, with a delegation host that names child
 * threads `child-<n>` and records the requests it saw. Call `dispose` in `afterEach`.
 */
export function delegationFixture(options: { pid?: number; profileHome?: string } = {}) {
  const profileHome = options.profileHome ?? mkdtempSync(join(tmpdir(), 'mousse-delegation-'))
  let clock = T0
  const db = new ProfileDatabase({ profileHome, clock: () => clock })
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
    capabilitiesFor: (threadId) => capabilities.get(threadId) ?? PI_LOOP_CAPABILITIES
  })
  const requests: DelegationRequest[] = []
  let children = 0
  engine.setDelegationHost({
    createThread: (input) => {
      if (input.kind !== 'delegation') throw new Error('the delegation fixture creates child threads only')
      requests.push(input.request)
      children += 1
      return { threadId: `child-${children}` }
    },
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
