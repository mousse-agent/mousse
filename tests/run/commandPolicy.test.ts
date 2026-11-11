import { describe, expect, it } from 'vitest'
import { heartbeatToleranceMs, steerDelivery, steerStrategy, stopStrategy, type SteerTurnFacts } from '../../src/mms/run/CommandPolicy'
import { ANTIGRAVITY_CAPABILITIES } from '../../src/mms/harness/acp/presets/antigravity'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { ProviderCapabilities } from '../../src/mms/harness/adapter'
import type { RunRecord, RunStatus } from '../../src/mms/run/types'

const caps = (patch: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...PI_TEST_CAPABILITIES,
  ...patch
})

const run = (status: RunStatus): RunRecord => ({
  runId: 'run:thread:t:ordinal:1',
  threadId: 't',
  ordinal: 1,
  status,
  epoch: 1,
  activeAttemptId: null,
  source: 'gui',
  clientRequestId: null,
  userMessageId: null,
  requestedAt: '2026-10-12T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  outcome: null,
  heartbeatAt: null
})

const LIVE: RunStatus[] = ['starting', 'running']
const OVER: RunStatus[] = ['finalizing', 'completed', 'interrupted', 'failed', 'cancelled', 'uncertain']

describe('steerStrategy', () => {
  it('turns a steer for a missing, finalizing or terminal run into a new run', () => {
    expect(steerStrategy(caps(), null)).toBe('late_steer_new_run')
    for (const status of OVER) expect(steerStrategy(caps(), run(status))).toBe('late_steer_new_run')
  })

  it('queues a steer for a run that has not started', () => {
    expect(steerStrategy(caps({ steer: 'native' }), run('queued'))).toBe('queue')
  })

  it('follows the provider for a live run', () => {
    for (const status of LIVE) {
      expect(steerStrategy(caps({ steer: 'native' }), run(status))).toBe('native')
      expect(steerStrategy(caps({ steer: 'interrupt_restart', interrupt: true }), run(status))).toBe(
        'interrupt_restart'
      )
      expect(steerStrategy(caps({ steer: 'queue_only' }), run(status))).toBe('queue')
    }
  })

  it('steers the pi loop natively and Claude Subscription and Antigravity by interrupt-and-restart', () => {
    for (const status of LIVE) {
      expect(steerStrategy(PI_TEST_CAPABILITIES, run(status))).toBe('native')
      expect(steerStrategy(CLAUDE_SUBSCRIPTION_CAPABILITIES, run(status))).toBe('interrupt_restart')
      expect(steerStrategy(ANTIGRAVITY_CAPABILITIES, run(status))).toBe('interrupt_restart')
    }
  })

  it('queues instead of restarting when the provider cannot be interrupted', () => {
    expect(steerStrategy(caps({ steer: 'interrupt_restart', interrupt: false }), run('running'))).toBe(
      'queue'
    )
  })
})

describe('steerDelivery (docs/design/steer-and-interruptions.md §2.2)', () => {
  const turn = (patch: Partial<SteerTurnFacts> = {}): SteerTurnFacts => ({ foreground: 0, releaseOpen: false, strict: false, held: false, atBoundary: false, forced: false, ...patch })
  const person = { person: true }
  const agent = { person: false }
  const hold = (steerBoundary: 'announce' | 'start', steer: ProviderCapabilities['steer'] = 'interrupt_restart') => caps({ steer, steerBoundary })

  it.each(['announce', 'start'] as const)('a person\'s steer on a %s provider: forced cuts, a tool or the window holds, a boundary is native, writing cuts', (boundary) => {
    const c = hold(boundary)
    expect(steerDelivery(c, turn({ forced: true, foreground: 2 }), person)).toBe('cut')
    expect(steerDelivery(c, turn({ foreground: 1 }), person)).toBe('hold')
    expect(steerDelivery(c, turn({ releaseOpen: true }), person)).toBe('hold')
    expect(steerDelivery(c, turn({ atBoundary: true }), person)).toBe('native')
    expect(steerDelivery(c, turn(), person)).toBe('cut')
  })

  it('an agent\'s steer or a notice on a native provider is always native, during a tool too, and never forced', () => {
    const c = hold('start', 'native')
    for (const facts of [turn(), turn({ foreground: 1 }), turn({ releaseOpen: true }), turn({ atBoundary: true }), turn({ forced: true })])
      expect(steerDelivery(c, facts, agent)).toBe('native')
  })

  it('an agent\'s steer or a notice on an interrupt_restart provider holds for a tool, is native at a boundary, and cuts while writing', () => {
    const c = hold('announce')
    expect(steerDelivery(c, turn({ foreground: 1 }), agent)).toBe('hold')
    expect(steerDelivery(c, turn({ releaseOpen: true }), agent)).toBe('hold')
    expect(steerDelivery(c, turn({ atBoundary: true }), agent)).toBe('native')
    expect(steerDelivery(c, turn(), agent)).toBe('cut')
  })

  it('steerBoundary none keeps the behaviour from before the hold: a person cuts, anything else follows the capability', () => {
    for (const facts of [turn(), turn({ foreground: 3 }), turn({ releaseOpen: true, strict: true, held: true }), turn({ atBoundary: true })]) {
      expect(steerDelivery(caps({ steer: 'interrupt_restart', steerBoundary: 'none' }), facts, person)).toBe('cut')
      expect(steerDelivery(caps({ steer: 'native', steerBoundary: 'none' }), facts, person)).toBe('cut')
      expect(steerDelivery(caps({ steer: 'native', steerBoundary: 'none' }), facts, agent)).toBe('native')
      expect(steerDelivery(caps({ steer: 'interrupt_restart', steerBoundary: 'none' }), facts, agent)).toBe('cut')
    }
    // Caps saved before the key existed read as none.
    const { steerBoundary: _gone, ...old } = hold('announce')
    expect(steerDelivery(old as ProviderCapabilities, turn({ foreground: 1 }), person)).toBe('cut')
  })

  it('strict keeps a steer that is already held held until the provider\'s turn ends, on a start provider only', () => {
    expect(steerDelivery(hold('start'), turn({ strict: true, held: true }), person)).toBe('hold')
    expect(steerDelivery(hold('start'), turn({ strict: true, held: true, atBoundary: true }), person)).toBe('native')
    expect(steerDelivery(hold('start'), turn({ strict: true, held: true, forced: true }), person)).toBe('cut')
    // An announce provider knows every tool before it runs: strict changes nothing there.
    expect(steerDelivery(hold('announce'), turn({ strict: true, held: true }), person)).toBe('cut')
    // Best effort releases the same steer.
    expect(steerDelivery(hold('start'), turn({ strict: false, held: true }), person)).toBe('cut')
  })

  it('strict, after a tool finished and model output closed the window, a new steer (nothing held) cuts', () => {
    expect(steerDelivery(hold('start'), turn({ strict: true, held: false, foreground: 0, releaseOpen: false }), person)).toBe('cut')
  })
})

describe('stopStrategy', () => {
  it('does nothing for a missing or terminal run', () => {
    expect(stopStrategy(caps(), null)).toBe('noop')
    for (const status of OVER.filter((s) => s !== 'finalizing'))
      expect(stopStrategy(caps(), run(status))).toBe('noop')
  })

  it('settles a queued run locally', () => {
    expect(stopStrategy(caps({ interrupt: true }), run('queued'))).toBe('settle_locally')
  })

  it('interrupts a live run when the provider can, otherwise settles locally', () => {
    for (const status of [...LIVE, 'finalizing'] as RunStatus[]) {
      expect(stopStrategy(caps({ interrupt: true }), run(status))).toBe('interrupt')
      expect(stopStrategy(caps({ interrupt: false }), run(status))).toBe('settle_locally')
    }
  })
})

describe('heartbeatToleranceMs', () => {
  it('keeps the base window for rich events and widens it 6x for sparse ones', () => {
    expect(heartbeatToleranceMs(caps({ events: 'rich' }), 20_000)).toBe(20_000)
    expect(heartbeatToleranceMs(caps({ events: 'sparse' }), 20_000)).toBe(120_000)
  })
})

describe('a paused run (a usage limit ended its turn)', () => {
  it('has no live turn to steer: the text becomes a message of its own, whatever the provider can do', () => {
    for (const capability of [caps({ steer: 'native' }), caps({ steer: 'interrupt_restart', interrupt: true }), caps({ steer: 'queue_only' })])
      expect(steerStrategy(capability, run('paused'))).toBe('late_steer_new_run')
  })

  it('has nothing to interrupt: a Stop settles it without provider I/O', () => {
    expect(stopStrategy(caps({ interrupt: true }), run('paused'))).toBe('settle_locally')
    expect(stopStrategy(caps({ interrupt: false }), run('paused'))).toBe('settle_locally')
  })
})
