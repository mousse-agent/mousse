import type { CompiledWorkflow, WorkflowDraftRecord, WorkflowHeadManifest, WorkflowListItem } from './workflows'
import type { WorkflowWireBundle } from './workflows/wire'

export const WORKFLOW_DEFINITIONS_CAPABILITY = 'workflows.definitions.v1'
export const WORKFLOW_DEFINITION_METHODS = [
  'workflows.list', 'workflows.get', 'workflows.getRevision', 'workflows.create',
  'workflows.saveDraft', 'workflows.publish', 'workflows.archive', 'workflows.duplicate',
  'workflows.importBundle', 'workflows.exportBundle', 'workflows.validate',
  'workflows.listRevisions', 'workflows.restoreRevision'
] as const
export type WorkflowDefinitionMethod = (typeof WORKFLOW_DEFINITION_METHODS)[number]
export interface WorkflowPlatformRequester {
  request<T>(method: WorkflowDefinitionMethod, params: unknown): Promise<T>
}
export interface WorkflowDocumentDto {
  profileId: string
  id: string
  slug: string
  name: string
  description?: string
  source: 'profile' | 'project'
  archived?: boolean
  bundle: WorkflowWireBundle
  compiled: CompiledWorkflow
  semanticHash: string
  visualHash: string
  draft?: WorkflowDraftRecord
  head?: WorkflowHeadManifest | null
  savedAt?: string
}
export interface WorkflowLibraryDto extends WorkflowListItem {
  runnable: boolean
  issues: CompiledWorkflow['diagnostics']
  updatedAt?: string
}
