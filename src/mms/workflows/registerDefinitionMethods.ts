import { createHash, randomUUID } from 'node:crypto'
import {
  WORKFLOW_DEFINITION_METHODS, WORKFLOW_DEFINITIONS_CAPABILITY,
  type WorkflowDefinitionMethod, type WorkflowDocumentDto
} from '../../shared/workflowPlatform'
import {
  WORKFLOW_UUID_PATTERN, WORKFLOW_SLUG_PATTERN, WorkflowConcurrencyError,
  type WorkflowBundle
} from '../../shared/workflows'
import { decodeWorkflowBundle, encodeWorkflowBundle, type WorkflowWireBundle } from '../../shared/workflows/wire'
import { domainObject, DomainHandlerRegistry, DomainRpcError } from '../protocol/domainRegistry'
import { compileWorkflow } from './compiler/compileWorkflow'
import { checkBundleRelativePath } from './pathSafety'
import { WorkflowRegistry, type WorkflowRecordSnapshot } from './registry/WorkflowRegistry'

type Params = Record<string, unknown>
const fields: Record<WorkflowDefinitionMethod, readonly string[]> = {
  'workflows.list': ['archived'], 'workflows.get': ['id'], 'workflows.getRevision': ['id', 'revisionId'],
  'workflows.create': ['name', 'slug', 'templateId', 'bundle'],
  'workflows.saveDraft': ['id', 'bundle', 'expectedDraftSemanticHash', 'expectedHeadRevisionId', 'visualOnly'],
  'workflows.publish': ['id', 'expectedDraftSemanticHash', 'expectedHeadRevisionId'],
  'workflows.archive': ['id'], 'workflows.duplicate': ['id'],
  'workflows.importBundle': ['bundle', 'conflict'], 'workflows.exportBundle': ['id', 'revision'],
  'workflows.validate': ['id', 'bundle', 'mode'], 'workflows.listRevisions': ['id'],
  'workflows.restoreRevision': ['id', 'revisionId', 'expectedDraftSemanticHash']
}

function validateBundle(value: unknown): WorkflowBundle {
  const raw = domainObject(value, ['manifest', 'editor', 'lock', 'assets'])
  const manifest = raw.manifest
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DomainRpcError('invalid_params', 'A workflow manifest is required')
  const identity = manifest as Params
  if (typeof identity.id !== 'string' || !WORKFLOW_UUID_PATTERN.test(identity.id) || typeof identity.name !== 'string' || !identity.name.trim() || identity.name.length > 120 || typeof identity.slug !== 'string' || !WORKFLOW_SLUG_PATTERN.test(identity.slug)) throw new DomainRpcError('invalid_params', 'Invalid workflow identity')
  if (!Array.isArray(raw.assets) || raw.assets.length > 64) throw new DomainRpcError('invalid_params', 'Expected a bounded workflow asset list')
  const seen = new Set<string>()
  for (const entry of raw.assets) {
    const asset = domainObject(entry, ['relativePath', 'encoding', 'data', 'sha256'])
    if (typeof asset.relativePath !== 'string' || typeof asset.data !== 'string' || !['utf8', 'base64'].includes(asset.encoding as string)) throw new DomainRpcError('invalid_params', 'Invalid workflow asset')
    const path = checkBundleRelativePath(asset.relativePath)
    if (!path.ok) throw new DomainRpcError('invalid_asset', path.reason)
    const key = path.relativePath.toLowerCase()
    if (seen.has(key) || ['workflow.json', 'editor.json', 'workflow.lock.json'].includes(key)) throw new DomainRpcError('invalid_asset', 'Duplicate or reserved asset path')
    seen.add(key)
    if (asset.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new DomainRpcError('invalid_asset', 'Invalid base64 asset')
    if (asset.sha256 !== undefined && (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))) throw new DomainRpcError('invalid_asset', 'Invalid asset digest')
  }
  const bundle = decodeWorkflowBundle(raw as unknown as WorkflowWireBundle)
  for (const asset of bundle.assets) if (asset.sha256 && createHash('sha256').update(asset.bytes).digest('hex') !== asset.sha256) throw new DomainRpcError('invalid_asset', 'Asset digest does not match its bytes')
  return bundle
}

function validate(method: WorkflowDefinitionMethod, value: unknown): Params {
  const p = { ...domainObject(value ?? {}, ['profileId', ...fields[method]]) }
  if (p.id !== undefined && (typeof p.id !== 'string' || !WORKFLOW_UUID_PATTERN.test(p.id))) throw new DomainRpcError('invalid_params', 'Invalid workflow identity')
  if (fields[method].includes('id') && method !== 'workflows.validate' && !p.id) throw new DomainRpcError('invalid_params', 'Workflow identity is required')
  for (const key of ['revision', 'revisionId', 'expectedDraftSemanticHash', 'expectedHeadRevisionId']) {
    const hash = p[key]
    const nullable = key === 'expectedHeadRevisionId' || (method === 'workflows.saveDraft' && key === 'expectedDraftSemanticHash')
    if (hash !== undefined && !(nullable && hash === null) && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  }
  if (fields[method].includes('revisionId') && p.revisionId === undefined) throw new DomainRpcError('invalid_params', 'Revision identity is required')
  if (fields[method].includes('expectedDraftSemanticHash') && p.expectedDraftSemanticHash === undefined) throw new DomainRpcError('invalid_params', 'Expected draft hash is required')
  for (const key of ['archived', 'visualOnly']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new DomainRpcError('invalid_params', key + ' must be boolean')
  if (p.conflict !== undefined && p.conflict !== 'fail' && p.conflict !== 'rename') throw new DomainRpcError('invalid_params', 'Invalid conflict choice')
  if (p.mode !== undefined && p.mode !== 'draft' && p.mode !== 'publish') throw new DomainRpcError('invalid_params', 'Invalid validation mode')
  if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120)) throw new DomainRpcError('invalid_params', 'Invalid workflow name')
  if (p.slug !== undefined && (typeof p.slug !== 'string' || !WORKFLOW_SLUG_PATTERN.test(p.slug))) throw new DomainRpcError('invalid_params', 'Invalid workflow slug')
  if (p.templateId !== undefined && (typeof p.templateId !== 'string' || p.templateId.length > 80)) throw new DomainRpcError('invalid_params', 'Invalid template')
  if (p.bundle !== undefined) p.bundle = validateBundle(p.bundle)
  if (fields[method].includes('bundle') && method !== 'workflows.create' && !p.bundle) throw new DomainRpcError('invalid_params', 'Workflow bundle is required')
  return p
}

function required(registry: WorkflowRegistry, id: string, revision?: string): WorkflowRecordSnapshot {
  const result = revision ? registry.getRevision(id, revision) : registry.get(id)
  if (!result) throw new DomainRpcError('workflow_not_found', 'Workflow or revision does not belong to this profile')
  return result
}
function document(record: WorkflowRecordSnapshot, registry: WorkflowRegistry): WorkflowDocumentDto {
  const { manifest } = record.bundle
  return boundedResponse({
    profileId: record.profileId, id: record.definitionId, slug: manifest.slug, name: manifest.name,
    description: manifest.description, source: 'profile', archived: registry.list().find((row) => row.id === record.definitionId)?.archived,
    bundle: encodeWorkflowBundle(record.bundle), compiled: record.compiled,
    semanticHash: record.semanticHash, visualHash: record.visualHash, draft: record.draft,
    head: record.head, savedAt: record.draft?.savedAt
  })
}
function boundedResponse<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 3 * 1024 * 1024) throw new DomainRpcError('response_too_large', 'Workflow exceeds the current desktop transfer limit')
  return value
}
function blank(name = 'Untitled workflow', slug?: string): WorkflowBundle {
  const id = randomUUID()
  return { manifest: {
    schemaVersion: 1, id, name, slug: slug ?? 'workflow-' + id.slice(0, 8),
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entryNodeId: 'start',
    nodes: [{ id: 'start', type: 'start', version: 1, config: {} }, { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'input', pointer: '' } }, config: {} }],
    edges: [{ from: 'start', port: 'next', to: 'end' }], permissions: { capabilities: [] }
  }, assets: [] }
}
function renamed(bundle: WorkflowBundle): WorkflowBundle {
  const id = randomUUID()
  return { ...bundle, manifest: { ...bundle.manifest, id, name: (bundle.manifest.name.slice(0, 110) + ' copy'), slug: bundle.manifest.slug.slice(0, 49) + '-copy-' + id.slice(0, 8) }, lock: undefined }
}

/** Services are selected from the admitted connection, never by paths in the request. */
export function registerWorkflowDefinitionMethods(domains: DomainHandlerRegistry, registryForProfile: (profileId: string) => WorkflowRegistry | Promise<WorkflowRegistry>): void {
  for (const method of WORKFLOW_DEFINITION_METHODS) domains.register({
    method, scope: 'profile', capability: WORKFLOW_DEFINITIONS_CAPABILITY, requiredCapabilities: [WORKFLOW_DEFINITIONS_CAPABILITY],
    validate: (value) => validate(method, value),
    async handle(_context, p, binding) {
      const registry = await registryForProfile(binding!.profileId)
      if (registry.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow registry does not belong to the admitted profile')
      const id = p.id as string
      try {
        switch (method) {
          case 'workflows.list': return boundedResponse(registry.list().filter((row) => p.archived || !row.archived).map(({ projectRoot: _privatePath, ...row }) => {
            const record = row.source === 'profile' ? registry.get(row.id) : undefined
            return { ...row, runnable: record?.compiled.runnable ?? false, issues: record?.compiled.diagnostics ?? [], updatedAt: record?.draft?.savedAt }
          }))
          case 'workflows.get': return document(required(registry, id), registry)
          case 'workflows.getRevision': return document(required(registry, id, p.revisionId as string), registry)
          case 'workflows.create': {
            if (!p.bundle && p.templateId && p.templateId !== 'blank') throw new DomainRpcError('template_required', 'Choose a template bundle before creating this workflow')
            const bundle = (p.bundle as WorkflowBundle | undefined) ?? blank(p.name as string | undefined, p.slug as string | undefined)
            return document(registry.saveDraft({ bundle, expectedDraftSemanticHash: null, expectedHeadRevisionId: null }), registry)
          }
          case 'workflows.saveDraft': {
            const bundle = p.bundle as WorkflowBundle
            if (bundle.manifest.id !== id) throw new DomainRpcError('invalid_params', 'Bundle and workflow identities differ')
            return document(registry.saveDraft({ bundle, definitionId: id, expectedDraftSemanticHash: p.expectedDraftSemanticHash as string | null, expectedHeadRevisionId: p.expectedHeadRevisionId as string | null | undefined, visualOnly: p.visualOnly as boolean | undefined }), registry)
          }
          case 'workflows.publish': return document(registry.publish({ definitionId: id, expectedDraftSemanticHash: p.expectedDraftSemanticHash as string, expectedHeadRevisionId: p.expectedHeadRevisionId as string | null | undefined }), registry)
          case 'workflows.archive': required(registry, id); registry.archive(id); return { archived: true }
          case 'workflows.duplicate': return document(registry.saveDraft({ bundle: renamed(required(registry, id).bundle), expectedDraftSemanticHash: null, expectedHeadRevisionId: null }), registry)
          case 'workflows.importBundle': {
            let bundle = p.bundle as WorkflowBundle
            const conflict = registry.list().some((row) => row.id === bundle.manifest.id || (!row.archived && row.slug === bundle.manifest.slug))
            if (conflict && p.conflict !== 'rename') throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'Workflow identity or command already exists; choose import as copy')
            if (conflict) bundle = renamed(bundle)
            return document(registry.saveDraft({ bundle, expectedDraftSemanticHash: null, expectedHeadRevisionId: null }), registry)
          }
          case 'workflows.exportBundle': return boundedResponse(encodeWorkflowBundle(required(registry, id, p.revision as string | undefined).bundle))
          case 'workflows.validate': {
            const bundle = p.bundle as WorkflowBundle
            const compiled = p.mode === 'publish' ? compileWorkflow(bundle.manifest, { mode: 'publish', knownAssets: new Set(bundle.assets.map((asset) => asset.relativePath)) }) : registry.validate(bundle)
            return { compiled, diagnostics: compiled.diagnostics, runnable: compiled.runnable }
          }
          case 'workflows.listRevisions': required(registry, id); return registry.listRevisions(id)
          case 'workflows.restoreRevision': {
            const current = required(registry, id)
            const revision = required(registry, id, p.revisionId as string)
            return document(registry.saveDraft({ definitionId: id, bundle: revision.bundle, expectedDraftSemanticHash: p.expectedDraftSemanticHash as string, expectedHeadRevisionId: current.head?.revisionId ?? null }), registry)
          }
        }
      } catch (error) {
        if (error instanceof WorkflowConcurrencyError) throw new DomainRpcError(error.code, error.message)
        throw error
      }
    }
  })
}
