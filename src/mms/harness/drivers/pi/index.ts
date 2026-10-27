import { harnessAppError, type AddOptionMethod } from '../../../../shared/harness/types'
import { piInstanceId, piProviderIdOf } from '../../../../shared/providerInstances'
import { foldedInto } from '../../../../shared/harness/move'
import type { ProviderAdapter } from '../../../run/adapters/ProviderAdapter'
import { decodeInstanceConfig, type DriverAddOption, type DriverContext, type DriverRuntime, type HarnessDriver } from '../../driver'
import { piInstanceRuntime, type PiCredentials } from './instance'
import { createRpcRuntime, PI_RPC_CAPS, piRpcCaps, piRpcEvidenceOf, type PiRpcDriverOptions } from './engines/rpc'
import { PI_NATIVE_TOOLS } from '../../pi/nativeTools'
import { piRetiredOf, piRetiredPrompt } from './retired'

export type { PiCredentials } from './instance'
export { PI_RPC_CAPS, PI_RPC_EXACT_CAPS, PI_RPC_NO_SHELL_CAPS, piRpcCaps, piRpcEvidenceLevel, piRpcHasEvidence, type PiRpcDriverOptions, type PiRpcEvidenceLevel } from './engines/rpc'
export { PI_NATIVE_TOOLS } from '../../pi/nativeTools'
export { PI_RETIRED, piRetiredOf } from './retired'

/**
 * A build without Pi's packaged runtime (no `rpc` options): the instance keeps its sign-in and
 * models, and every turn is refused with the reason.
 */
function noRuntimeAdapter(): ProviderAdapter {
  return {
    driver: 'pi',
    capabilities: {
      steer: PI_RPC_CAPS.steer,
      interrupt: PI_RPC_CAPS.interrupt,
      rollback: PI_RPC_CAPS.rollback,
      fork: PI_RPC_CAPS.fork,
      events: PI_RPC_CAPS.events,
      containment: PI_RPC_CAPS.containment,
      historyInjection: PI_RPC_CAPS.historyInjection,
      mcp: PI_RPC_CAPS.mcp,
      childPolicy: PI_RPC_CAPS.childPolicy
    },
    startTurn: async (input) => {
      throw harnessAppError({ code: 'unsupported', message: 'This build of Mousse has no Pi runtime, so it cannot run this model. Install a build that includes it.', instanceId: input.instanceId })
    },
    interrupt: async () => 'not_active'
  }
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
        hasSavedKey,
        ...(foldedInto(option.id) ? { runsAs: foldedInto(option.id) } : {})
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
 * The `pi` driver: every `pi:<provider>` instance, on Pi's agent as its own process per thread
 * (`harness/pi/engine.ts`) once the profile gave the driver its `rpc` options (the packaged runtime
 * exists); without them every turn is refused. `openai-codex` and `cursor` are retired
 * (`retired.ts`). Each instance has a Mousse-owned home under its state dir (Pi's agent dir).
 *
 * A stored `engine` (the removed Advanced → Engine setting) is ignored and dropped on the next write.
 */
export function piDriver(options: { credentials?: () => PiCredentials | undefined; rpc?: PiRpcDriverOptions } = {}): HarnessDriver {
  const credentials = () => options.credentials?.()
  const caps = () => (options.rpc ? piRpcCaps(piRpcEvidenceOf(options.rpc)) : PI_RPC_CAPS)
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
    verifyAmbient: async (patch) => {
      const providerId = patch.provider?.trim()
      const auth = credentials()
      if (!providerId || !auth?.verifyAmbientProvider) return { success: false, error: 'Mousse has no provider credentials loaded yet.' }
      return auth.verifyAmbientProvider(providerId)
    },
    addOptions: () => piAddOptions(credentials()),
    privateHome: false,
    // Pi's agent dir is the instance's state-dir home.
    alwaysPrivateHome: true,
    canInstall: false,
    // A custom model runs with its provider's transport (`customModelDefinition`).
    customModels: true,
    // Chat titles: one pi-ai request in Mousse's process (`runPiOneShot`).
    oneShot: true,
    methodLabel: 'API key or sign-in',
    // The engine's extension stamps the attempt token on every Mousse call.
    mcpTurnBinding: 'per_call',
    // Pi's agent reaches the user's MCP servers through Mousse's MCP server.
    userMcp: 'proxy',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    retired: (instanceId) => {
      const retired = piRetiredOf(piProviderIdOf(instanceId))
      return retired ? piRetiredPrompt(retired) : undefined
    },
    // Where the evidence suite passed for this platform and Pi version, `exact` tool control (with or
    // without the contained shell); elsewhere `approval_only`, so agent definitions are refused there
    // with a typed reason. With a no-shell record, a definition's shell asks a person first and an
    // unattended one runs none (`PiRpcEngine.gate`).
    caps,
    // The engine's gate holds Pi's built-ins to a bot turn's authority (`/pi/gate`).
    botAuthority: () => Boolean(options.rpc),
    nativeToolNames: (neutral) => (options.rpc ? PI_NATIVE_TOOLS[neutral] ?? [] : []),
    create(context: DriverContext): DriverRuntime {
      const providerId = piProviderIdOf(context.instanceId) ?? ''
      if (providerId && options.rpc)
        return createRpcRuntime(context, providerId, context.config.displayName ?? credentials()?.getProviderDisplayName?.(providerId) ?? providerId, credentials, options.rpc)
      return piInstanceRuntime(context.instanceId, providerId, credentials, noRuntimeAdapter())
    }
  }
}
