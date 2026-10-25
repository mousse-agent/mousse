import { expect } from 'vitest'
import type { ScenarioResult } from '../run/scenarios/runScenario'

/** The driver each replay adapter's runs must be bound to, and the instance a scenario selects. */
export const REPLAY_DRIVERS: Record<string, { driver: string; instanceId: string }> = {
  pi: { driver: 'pi', instanceId: 'pi:openai' },
  'claude-subscription': { driver: 'claude', instanceId: 'claude' },
  antigravity: { driver: 'antigravity', instanceId: 'antigravity' },
  codex: { driver: 'codex', instanceId: 'codex' }
}

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled'])

/**
 * What every driver behind the gateway must do for one scenario, whatever its runtime:
 * - every run of the thread ends in exactly one terminal status;
 * - every run that reached its provider has one immutable execution binding on its attempt,
 *   naming the selected instance and its driver, with the instance's counters;
 * - the provider ref of the attempt names the instance that owns the session;
 * - a stopped turn never reports success.
 */
export function assertHarnessConformance(result: ScenarioResult, options: { stopped?: boolean } = {}): void {
  const expected = REPLAY_DRIVERS[result.adapterId]
  expect(expected, result.adapterId).toBeTruthy()
  for (const run of result.runs) {
    expect(TERMINAL.has(run.status), `${run.runId} is ${run.status}`).toBe(true)
    const attempts = result.attempts[run.runId] ?? []
    const bound = attempts.filter((attempt) => attempt.executionBinding)
    if (run.runId !== result.run.runId && !bound.length) continue
    expect(bound.length, `${run.runId} bindings`).toBe(1)
  }
  const attempts = result.attempts[result.run.runId] ?? []
  const binding = attempts.find((attempt) => attempt.executionBinding)?.executionBinding
  expect(binding).toMatchObject({
    instanceId: expected.instanceId,
    driver: expected.driver,
    homeId: 'default',
    accountGeneration: 0,
    configRevision: 0,
    policy: { mode: 'default', approvals: 'ask' }
  })
  const ref = attempts.find((attempt) => attempt.providerRef)?.providerRef
  if (ref) expect(ref.instanceId ?? binding?.instanceId).toBe(expected.instanceId)
  if (options.stopped) expect(result.run.status).not.toBe('completed')
}
