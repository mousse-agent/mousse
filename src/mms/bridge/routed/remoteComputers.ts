import type { NodeId } from '../../../shared/net'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { RemoteComputer, RemoteComputersPort } from '../../protocol/remoteComputersPort'
import { repositoryIdentitiesFor } from '../remote/repositoryIdentity'
import type { RoutedClient } from './RoutedClient'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The Bridge side of remote subagents (issue #469): the user's other computers as the router lists them,
 * and the router's own client for calls to one of them. The calls are routed calls (`shared/bridge/routed.ts`),
 * so the other computer treats them as it treats a window of this computer: its switch for working on its
 * threads and the permission limit it set for this one apply.
 */
export function remoteComputersPort(options: {
  services: MmsProfileServices
  client: RoutedClient
  computers: () => Array<{ node: NodeId; name: string }> | undefined
  online: (node: NodeId) => boolean
}): RemoteComputersPort {
  const { services, client } = options
  return {
    computers: (): RemoteComputer[] | undefined =>
      options.computers()?.map(({ node, name }) => ({ node, name, online: options.online(node) })),
    call: (node, method, params, callOptions) => client.call(node as NodeId, method, params, callOptions),
    matchProject: async (node, projectPath, signal) => {
      const identity = await repositoryIdentitiesFor(services).of(projectPath)
      if (!identity) return null
      const found = await client.call(node as NodeId, 'projects.match', { roots: identity.roots, remotes: identity.remotes }, { ...(signal ? { signal } : {}) })
      return isRecord(found) && typeof found.projectId === 'string' ? { projectId: found.projectId, weak: found.weak === true } : null
    }
  }
}
