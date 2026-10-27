import { piProviderIdOf } from '../../../../shared/providerInstances'
import { PiLoopAdapter, type PiChatClient } from '../../../run/adapters/pi/PiLoopAdapter'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig } from '../../driver'
import { PI_LEGACY_CAPS, piInstanceRuntime, type PiCredentials } from './engines/legacy'
import { PI_RPC_CAPS, createRpcRuntime, type PiRpcDriverOptions } from './engines/rpc'
import { piEngineFor, piEngineOf, piEngineSwitchable, storedPiEngine } from './engines'
import { PI_NATIVE_TOOLS } from '../../pi/nativeTools'
import { piRetiredOf, piRetiredPrompt } from './retired'

export { PI_LEGACY_CAPS, type PiCredentials } from './engines/legacy'
export { PI_RPC_CAPS, type PiRpcDriverOptions } from './engines/rpc'
export { PI_LEGACY_ONLY, piEngineFor, piEngineOf } from './engines'
export { PI_NATIVE_TOOLS } from '../../pi/nativeTools'
export { PI_RETIRED, piRetiredOf } from './retired'

/**
 * Decoded with the instance id, `engine` is the engine in effect (`engines.ts`); without it (a
 * patch, the bare route) only the stored choice, so an unresolved config runs on the loop.
 */
function decodePiConfig(raw: Record<string, unknown> | undefined, instanceId: string | undefined, rpcAvailable: boolean): InstanceConfig {
  const config = decodeInstanceConfig(raw, { privateHome: false })
  const stored = storedPiEngine(raw)
  const providerId = instanceId ? piProviderIdOf(instanceId) : undefined
  const engine = providerId ? piEngineFor(providerId, stored, rpcAvailable) : stored
  if (engine) config.engine = engine
  return config
}

/**
 * The `pi` driver: every `pi:<provider>` instance. Two engines share one stored kind:
 * - `legacy`, the in-process pi-ai loop (`LlmClient`), shared by the profile: the default, and
 *   always for the bare route (`openai-codex` and `cursor` are retired: `retired.ts`);
 * - `rpc`, Pi's agent as its own process per thread (`harness/pi/engine.ts`), for an instance the
 *   user switched to it (Advanced → Engine: New engine), once the profile gave the driver its `rpc`
 *   options (the packaged runtime exists).
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
    decodeConfig: (raw, instanceId) => decodePiConfig(raw, instanceId, Boolean(options.rpc)),
    engine: (instanceId, stored) => {
      const providerId = piProviderIdOf(instanceId) ?? ''
      return { effective: piEngineFor(providerId, storedPiEngine(stored), Boolean(options.rpc)), switchable: piEngineSwitchable(providerId, Boolean(options.rpc)) }
    },
    retired: (instanceId) => {
      const retired = piRetiredOf(piProviderIdOf(instanceId))
      return retired ? piRetiredPrompt(retired) : undefined
    },
    caps: (config) => (piEngineOf(config, Boolean(options.rpc)) === 'rpc' ? PI_RPC_CAPS : PI_LEGACY_CAPS),
    // The RPC engine's gate holds Pi's built-ins to a bot turn's authority (`/pi/gate`).
    botAuthority: (config) => piEngineOf(config, Boolean(options.rpc)) === 'rpc',
    nativeToolNames: (neutral, config) => (piEngineOf(config, Boolean(options.rpc)) === 'rpc' ? PI_NATIVE_TOOLS[neutral] ?? [] : []),
    // Agent definitions run on Mousse's loop on either engine: Pi RPC cannot hold a definition yet
    // (it only asks for approval and has no session of a turn's own), so nothing regresses until
    // PR 4 unit 4d-rpc moves them. The loop runs a definition the way it always has.
    definitionCaps: () => PI_LEGACY_CAPS,
    create(context: DriverContext): DriverRuntime {
      const providerId = piProviderIdOf(context.instanceId) ?? ''
      if (providerId && piEngineFor(providerId, piEngineOf(context.config, Boolean(options.rpc)), Boolean(options.rpc)) === 'rpc')
        return { ...createRpcRuntime(context, providerId, context.config.displayName ?? credentials()?.getProviderDisplayName?.(providerId) ?? providerId, credentials, options.rpc!), definitionAdapter: adapter }
      return piInstanceRuntime(context.instanceId, providerId, credentials, adapter)
    }
  }
}
