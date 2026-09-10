import type { WorkflowDocumentDto, WorkflowLibraryDto, WorkflowPlatformRequester } from '../../shared/workflowPlatform'
import type { CompiledWorkflow, WorkflowBundle, WorkflowHeadManifest, WorkflowLockDocument } from '../../shared/workflows'
import { decodeWorkflowBundle, encodeWorkflowBundle, type WorkflowWireBundle } from '../../shared/workflows/wire'

type Profile = { profileId: string }
type Identity = Profile & { id: string }
type Document = Omit<WorkflowDocumentDto, 'bundle'> & { bundle: WorkflowBundle }
const decode = (record: WorkflowDocumentDto): Document => ({ ...record, bundle: decodeWorkflowBundle(record.bundle) })

/** Binary packages cross JSON as tagged base64, while components continue using WorkflowBundle. */
export function createWorkflowDefinitionsClient(transport: WorkflowPlatformRequester) {
  const document = async (method: Parameters<WorkflowPlatformRequester['request']>[0], params: unknown): Promise<Document> => decode(await transport.request<WorkflowDocumentDto>(method, params))
  return {
    list: (query: Profile & { archived?: boolean }) => transport.request<WorkflowLibraryDto[]>('workflows.list', query),
    get: (query: Identity) => document('workflows.get', query),
    getRevision: (query: Identity & { revisionId: string }) => document('workflows.getRevision', query),
    create: (query: Profile & { name?: string; slug?: string; templateId?: string; bundle?: WorkflowBundle }) => document('workflows.create', { ...query, bundle: query.bundle ? encodeWorkflowBundle(query.bundle) : undefined }),
    saveDraft: (query: Identity & { expectedDraftSemanticHash: string | null; expectedHeadRevisionId?: string | null; bundle: WorkflowBundle; visualOnly?: boolean }) => document('workflows.saveDraft', { ...query, bundle: encodeWorkflowBundle(query.bundle) }),
    publish: (query: Identity & { expectedDraftSemanticHash: string; expectedHeadRevisionId?: string | null }) => document('workflows.publish', query),
    archive: async (query: Identity): Promise<void> => { await transport.request('workflows.archive', query) },
    duplicate: (query: Identity) => document('workflows.duplicate', query),
    importBundle: (query: Profile & { bundle: WorkflowBundle; conflict?: 'fail' | 'rename' }) => document('workflows.importBundle', { ...query, bundle: encodeWorkflowBundle(query.bundle) }),
    exportBundle: async (query: Identity & { revision?: string }): Promise<WorkflowBundle> => decodeWorkflowBundle(await transport.request<WorkflowWireBundle>('workflows.exportBundle', query)),
    validate: (query: Profile & { id?: string; bundle: WorkflowBundle; mode?: 'draft' | 'publish' }) => transport.request<{ compiled: CompiledWorkflow; diagnostics: CompiledWorkflow['diagnostics']; runnable: boolean }>('workflows.validate', { ...query, bundle: encodeWorkflowBundle(query.bundle) }),
    listRevisions: (query: Identity) => transport.request<Array<WorkflowHeadManifest & { lock?: WorkflowLockDocument }>>('workflows.listRevisions', query),
    restoreRevision: (query: Identity & { revisionId: string; expectedDraftSemanticHash: string }) => document('workflows.restoreRevision', query)
  }
}
