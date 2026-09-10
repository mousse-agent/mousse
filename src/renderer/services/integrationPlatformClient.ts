import type { IntegrationPlatformClient, IntegrationPlatformRequester } from '../../shared/integrationPlatform'

/** Thin adapter to the host's admitted profile connection. No local catalog fallback. */
export function createIntegrationPlatformClient(transport: IntegrationPlatformRequester): IntegrationPlatformClient {
  return {
    snapshot: (params) => transport.request('integrations.snapshot', params),
    createSkill: (params) => transport.request('skills.create', params),
    updateSkill: (params) => transport.request('skills.update', params),
    skillEditor: (params) => transport.request('skills.editor', params),
    enableSkill: (params) => transport.request('skills.enable', params),
    archiveSkill: (params) => transport.request('skills.archive', params),
    importSkill: (params) => transport.request('skills.importPackage', params),
    exportSkill: (params) => transport.request('skills.exportPackage', params),
    createMcp: (params) => transport.request('mcp.create', params),
    updateMcp: (params) => transport.request('mcp.update', params),
    readMcp: (params) => transport.request('mcp.read', params),
    enableMcp: (params) => transport.request('mcp.enable', params),
    deleteMcp: (params) => transport.request('mcp.delete', params),
    testMcp: (params) => transport.request('mcp.testConnection', params),
    beginMcpAuth: (params) => transport.request('mcp.beginAuth', params),
    cancelMcpAuth: (params) => transport.request('mcp.cancelAuth', params),
    revokeMcpAuth: (params) => transport.request('mcp.revokeAuth', params)
  }
}
