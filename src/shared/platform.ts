import type { WorkflowRunMethod } from './workflowRunPlatform'

export type PlatformRequestMethod = WorkflowRunMethod
  | 'workflows.list' | 'workflows.get' | 'workflows.getRevision' | 'workflows.create'
  | 'workflows.saveDraft' | 'workflows.publish' | 'workflows.archive'
  | 'workflows.duplicate' | 'workflows.importBundle' | 'workflows.exportBundle'
  | 'workflows.validate' | 'workflows.listRevisions' | 'workflows.restoreRevision'
  | 'agentDefinitions.list' | 'agentDefinitions.get' | 'agentDefinitions.create'
  | 'agentDefinitions.saveDraft' | 'agentDefinitions.publish' | 'agentDefinitions.archive'
  | 'agentDefinitions.duplicate' | 'agentDefinitions.importBundle'
  | 'agentDefinitions.exportBundle' | 'agentDefinitions.validate' | 'agentDefinitions.tryRun'
  | 'integrations.snapshot'
  | 'skills.create' | 'skills.update' | 'skills.editor' | 'skills.enable' | 'skills.archive'
  | 'skills.importPackage' | 'skills.exportPackage'
  | 'mcp.create' | 'mcp.update' | 'mcp.read' | 'mcp.enable' | 'mcp.delete'
  | 'mcp.testConnection' | 'mcp.beginAuth' | 'mcp.cancelAuth' | 'mcp.revokeAuth'

export interface PlatformRequestErrorShape {
  code: string
  message: string
  details?: unknown
}

export type PlatformResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: PlatformRequestErrorShape }

export interface PlatformRequestApi {
  request<T = unknown>(method: PlatformRequestMethod, params?: unknown): Promise<T>
}
