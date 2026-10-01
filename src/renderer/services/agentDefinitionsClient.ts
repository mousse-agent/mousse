import type { AgentPlatformRequester } from '../../shared/agentPlatform'
import type { AgentDefinitionsClient } from '../components/agentDefinitions/client'

/** Uses the host's profile-bound bridge; no local persistence or fixture fallback. */
export function createAgentDefinitionsClient(transport: AgentPlatformRequester): AgentDefinitionsClient {
  return {
    list: (params) => transport.request('agentDefinitions.list', params),
    get: (params) => transport.request('agentDefinitions.get', params),
    create: (params) => transport.request('agentDefinitions.create', params),
    saveDraft: (params) => transport.request('agentDefinitions.saveDraft', params),
    publish: (params) => transport.request('agentDefinitions.publish', params),
    archive: (params) => transport.request('agentDefinitions.archive', params),
    duplicate: (params) => transport.request('agentDefinitions.duplicate', params),
    importBundle: (params) => transport.request('agentDefinitions.importBundle', params),
    exportBundle: (params) => transport.request('agentDefinitions.exportBundle', params),
    validate: (params) => transport.request('agentDefinitions.validate', params),
    tryRun: (params) => transport.request('agentDefinitions.tryRun', params)
  }
}
