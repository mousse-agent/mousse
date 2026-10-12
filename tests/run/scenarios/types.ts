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
  /**
   * Turns sent before `prompt` on the scenario thread, each pinned to an adapter's model selection
   * (SPEC §16: a provider switch, a fork source). Their frames come first in the fixture; `prompt`
   * then runs pinned to the fixture's adapter.
   */
  before?: Array<{ adapter: string; prompt: string }>
  /** Fork the thread after the `before` turns (`thread.fork`, latest stable run) and send `prompt` on the fork. */
  fork?: boolean
  assert(result: ScenarioResult): void
}
