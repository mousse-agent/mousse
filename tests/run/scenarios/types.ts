import type { ScenarioResult } from './runScenario'

/** One replay scenario: the prompt sent and what every adapter's run must produce. */
export interface Scenario {
  name: string
  prompt: string
  assert(result: ScenarioResult): void
}
