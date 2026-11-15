import type { NodeId } from '../../../shared/net'
import { ROUTED_AGENT_METHODS } from '../../../shared/bridge/routed'
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
    takesAgentMark: async (node) => {
      const versions = await client.versionsOrRefusal(node as NodeId)
      return Object.entries(ROUTED_AGENT_METHODS).every(([method, since]) => (versions?.[method] ?? 0) >= since)
    },
    projectCandidates: async (node, projectPath, signal) => {
      const identity = await repositoryIdentitiesFor(services).of(projectPath)
      if (!identity) return null
      const found = await client.call(node as NodeId, 'projects.match', { roots: identity.roots, remotes: identity.remotes }, { ...(signal ? { signal } : {}) })
      const listed = isRecord(found) && Array.isArray(found.candidates) ? found.candidates : []
      return {
        match: isRecord(found) && typeof found.projectId === 'string' ? { projectId: found.projectId, weak: found.weak === true } : null,
        candidates: listed.flatMap((entry) =>
          isRecord(entry) && typeof entry.projectId === 'string'
            ? [{ projectId: entry.projectId, ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}), ...(entry.weak === true ? { weak: true } : {}) }]
            : [])
      }
    },
    matchProject: async (node, projectPath, signal) => {
      const identity = await repositoryIdentitiesFor(services).of(projectPath)
      if (!identity) return null
      const found = await client.call(node as NodeId, 'projects.match', { roots: identity.roots, remotes: identity.remotes }, { ...(signal ? { signal } : {}) })
      return isRecord(found) && typeof found.projectId === 'string' ? { projectId: found.projectId, weak: found.weak === true } : null
    }
  }
}
