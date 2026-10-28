import { scenario as cancelledByAgent } from './cancelled-by-agent/input'
import { scenario as modelOptions } from './model-options/input'
import { scenario as plainTurn } from './plain-turn/input'
import { scenario as providerError } from './provider-error/input'
import { scenario as refusedByAgent } from './refused-by-agent/input'
import { scenario as slashCommand } from './slash-command/input'
import { scenario as steerMidTurn } from './steer-mid-turn/input'
import { scenario as stopMidStream } from './stop-mid-stream/input'
import { scenario as tokenLimit } from './token-limit/input'
import type { Scenario } from './types'

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  [plainTurn, steerMidTurn, stopMidStream, providerError, cancelledByAgent, refusedByAgent, tokenLimit, modelOptions, slashCommand].map((scenario) => [scenario.name, scenario])
)
