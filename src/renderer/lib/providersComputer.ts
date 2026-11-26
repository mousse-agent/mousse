import { createContext, useContext } from 'react'
import type { InstanceSnapshot, ModelRefreshResult } from '../../shared/harness/status'
import type {
  AddInstanceInput,
  InstanceConfigPatch,
  ModelPrefsPatch,
  ProviderAddOption,
  ProviderEventsReply,
  ProviderOperationStarted,
  ProviderScope,
  RegistryAgentView,
  RemoveInstallResult,
  SignInResponse
} from '../../shared/harness/types'
import type { LocalCheckToolsInput, LocalCheckToolsResult, LocalConnectInput, LocalConnectResult, LocalServerRow, LocalSetModelInput } from '../../shared/localServers'

/**
 * The calls of Settings → Providers, on this computer or on another one. Another computer takes the same calls
 * through its routed rows, so the page and its parts use one set of calls whichever computer they show.
 */
export interface ProvidersApi {
  snapshots(scope: ProviderScope): Promise<InstanceSnapshot[]>
  catalog: { addOptions(): Promise<ProviderAddOption[]> }
  registry: { search(query: string): Promise<RegistryAgentView[]> }
  instances: {
    add(input: AddInstanceInput): Promise<InstanceSnapshot>
    setSecret(instanceId: string, value: string): Promise<InstanceSnapshot>
    remove(instanceId: string): Promise<void>
    configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot>
    setEnabled(instanceId: string, enabled: boolean): Promise<InstanceSnapshot>
    install(instanceId: string): Promise<ProviderOperationStarted>
    removeInstall(instanceId: string, force?: boolean): Promise<RemoveInstallResult>
    cancelInstall(operationId: string): Promise<boolean>
    update(instanceId: string): Promise<ProviderOperationStarted>
    signIn(instanceId: string, method?: string): Promise<ProviderOperationStarted>
    respondSignIn(operationId: string, response: SignInResponse): Promise<boolean>
    signOut(instanceId: string): Promise<InstanceSnapshot>
    allowKnownProblem(instanceId: string, version: string): Promise<InstanceSnapshot>
    recheck(instanceId: string): Promise<InstanceSnapshot>
    refreshModels(instanceId: string): Promise<InstanceSnapshot>
    refreshAllModels(): Promise<ModelRefreshResult[]>
    setModelPrefs(instanceId: string, patch: ModelPrefsPatch): Promise<InstanceSnapshot>
  }
  /** Model servers running on that computer (Add provider → Local models). Detection runs only when called. */
  local: {
    detect(): Promise<LocalServerRow[]>
    connect(input: LocalConnectInput): Promise<LocalConnectResult>
    setModel(input: LocalSetModelInput): Promise<boolean>
    checkTools(input: LocalCheckToolsInput): Promise<LocalCheckToolsResult>
  }
}

/** This computer's calls, looked up when made (a page renders before, and without, a window bridge). */
const LOCAL: ProvidersApi = {
  snapshots: (scope) => window.mousse.providers.snapshots(scope),
  catalog: { addOptions: () => window.mousse.providers.catalog.addOptions() },
  registry: { search: (query) => window.mousse.providers.registry.search(query) },
  instances: new Proxy({} as ProvidersApi['instances'], {
    get: (_target, key) => (...args: unknown[]) =>
      (window.mousse.providers.instances as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[key]!(...args)
  }),
  local: {
    detect: () => window.mousse.providers.local.detect(),
    connect: (input) => window.mousse.providers.local.connect(input),
    setModel: (input) => window.mousse.providers.local.setModel(input),
    checkTools: (input) => window.mousse.providers.local.checkTools(input)
  }
}

/**
 * The calls for `node`, or for this computer without one. A remote call names the computer, and the service
 * of this computer sends it there; a key passed to `setSecret` goes there in that call and nowhere else.
 */
export function providersApi(node?: string): ProvidersApi {
  if (!node) return LOCAL
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    window.mousse.providers.remote<T>(node, `providers.${method}`, params)
  // What happens to an operation started there is read with `providers.events`, for the operations started here only.
  const started = async (method: string, params: Record<string, unknown>): Promise<ProviderOperationStarted> => {
    const operation = await call<ProviderOperationStarted>(method, params)
    noteStarted(node, operation.operationId)
    return operation
  }
  return {
    // Another computer's page shows that computer's own list.
    snapshots: () => call('snapshots', { scope: { kind: 'device' } }),
    catalog: { addOptions: () => call('catalog.addOptions') },
    registry: { search: (query) => call('registry.search', { query }) },
    instances: {
      add: (input) => call('instances.add', { ...input }),
      setSecret: (instanceId, value) => call('instances.setSecret', { instanceId, value }),
      remove: async (instanceId) => {
        await call('instances.remove', { instanceId })
      },
      configure: (instanceId, patch) => call('instances.configure', { instanceId, patch }),
      setEnabled: (instanceId, enabled) => call('instances.setEnabled', { instanceId, enabled }),
      install: (instanceId) => started('instances.install', { instanceId }),
      removeInstall: (instanceId, force = false) => call('instances.removeInstall', { instanceId, force }),
      cancelInstall: (operationId) => call('instances.cancelInstall', { operationId }),
      update: (instanceId) => started('instances.update', { instanceId }),
      signIn: (instanceId, method) => started('instances.signIn', { instanceId, ...(method ? { method } : {}) }),
      respondSignIn: (operationId, response) => call('instances.respondSignIn', { operationId, response }),
      signOut: (instanceId) => call('instances.signOut', { instanceId }),
      allowKnownProblem: (instanceId, version) => call('instances.allowKnownProblem', { instanceId, version }),
      recheck: (instanceId) => call('instances.recheck', { instanceId }),
      refreshModels: (instanceId) => call('instances.refreshModels', { instanceId }),
      refreshAllModels: () => call('instances.refreshAllModels'),
      setModelPrefs: (instanceId, patch) => call('instances.setModelPrefs', { instanceId, patch })
    },
    // Found on that computer's own loopback; a server's key goes there in `connect` and nowhere else.
    local: {
      detect: () => call('local.detect'),
      connect: (input) => call('local.connect', { ...input }),
      setModel: (input) => call('local.setModel', { ...input }),
      checkTools: (input) => call('local.checkTools', { ...input })
    }
  }
}

/** Operations this window started on other computers, by computer. */
const startedOn = new Map<string, Set<string>>()
const startListeners = new Set<(node: string, operationId: string) => void>()

function noteStarted(node: string, operationId: string): void {
  let ids = startedOn.get(node)
  if (!ids) startedOn.set(node, (ids = new Set()))
  ids.add(operationId)
  // A window starts a handful of operations: the oldest give way past a few hundred.
  if (ids.size > 256) ids.delete(ids.values().next().value!)
  for (const listener of startListeners) listener(node, operationId)
}

/** Whether this window started the operation on `node`. */
export function startedRemotely(node: string, operationId: string): boolean {
  return startedOn.get(node)?.has(operationId) === true
}

/** Calls `listener` each time this window starts an operation on another computer. */
export function onRemoteOperationStarted(listener: (node: string, operationId: string) => void): () => void {
  startListeners.add(listener)
  return () => startListeners.delete(listener)
}

/**
 * `providers.events` of `node`: without `after`, only where its entries stand now; with it, the entries after it.
 * Answered from that computer's memory, never from a stream or a ledger.
 */
export function readRemoteProviderEvents(node: string, after?: number): Promise<ProviderEventsReply> {
  return window.mousse.providers.remote<ProviderEventsReply>(node, 'providers.events', after === undefined ? {} : { after })
}

/** The computer Settings → Providers shows: none for this one, else another computer by its node and name. */
export interface ProvidersComputer {
  node?: string
  name?: string
}

export const ProvidersComputerContext = createContext<ProvidersComputer>({})

/** The computer the providers page shows, and the calls that act on it. */
export function useProvidersComputer(): ProvidersComputer & { api: ProvidersApi } {
  const computer = useContext(ProvidersComputerContext)
  return { ...computer, api: providersApi(computer.node) }
}
