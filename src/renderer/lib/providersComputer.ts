import { createContext, useContext } from 'react'
import type { InstanceSnapshot, ModelRefreshResult } from '../../shared/harness/status'
import type {
  AddInstanceInput,
  InstanceConfigPatch,
  ModelPrefsPatch,
  ProviderAddOption,
  ProviderOperationStarted,
  ProviderScope,
  RegistryAgentView,
  RemoveInstallResult,
  SignInResponse
} from '../../shared/harness/types'

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
}

/** This computer's calls, looked up when made (a page renders before, and without, a window bridge). */
const LOCAL: ProvidersApi = {
  snapshots: (scope) => window.mousse.providers.snapshots(scope),
  catalog: { addOptions: () => window.mousse.providers.catalog.addOptions() },
  registry: { search: (query) => window.mousse.providers.registry.search(query) },
  instances: new Proxy({} as ProvidersApi['instances'], {
    get: (_target, key) => (...args: unknown[]) =>
      (window.mousse.providers.instances as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[key]!(...args)
  })
}

/**
 * The calls for `node`, or for this computer without one. A remote call names the computer, and the service
 * of this computer sends it there; a key passed to `setSecret` goes there in that call and nowhere else.
 */
export function providersApi(node?: string): ProvidersApi {
  if (!node) return LOCAL
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    window.mousse.providers.remote<T>(node, `providers.${method}`, params)
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
      install: (instanceId) => call('instances.install', { instanceId }),
      removeInstall: (instanceId, force = false) => call('instances.removeInstall', { instanceId, force }),
      cancelInstall: (operationId) => call('instances.cancelInstall', { operationId }),
      update: (instanceId) => call('instances.update', { instanceId }),
      signIn: (instanceId, method) => call('instances.signIn', { instanceId, ...(method ? { method } : {}) }),
      respondSignIn: (operationId, response) => call('instances.respondSignIn', { operationId, response }),
      signOut: (instanceId) => call('instances.signOut', { instanceId }),
      allowKnownProblem: (instanceId, version) => call('instances.allowKnownProblem', { instanceId, version }),
      recheck: (instanceId) => call('instances.recheck', { instanceId }),
      refreshModels: (instanceId) => call('instances.refreshModels', { instanceId }),
      refreshAllModels: () => call('instances.refreshAllModels'),
      setModelPrefs: (instanceId, patch) => call('instances.setModelPrefs', { instanceId, patch })
    }
  }
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
