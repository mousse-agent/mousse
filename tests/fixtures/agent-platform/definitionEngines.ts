import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import type { Harness } from '../../../src/mms/harness/gateway'
import type { OrchestratorService } from '../../../src/mms/orchestrator/OrchestratorService'
import type { AdapterHost, TurnInput } from '../../../src/mms/harness/adapter'
import { installExactDefinitionRuntime } from './exactDefinitionRuntime'

/**
 * The runtime definition tests run on (PR 4 §6): a stand-in for Pi RPC with evidence, which holds
 * definitions with `toolControl: 'exact'`: every tool call passes the definition's authority first,
 * as Pi's gate does. It sits beside a Claude Code-like instance (`claude`) that only asks for approval.
 */
export const ENGINE_MODEL = 'recorder-model'

export interface DefinitionEngine {
  /** For the orchestrator's constructor: the profile's provider credentials (none are read). */
  providerAuth: never
  /** Every turn the engine's runtime was given, with its host. */
  turns: Array<{ input: TurnInput; host: AdapterHost }>
  /** The model's replies, in order (or `setNext`). */
  outputs: AssistantMessage[]
  /** What each model request carried: its system prompt, messages and tools. */
  captured: Context[]
  setNext(next: ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>) | undefined): void
  install(orchestrator: OrchestratorService, profileHome: string): Harness
  close(): Promise<void>
}

export async function createDefinitionEngine(providers: string[]): Promise<DefinitionEngine> {
  const turns: DefinitionEngine['turns'] = []
  const outputs: AssistantMessage[] = []
  const captured: Context[] = []
  let custom: ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>) | undefined
  const next = async (context: Context, signal: AbortSignal): Promise<AssistantMessage> => {
    if (custom) return custom(context, signal)
    const reply = outputs.shift()
    if (!reply) throw new Error('fixture provider exhausted')
    return reply
  }
  return {
    providerAuth: {} as never, turns, outputs, captured,
    setNext: (value) => { custom = value },
    install: (orchestrator, profileHome) =>
      installExactDefinitionRuntime({ orchestrator, providerId: providers[0]!, alsoProviders: providers.slice(1), profileHome, captured, next, turns }).harness,
    close: async () => {}
  }
}
