import type { ScenarioResult } from './runScenario'

/** One replay scenario: the prompt sent and what every adapter's run must produce. */
export interface Scenario {
  name: string
  prompt: string
  /** Adapters the scenario has fixtures for; every adapter when absent. */
  adapters?: string[]
  /**
   * The scenario delegates (SPEC §14): reconciler rule 4 runs until the transcript is consumed, and
   * ids minted at run time (thread and delegation uuids) are normalised in outbound frames.
   */
  delegates?: boolean
  assert(result: ScenarioResult): void
}
