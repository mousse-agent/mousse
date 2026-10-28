import { describe, expect, it } from 'vitest'
import { heartbeatToleranceMs, steerStrategy, stopStrategy } from '../../src/mms/run/CommandPolicy'
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
