import type { ScenarioResult } from './runScenario'

/** One replay scenario: the prompt sent and what every adapter's run must produce. */
export interface Scenario {
  name: string
  prompt: string
  /** Adapters the scenario has fixtures for; every adapter when absent. */
  adapters?: string[]
  assert(result: ScenarioResult): void
}
