import { piProviderIdOf } from '../../../../shared/providerInstances'
import { PiLoopAdapter, type PiChatClient } from '../../../run/adapters/pi/PiLoopAdapter'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig } from '../../driver'
import { PI_LEGACY_CAPS, piInstanceRuntime, type PiCredentials } from './engines/legacy'
import { PI_RPC_CAPS, createRpcRuntime, type PiRpcDriverOptions } from './engines/rpc'

export { PI_LEGACY_CAPS, type PiCredentials } from './engines/legacy'
export { PI_RPC_CAPS, type PiRpcDriverOptions } from './engines/rpc'

/** The engine an instance runs on: `rpc` only when its config asks for it (2b-2 keeps `legacy`). */
export function piEngineOf(config: InstanceConfig, rpcAvailable: boolean): 'rpc' | 'legacy' {
  return config.engine === 'rpc' && rpcAvailable ? 'rpc' : 'legacy'
}

function decodePiConfig(raw: Record<string, unknown> | undefined): InstanceConfig {
  const config = decodeInstanceConfig(raw, { privateHome: false })
  if (raw?.engine === 'rpc' || raw?.engine === 'legacy') config.engine = raw.engine
  return config
}

/**
 * The `pi` driver: every `pi:<provider>` instance. Two engines share one stored kind:
 * - `legacy`, the in-process pi-ai loop (`LlmClient`), shared by the profile;
 * - `rpc`, Pi's agent as its own process per thread (`harness/pi/engine.ts`), when the instance's
 *   config says `engine: 'rpc'` and the profile gave the driver its `rpc` options.
 *
 * An instance on the RPC engine, built-in ones included, has a Mousse-owned home under its state
 * dir (Pi's agent dir); one on the legacy loop keeps its home, which the loop does not read.
 */
export function piDriver(options: { client: () => PiChatClient; credentials?: () => PiCredentials | undefined; rpc?: PiRpcDriverOptions }): HarnessDriver {
  // One loop adapter for every legacy pi instance: the loop resolves the provider per turn.
  const adapter = new PiLoopAdapter(options.client)
  const credentials = () => options.credentials?.()
  return {
    kind: 'pi',
    label: 'Mousse agent',
    binaryNames: [],
    multiInstance: false,
    privateHome: false,
    // Pi's agent dir is the instance's state-dir home. The legacy loop reads no home, so its
    // instances keep theirs (`default`) and their bindings stay valid.
    alwaysPrivateHome: (config) => piEngineOf(config, Boolean(options.rpc)) === 'rpc',
    canInstall: false,
    // The loop runs a custom model with its provider's transport (`customModelDefinition`).
    customModels: true,
    // Chat titles: one pi-ai request in Mousse's process (`runPiOneShot`).
    oneShot: true,
    methodLabel: 'API key or sign-in',
    // The RPC engine's extension stamps the attempt token on every Mousse call (the legacy loop has no MCP).
    mcpTurnBinding: 'per_call',
    // The pi loop calls the app tools in process and proxies the user's MCP servers.
    userMcp: 'proxy',
    decodeConfig: decodePiConfig,
    caps: (config) => (piEngineOf(config, Boolean(options.rpc)) === 'rpc' ? PI_RPC_CAPS : PI_LEGACY_CAPS),
    create(context: DriverContext): DriverRuntime {
      const providerId = piProviderIdOf(context.instanceId) ?? ''
      if (piEngineOf(context.config, Boolean(options.rpc)) === 'rpc' && providerId)
        return createRpcRuntime(context, providerId, context.config.displayName ?? credentials()?.getProviderDisplayName?.(providerId) ?? providerId, credentials, options.rpc!)
      return piInstanceRuntime(context.instanceId, providerId, credentials, adapter)
    }
  }
}
