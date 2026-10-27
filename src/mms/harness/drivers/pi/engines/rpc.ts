import type { HarnessCaps } from '../../../../../shared/harness/types'
import type { DriverContext, DriverRuntime } from '../../../driver'
import { PiRpcEngine, type PiEngineCatalog, type PiMousseTool, type PiRpcEngineOptions } from '../../../pi/engine'
import type { PiRuntimePaths } from '../../../pi/launch'
import { piShellPath } from '../../../pi/settings'
import { piInstanceRuntime, type PiCredentials } from './legacy'

/**
 * Pi's agent as its own process (PR 2 §4). Off by default in 2b-2: an instance runs on it only with
 * `config.engine: 'rpc'`.
 *
 * - Containment and tool control stay `weak`/`approval_only` until the evidence suite passes on the
 *   whole execution profile: Mousse sees and can refuse every call, but does not run the tools.
 * - `budgets: 'hard'`: every model request is charged through the guarded request wrapper
 *   (`/pi/request`) and every tool call at the gate, and the next one is refused before it starts
 *   once a turn or tool-call limit is reached.
 * - `spendLimits: 'reserved'`: under a token or USD limit every request is reserved first at its
 *   final wire cap, sized to fit what is left, and its final payload is checked before it is sent
 *   (PR 4 §5b). A model whose API does not always send the cap, or an unpriced model under a USD
 *   limit, or an effort whose smallest request cannot fit the limit, is refused at admission
 *   (`spendModel`).
 * - `fork: 'portable'` until the native fork is wired (a fork hands the history over).
 */
export const PI_RPC_CAPS: HarnessCaps = Object.freeze({
  steer: 'native',
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  childPolicy: 'enforced',
  planMode: true,
  contextUsage: 'reported',
  toolControl: 'approval_only',
  budgets: 'hard',
  spendLimits: 'reserved'
})

/** What the RPC engine needs from the profile. */
export interface PiRpcDriverOptions {
  /** The packaged runtime (`piRuntimePaths(applicationRoot)`). */
  runtime(): PiRuntimePaths
  /** The instance provider's full Mousse catalogue and its revision. */
  catalog(providerId: string): PiEngineCatalog
  /** The stored key of a provider, if it has one. */
  apiKey?(providerId: string): string | undefined
  /** Mousse's tools for a thread, with their class. */
  mousseTools?(threadId: string): PiMousseTool[]
  /** Test seams passed through to the engine. */
  engine?: Partial<Pick<PiRpcEngineOptions, 'warmMs' | 'readyDeadlineMs' | 'commandDeadlineMs' | 'settings' | 'host' | 'adjustLaunch' | 'onCommand' | 'testEnv'>>
}

export function createRpcRuntime(context: DriverContext, providerId: string, label: string, credentials: () => PiCredentials | undefined, options: PiRpcDriverOptions): DriverRuntime {
  const capabilities = PI_RPC_CAPS
  const engine = new PiRpcEngine({
    instanceId: context.instanceId,
    provider: providerId,
    label,
    capabilities: {
      steer: capabilities.steer,
      interrupt: capabilities.interrupt,
      rollback: capabilities.rollback,
      fork: capabilities.fork,
      events: capabilities.events,
      containment: capabilities.containment,
      historyInjection: capabilities.historyInjection,
      mcp: capabilities.mcp,
      childPolicy: capabilities.childPolicy
    },
    env: () => context.env,
    stateDir: context.stateDir,
    runtime: () => options.runtime(),
    catalog: () => options.catalog(providerId),
    ...(options.apiKey ? { apiKey: () => options.apiKey!(providerId) } : {}),
    ...(context.config.env ? { extraEnv: () => context.config.env } : {}),
    shellPath: () => piShellPath({ env: context.env.env }),
    ...(options.mousseTools ? { mousseTools: (threadId: string) => options.mousseTools!(threadId) } : {}),
    ...options.engine
  })
  const base = piInstanceRuntime(context.instanceId, providerId, credentials, engine)
  return {
    ...base,
    spendModel: (model) => engine.spendModel(model),
    forgetConversation: (threadId) => engine.forgetConversation(threadId),
    terminate: (ref) => engine.terminate(ref),
    stop: () => engine.stop()
  }
}

