import type { WorkflowDependencyRef, WorkflowManifest } from './manifest'

export interface WorkflowEditorNodeVisual {
  x: number
  y: number
  collapsed?: boolean
  color?: string
  note?: string
}

export interface WorkflowEditorDocument {
  schemaVersion: 1
  viewport?: { x: number; y: number; zoom: number }
  nodes?: Record<string, WorkflowEditorNodeVisual>
  collapsedGroups?: string[]
  annotations?: Array<{ id: string; text: string; x: number; y: number }>
}

export interface WorkflowLockDocument {
  schemaVersion: 1
  workflowId: string
  semanticHash: string
  pinnedAt?: string
  dependencies: WorkflowDependencyRef[]
}

export interface WorkflowBundleAsset {
  relativePath: string
  bytes: Uint8Array | string
  sha256?: string
}

export interface WorkflowBundle {
  manifest: WorkflowManifest
  editor?: WorkflowEditorDocument
  lock?: WorkflowLockDocument
  assets: WorkflowBundleAsset[]
}

export interface WorkflowHeadManifest {
  definitionId: string
  revisionId: string
  semanticHash: string
  visualHash: string
  publishedAt: string
  slug: string
  name: string
}

export interface WorkflowDraftRecord {
  definitionId: string
  slug: string
  name: string
  savedAt: string
  semanticHash: string
  visualHash: string
  schemaVersion: number
}

export interface WorkflowRevisionRecord {
  definitionId: string
  revisionId: string
  semanticHash: string
  visualHash: string
  publishedAt: string
  slug: string
  name: string
  lock: WorkflowLockDocument
}

export type WorkflowRecordSource = 'profile' | 'project'

export interface WorkflowListItem {
  id: string
  slug: string
  name: string
  description?: string
  source: WorkflowRecordSource
  projectId?: string
  projectRoot?: string
  enabled: boolean
  archived?: boolean
  draftSemanticHash?: string
  draftVisualHash?: string
  headRevisionId?: string | null
  headSemanticHash?: string | null
  unsupportedNodes?: string[]
}

export class WorkflowConcurrencyError extends Error {
  readonly code = 'WORKFLOW_CONCURRENCY_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowConcurrencyError'
  }
}

export class WorkflowArchiveUnsupportedError extends Error {
  readonly code = 'WORKFLOW_ARCHIVE_UNSUPPORTED'
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowArchiveUnsupportedError'
  }
}

export class WorkflowValidationError extends Error {
  readonly code = 'WORKFLOW_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowValidationError'
  }
}
