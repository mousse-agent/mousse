/**
 * PR 4 retires the bare `pi` route: a turn with no selection resolves the profile's default model,
 * or fails with `no_model_selected`. Records made on the old route never run again: a run still
 * waiting on such a binding is interrupted at startup with `binding_stale`, the binding cannot be
 * dispatched, and a provider ref made on it is not active (interrupt, fork and stop never throw).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiStubAdapter } from '../support/piStub'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { ExecutionBinding } from '../../src/shared/harness/types'

const homes: string[] = []
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-bare-route-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A binding as an older Mousse recorded it for a turn with no selection, or on a named instance. */
const binding = (instanceId: string): ExecutionBinding => ({
  instanceId,
  driver: 'pi',
  accountGeneration: 0,
  homeId: 'default',
  configRevision: 0,
  model: 'm',
  policy: { mode: 'default', approvals: 'ask', origin: 'interactive' },
  caps: {} as ExecutionBinding['caps'],
  factsRevision: 0
}) as ExecutionBinding

describe('runs recorded on the retired bare pi route', () => {
  it('a queued run bound to `pi` is interrupted at startup with binding_stale; one on a named instance stays queued', async () => {
    const profileHome = home()
    const first = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })) })
    first.reconcileOnBoot()
    const queuedOn = async (threadId: string, instanceId: string): Promise<string> => {
      const sent = await first.dispatch({ kind: 'send', threadId, clientRequestId: `send-${threadId}`, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error(sent.reason)
      // A retry waiting in the queue keeps the binding its earlier attempt recorded.
      const attempt = first.store.createAttempt({ runId: sent.runId, reason: 'initial' })
      first.store.setAttemptBinding(attempt.attemptId, binding(instanceId))
      return sent.runId
    }
    const bare = await queuedOn('t-bare', 'pi')
    const named = await queuedOn('t-named', 'pi:openai')
    first.outbox.enqueue({ effectId: `effect:${bare}:turn.start:1`, threadId: 't-bare', runId: bare, kind: 'turn.start', payload: {} })
    first.store.db.close()

    const second = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })) })
    const report = second.reconcileOnBoot()
    expect(report.interrupted).toContain(bare)
    expect(second.getRun(bare)).toMatchObject({ status: 'interrupted', outcome: { errorCode: 'binding_stale' } })
    expect(second.getRun(bare)?.outcome?.error).toMatch(/Send the message again/)
    // Its pending work is cancelled, and it never ran in this epoch, so no restart note names it.
    expect(second.outbox.listForRun(bare).map((effect) => effect.status)).toEqual(['cancelled'])
    expect(second.store.listEvents('t-bare').filter((event) => event.type === 'restart.note')).toEqual([])
    expect(report.strandedQueued).not.toContain(bare)
    // Nothing is replayed, and the run on a named instance is untouched.
    expect(second.getRun(named)?.status).toBe('queued')
    expect(report.interrupted).not.toContain(named)
    second.store.db.close()
  })

  it('an active run bound to `pi` is interrupted with binding_stale, or uncertain with its unsafe tool', async () => {
    const profileHome = home()
    const first = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })) })
    first.reconcileOnBoot()
    const startedOn = async (threadId: string): Promise<{ runId: string; attemptId: string }> => {
      const sent = await first.dispatch({ kind: 'send', threadId, clientRequestId: `send-${threadId}`, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error(sent.reason)
      const run = first.markStarting(sent.runId)
      first.recordExecutionBinding(sent.runId, binding('pi'))
      return { runId: sent.runId, attemptId: run.activeAttemptId! }
    }
    const quiet = await startedOn('t-quiet')
    const toolRun = await startedOn('t-tool')
    first.tools.start({ invocationId: 'inv-1', runId: toolRun.runId, attemptId: toolRun.attemptId, tool: 'bash', argsDigest: 'd', now: new Date().toISOString() })
    // The previous daemon crashed: its epoch never closed.
    first.store.db.close()

    const second = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })), pid: 2 })
    const report = second.reconcileOnBoot()
    expect(second.getRun(quiet.runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart', errorCode: 'binding_stale' } })
    expect(report.uncertain).toContain(toolRun.runId)
    expect(second.getRun(toolRun.runId)).toMatchObject({ status: 'uncertain', outcome: { uncertainReason: 'non_idempotent_tool_in_flight', errorCode: 'binding_stale' } })
    expect(second.getRun(toolRun.runId)?.outcome?.error).toMatch(/bash/)
    second.store.db.close()
  })
})

describe('the gateway without the bare route', () => {
  const pi = new PiStubAdapter()
  const gateway = () => testHarness({ adapters: [pi], profileHome: home() })

  it('resolves no selection to no_model_selected, never to a pi loop', () => {
    const harness = gateway()
    for (const selection of [{ instanceId: '', llmProvider: '', model: '' }, { instanceId: 'pi', llmProvider: '', model: 'm' }])
      expect(() => harness.resolveStored(selection, { purpose: 'turn', allowDisabled: true })).toThrow(expect.objectContaining({ code: 'no_model_selected' }))
  })

  it('a binding made on the bare route is binding_stale and reaches no runtime', async () => {
    const harness = gateway()
    const dispatch = async () => harness.startTurn({ binding: binding('pi') } as never).result
    await expect(dispatch()).rejects.toMatchObject({ code: 'binding_stale' })
  })

  it('bare-route refs answer not_active and null; nothing throws', async () => {
    const harness = gateway()
    for (const ref of [{ provider: '', instanceId: 'pi', model: 'm', sessionId: 's' }, { provider: '', sessionId: 's' }]) {
      await expect(harness.interrupt(ref)).resolves.toBe('not_active')
      await expect(harness.forkSession(ref, 1)).resolves.toBeNull()
    }
    await expect(harness.stopThread('t-bare')).resolves.toBe('not_active')
  })
})
