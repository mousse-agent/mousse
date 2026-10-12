import { scenario as plainTurn } from './plain-turn/input'
import { scenario as providerError } from './provider-error/input'
import { scenario as steerMidTurn } from './steer-mid-turn/input'
import { scenario as stopMidStream } from './stop-mid-stream/input'
import type { Scenario } from './types'

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  [plainTurn, steerMidTurn, stopMidStream, providerError].map((scenario) => [scenario.name, scenario])
)
