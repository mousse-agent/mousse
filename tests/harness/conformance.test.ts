/**
 * Harness conformance: the real gateway and drivers, against the replay transports
 * (`sdkQueryReplay`, `codexAppServerReplay`, `acpReplay`, `cursorHostReplay`, `piChatReplay`, and
 * `piRpcReplay` for the Pi RPC engine) through the replay scenario runner. The scenario suite checks
 * each scenario's own outcome; this checks what every driver owes the gateway.
 */
import { describe, it } from 'vitest'
import { fixtureAdapters, runScenario } from '../run/scenarios/runScenario'
import { assertHarnessConformance } from './conformance'

const CASES: Array<{ scenario: string; stopped?: boolean }> = [
  { scenario: 'plain-turn' },
  { scenario: 'provider-error' },
  { scenario: 'steer-mid-turn' },
  { scenario: 'stop-mid-stream', stopped: true },
  // Generic-agent edge cases: only the `acp` adapter has fixtures for them.
  { scenario: 'cancelled-by-agent', stopped: true },
  { scenario: 'refused-by-agent' },
  { scenario: 'token-limit' },
  { scenario: 'model-options' },
  { scenario: 'slash-command' }
]

describe.each(CASES)('$scenario', ({ scenario, stopped }) => {
  it.each(fixtureAdapters(scenario))('conforms through %s', async (adapterId) => {
    assertHarnessConformance(await runScenario(scenario, adapterId), { stopped })
  })
})
