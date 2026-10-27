import { harnessAppError, type AddOptionMethod } from '../../../../shared/harness/types'
import { piInstanceId, piProviderIdOf } from '../../../../shared/providerInstances'
import { PiLoopAdapter, type PiChatClient } from '../../../run/adapters/pi/PiLoopAdapter'
import { decodeInstanceConfig, type DriverAddOption, type DriverContext, type DriverRuntime, type HarnessDriver, type InstanceConfig } from '../../driver'
import { PI_LEGACY_CAPS, piInstanceRuntime, type PiCredentials } from './engines/legacy'
import { createRpcRuntime, piRpcCaps, piRpcEvidenceOf, piRpcHasEvidence, type PiRpcDriverOptions } from './engines/rpc'
import { piEngineFor, piEngineOf, piEngineSwitchable, storedPiEngine } from './engines'
import { PI_NATIVE_TOOLS } from '../../pi/nativeTools'
import { piRetiredOf, piRetiredPrompt } from './retired'

export { PI_LEGACY_CAPS, type PiCredentials } from './engines/legacy'
export { PI_RPC_CAPS, PI_RPC_EXACT_CAPS, PI_RPC_NO_SHELL_CAPS, piRpcCaps, piRpcEvidenceLevel, piRpcHasEvidence, type PiRpcDriverOptions, type PiRpcEvidenceLevel } from './engines/rpc'
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
 * What Add provider offers for the model APIs: one option per pi-ai provider in the catalogue (its
 * sign-in methods merged), retired providers left out.
 */
function piAddOptions(credentials: PiCredentials | undefined): DriverAddOption[] {
  const byId = new Map<string, DriverAddOption>()
  let listed: ReturnType<NonNullable<PiCredentials['getLoginOptions']>> = []
  try {
    listed = credentials?.getLoginOptions?.() ?? []
  } catch {
    return []
  }
  for (const option of listed) {
    if (piRetiredOf(option.id)) continue
    const method: AddOptionMethod = option.authType === 'oauth' ? 'oauth' : option.ambient ? 'ambient' : 'api_key'
    let entry = byId.get(option.id)
    if (!entry) {
      let hasSavedKey = false
      try {
        hasSavedKey = Boolean(credentials?.has?.(option.id))
      } catch {
        /* an unreadable credential is not a saved key */
      }
      const ambient = credentials?.getAmbientProviderInfo?.(option.id)
      entry = {
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        methods: [],
        ...(ambient ? { ambientInfo: { label: ambient.label, instructions: [...ambient.instructions] } } : {}),
        config: { provider: option.id },
        hasSavedKey
      }
      byId.set(option.id, entry)
    }
    if (!entry.methods.includes(method)) entry.methods.push(method)
    if (method === 'api_key' && option.guidedLogin) entry.guidedKey = true
  }
  return [...byId.values()]
}

/**
 * A provider an entry can be added for: one Add provider offers, one with a saved credential, or
 * one the model catalogue registers (a custom provider with no sign-in of its own), so whatever
 * could be removed can be added back.
 */
function piProviderKnown(credentials: PiCredentials | undefined, providerId: string): boolean {
  if (piAddOptions(credentials).some((option) => option.id === providerId)) return true
  try {
    if (credentials?.has?.(providerId)) return true
    return credentials?.models?.getProviders().some((provider) => provider.id === providerId) ?? false
  } catch {
    return false
  }
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
  /** Definitions run on the RPC engine: the instance is on it, and its evidence (with or without the shell) passed here. */
  const definitionsOnRpc = (config: InstanceConfig): boolean =>
    piEngineOf(config, Boolean(options.rpc)) === 'rpc' && piRpcHasEvidence(piRpcEvidenceOf(options.rpc!))
  return {
    kind: 'pi',
    label: 'Mousse agent',
    binaryNames: [],
    multiInstance: false,
    // One entry per provider, under a fixed id: adding it again returns the entry.
    instanceIdFor: (patch) => {
      const providerId = patch.provider?.trim()
      if (!providerId) throw harnessAppError({ code: 'unsupported', message: 'Choose the model provider to add.' })
      if (piRetiredOf(providerId) || !piProviderKnown(credentials(), providerId))
        throw harnessAppError({ code: 'unsupported', message: `Mousse cannot add the model provider "${providerId}".` })
      return piInstanceId(providerId)
    },
    // Removing a model API deletes its saved key, as Remove always did.
    removeSignsOut: true,
    addOptions: () => piAddOptions(credentials()),
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
    caps: (config) => (piEngineOf(config, Boolean(options.rpc)) === 'rpc' ? piRpcCaps(piRpcEvidenceOf(options.rpc!)) : PI_LEGACY_CAPS),
    // The RPC engine's gate holds Pi's built-ins to a bot turn's authority (`/pi/gate`).
    botAuthority: (config) => piEngineOf(config, Boolean(options.rpc)) === 'rpc',
    nativeToolNames: (neutral, config) => (piEngineOf(config, Boolean(options.rpc)) === 'rpc' ? PI_NATIVE_TOOLS[neutral] ?? [] : []),
    // Agent definitions run on Pi's agent where its evidence suite passed, with or without the
    // contained shell (a fresh process and session per turn, the definition's system prompt, its
    // exact tools and limits: PR 4 4d-rpc). Without the contained shell (a no-shell record), a
    // definition's shell command asks a person first and an unattended one runs none.
    // Everywhere else, on the legacy engine, and for a definition that needs the loop (its browser),
    // they run on Mousse's loop as they always have, so nothing regresses.
    definitionCaps: (config, needs) => (definitionsOnRpc(config) && !needs?.loop ? piRpcCaps(piRpcEvidenceOf(options.rpc!)) : PI_LEGACY_CAPS),
    create(context: DriverContext): DriverRuntime {
      const providerId = piProviderIdOf(context.instanceId) ?? ''
      if (providerId && piEngineFor(providerId, piEngineOf(context.config, Boolean(options.rpc)), Boolean(options.rpc)) === 'rpc') {
        const runtime = createRpcRuntime(context, providerId, context.config.displayName ?? credentials()?.getProviderDisplayName?.(providerId) ?? providerId, credentials, options.rpc!)
        // The loop stays for definitions whose caps are the loop's (`definitionCaps`): the gateway picks per turn.
        return { ...runtime, definitionAdapter: adapter }
      }
      return piInstanceRuntime(context.instanceId, providerId, credentials, adapter)
    }
  }
}
