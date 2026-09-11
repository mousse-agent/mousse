import type { CompiledWorkflow, WorkflowBundle, WorkflowDiagnostic } from '../../../src/shared/workflows'
import {
  WorkflowUiClientError,
  type WorkflowDefinitionsClient,
  type WorkflowDocument,
  type WorkflowEditorCatalogs,
  type WorkflowExecutionClient,
  type WorkflowLibraryItem,
  type WorkflowRunView,
  type WorkflowSubscribeHandle,
  type WorkflowValidateResult
} from '../../../src/renderer/components/workflows/client'
import { collectLocalDiagnostics } from '../../../src/renderer/components/workflows/localValidation'
import { semanticIdentity, visualIdentity } from '../../../src/renderer/components/workflows/semanticIdentity'
import { getWorkflowTemplate, createBlankWorkflowBundle } from '../../../src/renderer/components/workflows/templates'
import { uniqueSlug } from '../../../src/renderer/components/workflows/ids'

function hash(value: string): string {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + value.length.toString(16)
}

function newId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function compiledFrom(bundle: WorkflowBundle, extra: WorkflowDiagnostic[] = []): CompiledWorkflow {
  const local = collectLocalDiagnostics(bundle.manifest)
  const diagnostics = [...local.diagnostics, ...extra]
  const unsupported = bundle.manifest.nodes.filter((node) =>
    diagnostics.some((item) => item.nodeId === node.id && item.code === 'UNSUPPORTED_NODE')
  )
  const runnable = local.runnableHint && extra.every((item) => item.severity !== 'error')
  return {
    schemaVersion: bundle.manifest.schemaVersion,
    id: bundle.manifest.id,
    name: bundle.manifest.name,
    slug: bundle.manifest.slug,
    description: bundle.manifest.description,
    instructionsFile: bundle.manifest.instructionsFile,
    inputSchema: bundle.manifest.inputSchema,
    outputSchema: bundle.manifest.outputSchema,
    limits: bundle.manifest.limits ?? {},
    permissions: bundle.manifest.permissions?.capabilities ?? [],
    dependencies: bundle.manifest.dependencyPolicy?.dependencies ?? [],
    graph: {
      entryNodeId: bundle.manifest.entryNodeId,
      nodes: bundle.manifest.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        version: node.version,
        supported: !unsupported.some((item) => item.id === node.id),
        runtime: true,
        terminal: node.type === 'end' || node.type === 'fail',
        effect: node.effect ?? 'pure',
        inputs: node.inputs ?? {},
        config: node.config,
        requiredCapabilities: [],
        controlOutPorts: [],
        sourcePreserved: unsupported.some((item) => item.id === node.id)
      })),
      edges: bundle.manifest.edges,
      nodeIds: bundle.manifest.nodes.map((node) => node.id)
    },
    diagnostics,
    runnable,
    unsupportedNodeTypes: [...new Set(unsupported.map((node) => node.type))],
    semanticSource: bundle.manifest
  }
}

function toDocument(profileId: string, record: Stored): WorkflowDocument {
  const compiled = compiledFrom(record.bundle, record.extraDiagnostics)
  return {
    profileId,
    id: record.bundle.manifest.id,
    slug: record.bundle.manifest.slug,
    name: record.bundle.manifest.name,
    description: record.bundle.manifest.description,
    source: 'profile',
    archived: record.archived,
    tags: record.tags,
    bundle: clone(record.bundle),
    compiled,
    semanticHash: record.semanticHash,
    visualHash: record.visualHash,
    draft: {
      definitionId: record.bundle.manifest.id,
      slug: record.bundle.manifest.slug,
      name: record.bundle.manifest.name,
      savedAt: record.updatedAt,
      semanticHash: record.semanticHash,
      visualHash: record.visualHash,
      schemaVersion: 1
    },
    head: record.head,
    savedAt: record.updatedAt
  }
}

function toListItem(profileId: string, record: Stored): WorkflowLibraryItem {
  const compiled = compiledFrom(record.bundle, record.extraDiagnostics)
  return {
    id: record.bundle.manifest.id,
    slug: record.bundle.manifest.slug,
    name: record.bundle.manifest.name,
    description: record.bundle.manifest.description,
    source: 'profile',
    enabled: !record.archived,
    archived: record.archived,
    draftSemanticHash: record.semanticHash,
    draftVisualHash: record.visualHash,
    headRevisionId: record.head?.revisionId ?? null,
    headSemanticHash: record.head?.semanticHash ?? null,
    unsupportedNodes: compiled.unsupportedNodeTypes,
    tags: record.tags,
    updatedAt: record.updatedAt,
    lastRunAt: record.lastRunAt,
    lastRunStatus: record.lastRunStatus,
    issues: compiled.diagnostics,
    runnable: Boolean(record.head) && compiled.runnable
  }
}

interface Stored {
  bundle: WorkflowBundle
  semanticHash: string
  visualHash: string
  archived: boolean
  tags: string[]
  updatedAt: string
  extraDiagnostics: WorkflowDiagnostic[]
  head?: WorkflowDocument['head']
  lastRunAt?: string
  lastRunStatus?: WorkflowLibraryItem['lastRunStatus']
  revisions: Array<{
    revisionId: string
    bundle: WorkflowBundle
    publishedAt: string
    semanticHash: string
    visualHash: string
  }>
}

function hashes(bundle: WorkflowBundle): { semanticHash: string; visualHash: string } {
  return {
    semanticHash: hash(semanticIdentity(bundle.manifest, bundle.assets)),
    visualHash: hash(visualIdentity(bundle.editor))
  }
}

/**
 * Explicitly fake isolated client for tests and the Electron fixture.
 * Not a production adapter. Production UI receives a host-bound port.
 * Run results are labeled origin: 'fixture' and never execute models or scripts.
 */
export class IsolatedWorkflowDefinitionsClient implements WorkflowDefinitionsClient {
  private readonly records = new Map<string, Stored>()
  private delayMs = 0
  now = () => new Date().toISOString()
  catalogs: WorkflowEditorCatalogs = {
    skills: [],
    mcpServers: [],
    builtinTools: [],
    subworkflows: [],
    browserWorkspaces: []
  }

  setNetworkDelay(ms: number): void {
    this.delayMs = ms
  }

  private key(profileId: string, id: string): string {
    return `${profileId}:${id}`
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
  }

  seed(profileId: string, bundle: WorkflowBundle, extras?: Partial<Stored>): WorkflowDocument {
    const { semanticHash, visualHash } = hashes(bundle)
    const stored: Stored = {
      bundle: clone(bundle),
      semanticHash,
      visualHash,
      archived: false,
      tags: extras?.tags ?? [],
      updatedAt: this.now(),
      extraDiagnostics: extras?.extraDiagnostics ?? [],
      head: extras?.head,
      lastRunAt: extras?.lastRunAt,
      lastRunStatus: extras?.lastRunStatus,
      revisions: extras?.revisions ?? []
    }
    this.records.set(this.key(profileId, bundle.manifest.id), stored)
    return toDocument(profileId, stored)
  }

  async list(query: { profileId: string; archived?: boolean }): Promise<WorkflowLibraryItem[]> {
    await this.wait()
    return [...this.records.entries()]
      .filter(([key, record]) => key.startsWith(`${query.profileId}:`) && (query.archived ? true : !record.archived))
      .map(([, record]) => toListItem(query.profileId, record))
  }

  async get(query: { profileId: string; id: string }): Promise<WorkflowDocument> {
    await this.wait()
    const record = this.records.get(this.key(query.profileId, query.id))
    if (!record) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    return toDocument(query.profileId, record)
  }

  async create(query: Parameters<WorkflowDefinitionsClient['create']>[0]): Promise<WorkflowDocument> {
    await this.wait()
    const template = query.templateId ? getWorkflowTemplate(query.templateId) : undefined
    const bundle = query.bundle ?? template?.create({ name: query.name, slug: query.slug }) ?? createBlankWorkflowBundle(query.name)
    if (query.name) bundle.manifest.name = query.name
    if (query.slug) bundle.manifest.slug = query.slug
    const taken = [...this.records.values()].map((record) => record.bundle.manifest.slug)
    bundle.manifest.slug = uniqueSlug(bundle.manifest.slug, taken)
    const { semanticHash, visualHash } = hashes(bundle)
    const stored: Stored = {
      bundle,
      semanticHash,
      visualHash,
      archived: false,
      tags: template?.tags ?? [],
      updatedAt: this.now(),
      extraDiagnostics: [],
      revisions: []
    }
    this.records.set(this.key(query.profileId, bundle.manifest.id), stored)
    return toDocument(query.profileId, stored)
  }

  async saveDraft(query: Parameters<WorkflowDefinitionsClient['saveDraft']>[0]): Promise<WorkflowDocument> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    if (query.expectedDraftSemanticHash !== current.semanticHash) {
      throw new WorkflowUiClientError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', {
        retryable: true,
        details: { expectedDraftSemanticHash: query.expectedDraftSemanticHash, actualDraftSemanticHash: current.semanticHash }
      })
    }
    const nextBundle = clone(query.bundle)
    nextBundle.manifest.id = current.bundle.manifest.id
    if (query.visualOnly) {
      const incomingSemantic = hash(semanticIdentity(nextBundle.manifest, nextBundle.assets))
      if (incomingSemantic !== current.semanticHash) {
        throw new WorkflowUiClientError('INVALID_GRAPH', 'visualOnly save would change semantic identity.')
      }
      nextBundle.manifest = current.bundle.manifest
      nextBundle.assets = current.bundle.assets
      nextBundle.lock = current.bundle.lock
    }
    const { semanticHash, visualHash } = hashes(nextBundle)
    current.bundle = nextBundle
    current.semanticHash = semanticHash
    current.visualHash = visualHash
    current.updatedAt = this.now()
    return toDocument(query.profileId, current)
  }

  async publish(query: Parameters<WorkflowDefinitionsClient['publish']>[0]): Promise<WorkflowDocument> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    if (query.expectedDraftSemanticHash !== current.semanticHash) {
      throw new WorkflowUiClientError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', {
        retryable: true
      })
    }
    const compiled = compiledFrom(current.bundle, current.extraDiagnostics)
    if (!compiled.runnable) {
      throw new WorkflowUiClientError('INVALID_GRAPH', compiled.diagnostics[0]?.message ?? 'Workflow is not publishable.')
    }
    const publishedAt = this.now()
    current.head = {
      definitionId: query.id,
      revisionId: current.semanticHash,
      semanticHash: current.semanticHash,
      visualHash: current.visualHash,
      publishedAt,
      slug: current.bundle.manifest.slug,
      name: current.bundle.manifest.name
    }
    current.revisions.unshift({
      revisionId: current.semanticHash,
      bundle: clone(current.bundle),
      publishedAt,
      semanticHash: current.semanticHash,
      visualHash: current.visualHash
    })
    current.updatedAt = publishedAt
    return toDocument(query.profileId, current)
  }

  async archive(query: { profileId: string; id: string }): Promise<void> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    current.archived = true
  }

  async duplicate(query: { profileId: string; id: string }): Promise<WorkflowDocument> {
    await this.wait()
    const current = await this.get(query)
    const bundle = clone(current.bundle)
    bundle.manifest.id = newId()
    bundle.manifest.name = `${bundle.manifest.name} copy`
    bundle.manifest.slug = uniqueSlug(`${bundle.manifest.slug}_copy`, [...this.records.values()].map((item) => item.bundle.manifest.slug))
    return this.seed(query.profileId, bundle, { tags: current.tags })
  }

  async importBundle(query: Parameters<WorkflowDefinitionsClient['importBundle']>[0]): Promise<WorkflowDocument> {
    await this.wait()
    const bundle = clone(query.bundle)
    const exists = [...this.records.values()].some((record) => record.bundle.manifest.id === bundle.manifest.id)
    if (exists && query.conflict === 'fail') {
      throw new WorkflowUiClientError('WORKFLOW_EXISTS', 'A workflow with this id already exists.')
    }
    if (exists) {
      bundle.manifest.id = newId()
      bundle.manifest.slug = uniqueSlug(`${bundle.manifest.slug}_imported`, [...this.records.values()].map((item) => item.bundle.manifest.slug))
    }
    return this.seed(query.profileId, bundle)
  }

  async exportBundle(query: { profileId: string; id: string; revision?: string }): Promise<WorkflowBundle> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    if (query.revision) {
      const revision = current.revisions.find((item) => item.revisionId === query.revision)
      if (!revision) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', 'Revision was not found.')
      return clone(revision.bundle)
    }
    return clone(current.bundle)
  }

  async validate(query: Parameters<WorkflowDefinitionsClient['validate']>[0]): Promise<WorkflowValidateResult> {
    await this.wait()
    const extra = this.dependencyDiagnostics(query.bundle)
    const compiled = compiledFrom(query.bundle, extra)
    return { compiled, diagnostics: compiled.diagnostics, runnable: compiled.runnable }
  }

  async listRevisions(query: { profileId: string; id: string }) {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    return current.revisions.map((item) => ({
      revisionId: item.revisionId,
      semanticHash: item.semanticHash,
      visualHash: item.visualHash,
      publishedAt: item.publishedAt,
      slug: item.bundle.manifest.slug,
      name: item.bundle.manifest.name
    }))
  }

  async getRevision(query: { profileId: string; id: string; revisionId: string }): Promise<WorkflowDocument> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    const revision = current.revisions.find((item) => item.revisionId === query.revisionId)
    if (!revision) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', 'Revision was not found.')
    return toDocument(query.profileId, {
      ...current,
      bundle: clone(revision.bundle),
      semanticHash: revision.semanticHash,
      visualHash: revision.visualHash,
      updatedAt: revision.publishedAt,
      head: {
        definitionId: query.id,
        revisionId: revision.revisionId,
        semanticHash: revision.semanticHash,
        visualHash: revision.visualHash,
        publishedAt: revision.publishedAt,
        slug: revision.bundle.manifest.slug,
        name: revision.bundle.manifest.name
      }
    })
  }

  async restoreRevision(query: {
    profileId: string
    id: string
    revisionId: string
    expectedDraftSemanticHash: string
  }): Promise<WorkflowDocument> {
    await this.wait()
    const current = this.records.get(this.key(query.profileId, query.id))
    if (!current) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', `Workflow ${query.id} was not found.`)
    if (query.expectedDraftSemanticHash !== current.semanticHash) {
      throw new WorkflowUiClientError('REVISION_CONFLICT', 'Draft changed since it was loaded. Reload and retry.', {
        retryable: true
      })
    }
    const revision = current.revisions.find((item) => item.revisionId === query.revisionId)
    if (!revision) throw new WorkflowUiClientError('WORKFLOW_NOT_FOUND', 'Revision was not found.')
    current.bundle = clone(revision.bundle)
    current.semanticHash = revision.semanticHash
    current.visualHash = revision.visualHash
    current.updatedAt = this.now()
    return toDocument(query.profileId, current)
  }

  private dependencyDiagnostics(bundle: WorkflowBundle): WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = []
    for (const node of bundle.manifest.nodes) {
      if (node.type === 'mcp-tool') {
        const serverId = String(node.config.serverId ?? '')
        const toolName = String(node.config.toolName ?? '')
        const server = this.catalogs.mcpServers.find((item) => item.serverId === serverId)
        const tool = server?.tools.find((item) => item.toolName === toolName)
        if (serverId && (!server || !tool?.available)) {
          diagnostics.push({
            code: 'MISSING_DEPENDENCY',
            severity: 'error',
            message: `MCP tool ${serverId}/${toolName} is not available in this profile.`,
            nodeId: node.id
          })
        }
      }
      if (node.type === 'load-skill') {
        const skill = node.config.skill as { id?: string } | undefined
        const found = this.catalogs.skills.find((item) => item.id === skill?.id)
        if (skill?.id && !found?.available) {
          diagnostics.push({
            code: 'MISSING_DEPENDENCY',
            severity: 'error',
            message: `Skill ${skill.id} is missing from this profile.`,
            nodeId: node.id
          })
        }
      }
      if (node.type === 'agent') {
        const agent = node.config.agent as { kind?: string; definitionId?: string } | undefined
        if (agent?.kind === 'user' && agent.definitionId) {
          const exists = this.catalogs.subworkflows.some((item) => item.id === agent.definitionId)
          if (!exists && this.catalogs.subworkflows.length > 0) {
            diagnostics.push({
              code: 'MISSING_DEPENDENCY',
              severity: 'error',
              message: `Agent definition ${agent.definitionId} is missing.`,
              nodeId: node.id
            })
          }
        }
      }
      const model = this.catalogs.models?.find((item) => !item.available)
      if (model && node.type === 'agent') {
        diagnostics.push({
          code: 'MISSING_DEPENDENCY',
          severity: 'warning',
          message: `Model ${model.providerId}/${model.modelId} is no longer in the shared catalog.`,
          nodeId: node.id
        })
      }
    }
    return diagnostics
  }
}

export class IsolatedWorkflowExecutionClient implements WorkflowExecutionClient {
  private readonly runs = new Map<string, WorkflowRunView>()
  private readonly listeners = new Map<string, Set<(snapshot: WorkflowRunView) => void>>()
  origin: 'fixture' = 'fixture'

  private emit(run: WorkflowRunView): void {
    this.runs.set(run.runId, run)
    for (const listener of this.listeners.get(`${run.profileId}:${run.runId}`) ?? []) listener(clone(run))
  }

  async start(query: Parameters<WorkflowExecutionClient['start']>[0]): Promise<WorkflowRunView> {
    if (query.draft && !query.expectedDraftSemanticHash) {
      throw new WorkflowUiClientError('REVISION_CONFLICT', 'Draft runs require the expected saved semantic hash.')
    }
    const runId = newId()
    const at = new Date().toISOString()
    const needsApproval = Boolean(query.input && typeof query.input === 'object' && (query.input as { requireApproval?: boolean }).requireApproval)
    const run: WorkflowRunView = {
      runId,
      profileId: query.profileId,
      definitionId: query.definitionId,
      revisionId: query.revisionId,
      state: needsApproval ? 'waiting-approval' : 'succeeded',
      origin: 'fixture',
      startedAt: at,
      updatedAt: at,
      input: query.input,
      result: {
        fixture: true,
        summary: 'Fixture run; no model or script was executed.'
      },
      events: [
        { seq: 1, at, kind: 'run-accepted', runId, message: 'Fixture run accepted' },
        {
          seq: 2,
          at,
          kind: needsApproval ? 'wait-checkpoint' : 'attempt-completed',
          runId,
          nodeId: needsApproval ? 'approve' : 'end',
          message: needsApproval ? 'Waiting for fixture approval' : 'Fixture completed without executing adapters'
        }
      ],
      attempts: [
        {
          instanceKey: `${runId}:start:1`,
          nodeId: 'start',
          type: 'start',
          attempt: 1,
          outcome: 'succeeded',
          startedAt: at,
          completedAt: at
        }
      ],
      artifacts: [],
      pendingApproval: needsApproval
        ? {
            approvalId: `approval-${runId}`,
            runId,
            nodeId: 'approve',
            instanceKey: `${runId}:approve:1`,
            attempt: 1,
            description: 'Fixture approval. This is not a live policy decision.'
          }
        : undefined
    }
    this.emit(run)
    return clone(run)
  }

  async get(query: { profileId: string; runId: string }): Promise<WorkflowRunView> {
    const run = this.runs.get(query.runId)
    if (!run || run.profileId !== query.profileId) {
      throw new WorkflowUiClientError('PROFILE_MISMATCH', 'Run does not belong to this profile.')
    }
    return clone(run)
  }

  async cancel(query: { profileId: string; runId: string; reason?: string }): Promise<WorkflowRunView> {
    const run = await this.get(query)
    run.state = 'cancelled'
    run.updatedAt = new Date().toISOString()
    run.events.push({
      seq: run.events.length + 1,
      at: run.updatedAt,
      kind: 'state-changed',
      runId: run.runId,
      message: `Cancelled (${query.reason ?? 'user'}). Fixture did not reverse external effects.`
    })
    this.emit(run)
    return clone(run)
  }

  async pause(query: { profileId: string; runId: string }): Promise<WorkflowRunView> {
    const run = await this.get(query)
    run.state = 'interrupted'
    run.updatedAt = new Date().toISOString()
    run.events.push({
      seq: run.events.length + 1,
      at: run.updatedAt,
      kind: 'state-changed',
      runId: run.runId,
      message: 'Fixture paused'
    })
    this.emit(run)
    return clone(run)
  }

  async resume(query: { profileId: string; runId: string }): Promise<WorkflowRunView> {
    const run = await this.get(query)
    run.state = 'running'
    run.updatedAt = new Date().toISOString()
    run.events.push({
      seq: run.events.length + 1,
      at: run.updatedAt,
      kind: 'state-changed',
      runId: run.runId,
      message: 'Fixture resumed'
    })
    this.emit(run)
    return clone(run)
  }

  async approve(query: Parameters<NonNullable<WorkflowExecutionClient['approve']>>[0]): Promise<WorkflowRunView> {
    const run = await this.get({ profileId: query.profileId, runId: query.runId })
    if (!run.pendingApproval || run.pendingApproval.approvalId !== query.approvalId) {
      throw new WorkflowUiClientError('INVALID_GRAPH', 'Approval identity does not match the pending fixture approval.')
    }
    if (
      run.pendingApproval.nodeId !== query.nodeId ||
      run.pendingApproval.instanceKey !== query.instanceKey ||
      run.pendingApproval.attempt !== query.attempt
    ) {
      throw new WorkflowUiClientError('INVALID_GRAPH', 'Approval run/node/attempt identity mismatch.')
    }
    run.pendingApproval = undefined
    run.state = query.approved ? 'succeeded' : 'failed'
    run.updatedAt = new Date().toISOString()
    run.events.push({
      seq: run.events.length + 1,
      at: run.updatedAt,
      kind: 'state-changed',
      runId: run.runId,
      nodeId: query.nodeId,
      instanceKey: query.instanceKey,
      message: query.approved ? 'Fixture approval granted' : 'Fixture approval denied'
    })
    this.emit(run)
    return clone(run)
  }

  async answer(query: Parameters<NonNullable<WorkflowExecutionClient['answer']>>[0]): Promise<WorkflowRunView> {
    const run = await this.get({ profileId: query.profileId, runId: query.runId })
    run.pendingInput = undefined
    run.state = 'succeeded'
    run.result = { fixture: true, answer: query.data }
    run.updatedAt = new Date().toISOString()
    this.emit(run)
    return clone(run)
  }

  subscribe(query: { profileId: string; runId: string }, listener: (snapshot: WorkflowRunView) => void): WorkflowSubscribeHandle {
    const key = `${query.profileId}:${query.runId}`
    const set = this.listeners.get(key) ?? new Set()
    set.add(listener)
    this.listeners.set(key, set)
    const current = this.runs.get(query.runId)
    if (current && current.profileId === query.profileId) listener(clone(current))
    return {
      unsubscribe() {
        set.delete(listener)
      }
    }
  }
}
