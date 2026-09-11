import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { AgentDefinitionError, isAgentDefinitionError } from '../../shared/agents/errors'
import type {
  AgentExecutionResult,
  AgentRuntimeHostBindings,
  AgentRuntimeToolApprovalRequest
} from '../../shared/agents/execution'
import { compileAgentInstructions } from '../../shared/agents/prompt'
import { defaultAgentSettings } from '../../shared/agents/defaults'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import type {
  AgentRuntimeKind,
  EffectiveAgentGrants,
  ResolvedAgentDefinition
} from '../../shared/agents/types'
import type { BrowserRuntimePort } from '../../shared/browser/runtime'
import type { EffectClass, ExecutionContext, ExecutionPolicySnapshot, ExecutionSource } from '../../shared/execution/types'
import type { IntegrationActor } from '../../shared/integrations/actor'
import { MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import {
  isPlainObject,
  stableStringify,
  WORKFLOW_UUID_PATTERN,
  type AgentExecutorAdapter,
  type CompiledGraph,
  type StartWorkflowRequest,
  type WorkflowRunManifest
} from '../../shared/workflows'
import {
  WORKFLOW_AGENT_BINDINGS_FIELD,
  WORKFLOW_AGENT_BINDINGS_MAX_BYTES,
  WORKFLOW_AGENT_SNAPSHOT_MAX_BYTES,
  WORKFLOW_MAIN_AGENT_DEFINITION_ID,
  type WorkflowAgentExecutionBindings,
  type WorkflowAgentPin
} from '../../shared/workflows/agentExecutionBindings'
import { AgentResolver } from '../agentDefinitions/AgentResolver'
import { StaticAgentIntegrationLookup } from '../agentDefinitions/lookups'
import {
  classifyTrustedTool,
  collectUnsupportedRuntimeSettings
} from '../agentDefinitions/runtimePolicy'
import { atomicWriteJsonSync, durableExclusiveWriteSync } from '../data/AtomicFs'
import { DomainRpcError } from '../protocol/domainRegistry'
import { assertOwnedPath } from '../profiles/pathSafety'
import { browserToolCapability, isBrowserAutomationTool } from '../orchestrator/browser'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { WorkflowRecordSnapshot } from '../workflows/registry/WorkflowRegistry'
import { collectTransitiveWorkflowRecords } from '../workflows/engine/childAdmission'
import { executionThreadId } from '../data/ThreadDataStore'
import { SharedAgentModelLookup } from './SharedAgentModelLookup'

const SNAPSHOT_RECORD_MAX_BYTES = WORKFLOW_AGENT_BINDINGS_MAX_BYTES
const INVOCATION_MAX_BYTES = 4 * 1024 * 1024
const APPROVAL_ARGUMENT_MAX_BYTES = 6 * 1024

type AgentRef = { kind: 'main' | 'user'; definitionId?: string; revision?: string }

interface SnapshotRecord {
  version: 1
  profileId: string
  snapshotHash: string
  snapshot: ResolvedAgentDefinition
  integrity?: string
}

interface AdmissionRecord {
  version: 1
  profileId: string
  projectId?: string
  threadId: string
  requestId: string
  workflowDefinitionId: string
  workflowRevisionId?: string
  snapshotDigest: string
  pins: WorkflowAgentPin[]
  integrity?: string
}

interface InvocationRecord {
  version: 1
  profileId: string
  idempotencyKey: string
  requestId: string
  runId: string
  state: 'dispatched' | 'completed' | 'failed' | 'cancelled'
  output?: unknown
  tokens?: number
  cost?: number
  error?: { code: string; message: string }
  integrity?: string
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function effectForTool(toolId: string, isMcp: boolean): EffectClass {
  const classification = classifyTrustedTool(toolId, isMcp)
  if (classification === 'write' || classification === 'script') return 'write'
  if (classification === 'mcp') return 'external'
  if (isBrowserAutomationTool(toolId) && classification !== 'read') return 'external'
  return 'read'
}

function capabilityForTool(toolId: string, isMcp: boolean): string | undefined {
  if (isMcp) return 'mcp.invoke'
  if (isBrowserAutomationTool(toolId)) return browserToolCapability(toolId)
  const classification = classifyTrustedTool(toolId, false)
  if (classification === 'script') return 'script.trusted-local'
  if (classification === 'ask') return 'human.input'
  return undefined
}

function mapAgentError(error: unknown): DomainRpcError {
  if (error instanceof DomainRpcError) return error
  if (isAgentDefinitionError(error)) {
    const code =
      error.code === 'PROFILE_MISMATCH' ? 'profile_mismatch'
        : error.code === 'SETTINGS_UNSUPPORTED' ? 'executor_unavailable'
          : error.code === 'REVISION_CONFLICT' || error.code === 'REVISION_NOT_FOUND' ? 'stale_revision'
            : error.code === 'AGENT_NOT_FOUND' || error.code === 'AGENT_ARCHIVED' || error.code === 'DEPENDENCY_MISSING' || error.code === 'MODEL_CAPABILITY_MISSING'
              ? 'dependency_missing'
              : 'invalid_input'
    return new DomainRpcError(code, error.message, error.details)
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code === 'thread_unavailable' || message.includes('thread is unavailable')) return new DomainRpcError('thread_unavailable', message)
  return new DomainRpcError('invalid_input', message)
}

function userMessageFromInput(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return input
  if (input === undefined || input === null) return 'Follow the workflow node instructions.'
  try {
    const json = JSON.stringify(input)
    if (!json || json === '{}' || json === '[]' || json === 'null') return 'Follow the workflow node instructions.'
    return json
  } catch {
    return 'Follow the workflow node instructions.'
  }
}

function collectAgentRefs(graph: CompiledGraph): AgentRef[] {
  const refs = new Map<string, AgentRef>()
  const visit = (nodeGraph: CompiledGraph): void => {
    for (const node of nodeGraph.nodes) {
      if (node.type === 'agent' || node.type === 'instruction') {
        const raw = isPlainObject(node.config.agent) ? node.config.agent : { kind: 'main' }
        const kind: AgentRef['kind'] = raw.kind === 'user' ? 'user' : 'main'
        const definitionId = kind === 'user' && typeof raw.definitionId === 'string' ? raw.definitionId : undefined
        const revision = typeof raw.revision === 'string' ? raw.revision : undefined
        if (kind === 'user' && !definitionId) throw new DomainRpcError('invalid_input', 'User agent node is missing definitionId')
        const ref: AgentRef = { kind, definitionId, revision }
        refs.set(stableStringify(ref), ref)
      }
      for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
    }
  }
  visit(graph)
  return [...refs.values()]
}

function matchPin(pins: WorkflowAgentPin[], ref: AgentRef): WorkflowAgentPin | undefined {
  if (ref.kind === 'main') return pins.find((pin) => pin.kind === 'main')
  const matches = pins.filter((pin) => pin.kind === 'user' && pin.definitionId === ref.definitionId)
  if (ref.revision) {
    return matches.find((pin) => pin.requestedRevision === ref.revision || pin.revision === ref.revision)
  }
  return matches.length === 1 ? matches[0] : matches.find((pin) => pin.requestedRevision === undefined)
}

function agentSource(source: ExecutionSource): 'workflow' | 'cli' | 'schedule' | 'channel' {
  if (source === 'cli' || source === 'schedule' || source === 'channel') return source
  return 'workflow'
}

function parseOutput(text: string, expectSchema: boolean): unknown {
  const trimmed = text.trim()
  if (!trimmed) return expectSchema ? null : { text: '' }
  try {
    return JSON.parse(trimmed)
  } catch {
    if (expectSchema) throw new DomainRpcError('invalid_input', 'Agent output is not valid JSON')
    return { text }
  }
}

/** Profile-owned Agent/Instruction adapter. Root wires this after import. */
export class MmsWorkflowAgents {
  readonly agent: AgentExecutorAdapter = { kind: 'agent', invoke: (request) => this.invoke(request) }
  private stopped = false
  private browserRuntime?: BrowserRuntimePort
  private readonly root: string
  private readonly canonicalRoot: string

  constructor(
    private readonly services: MmsProfileServices,
    private readonly run: (context: ExecutionContext) => Promise<WorkflowRunManifest>
  ) {
    this.root = join(services.getProfileHomeDir(), 'workflow-agent-bindings')
    assertOwnedPath(services.getProfileHomeDir(), this.root)
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new Error('Workflow agent binding directory cannot be a symlink')
    mkdirSync(join(this.root, 'snapshots'), { recursive: true })
    mkdirSync(join(this.root, 'admissions'), { recursive: true })
    mkdirSync(join(this.root, 'invocations'), { recursive: true })
    mkdirSync(join(this.root, 'workspaces'), { recursive: true })
    this.canonicalRoot = realpathSync(this.root)
  }

  dispose(): void { this.stopped = true }

  /** Root injects the same BrowserRuntimePort bound to OrchestratorService. */
  setBrowserRuntime(port: BrowserRuntimePort | undefined): void {
    this.browserRuntime = port
  }

  /**
   * Pin referenced agent definitions before durable workflow admission.
   * Never reads current heads during a later resume — invoke uses this snapshot.
   */
  async prepare(request: StartWorkflowRequest, record: WorkflowRecordSnapshot): Promise<{
    bindings: WorkflowAgentExecutionBindings
    installationPolicy: { allowedTools: string[]; allowedCapabilities: string[] }
  }> {
    try {
      return await this.prepareOwned(request, record, undefined)
    } catch (error) {
      throw mapAgentError(error)
    }
  }

  /**
   * Child inheritance: select only agent pins declared by the child from the
   * parent's admitted snapshot. Does not resolve current model/integration heads.
   */
  async prepareInherited(input: {
    parent: WorkflowAgentExecutionBindings | { requestId: string }
    request: StartWorkflowRequest
    record: WorkflowRecordSnapshot
  }): Promise<{
    bindings: WorkflowAgentExecutionBindings
    installationPolicy: { allowedTools: string[]; allowedCapabilities: string[] }
  }> {
    try {
      const parent = 'pins' in input.parent && input.parent.version === 1
        ? input.parent
        : this.readAdmission(('requestId' in input.parent ? input.parent.requestId : '')).bindings
      return await this.prepareOwned(input.request, input.record, parent)
    } catch (error) {
      throw mapAgentError(error)
    }
  }

  private async prepareOwned(
    request: StartWorkflowRequest,
    record: WorkflowRecordSnapshot,
    parent: WorkflowAgentExecutionBindings | undefined
  ) {
    this.assertActive()
    if (!request.requestId || !WORKFLOW_UUID_PATTERN.test(request.requestId)) throw new DomainRpcError('invalid_input', 'Workflow agent preparation requires a stable request identity')
    if (request.profileId !== this.services.profileId || record.profileId !== this.services.profileId) {
      throw new DomainRpcError('profile_mismatch', 'Workflow agent preparation belongs to another profile')
    }
    this.project(request.profileId, request.projectId)
    if (request.threadId) {
      const thread = this.services.threads.getThread(request.threadId)
      const newExecutionThread = !parent && request.threadId === executionThreadId(request.profileId + '/workflow/' + request.requestId)
      if ((!thread && !newExecutionThread) || (thread && (thread.settledAt || thread.projectId !== request.projectId))) throw new DomainRpcError('thread_unavailable', 'Workflow agent thread is unavailable')
    }
    // Preparation can be retried after its own durable write but before the
    // coordinator commits admission. Reuse the exact snapshot without discovery.
    if (existsSync(join(this.root, 'admissions', request.requestId + '.json'))) {
      const existing = this.readAdmission(request.requestId)
      if (existing.record.threadId !== request.threadId || existing.record.projectId !== request.projectId
        || existing.record.workflowDefinitionId !== record.definitionId
        || existing.record.workflowRevisionId !== (request.revisionId ?? record.head?.revisionId ?? record.semanticHash)) {
        throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'Agent admission identity belongs to another workflow scope')
      }
      for (const pin of existing.bindings.pins) {
        this.readSnapshot(pin.snapshotHash)
        if (parent && !parent.pins.some((candidate) => candidate.snapshotHash === pin.snapshotHash && candidate.definitionId === pin.definitionId)) throw new DomainRpcError('dependency_missing', 'Child agent snapshot is not inherited from this parent')
      }
      return { bindings: existing.bindings, installationPolicy: this.policyForPins(existing.bindings.pins) }
    }
    const records = [record, ...collectTransitiveWorkflowRecords(record, this.services.platform.workflowDefinitions)]
    if (parent && parent.profileId !== request.profileId) throw new DomainRpcError('profile_mismatch', 'Parent agent snapshot belongs to another profile')
    const pins: WorkflowAgentPin[] = []
    for (const source of records) for (const ref of collectAgentRefs(source.compiled.graph)) {
      const existingPin = matchPin(pins, ref)
      if (existingPin) {
        if (ref.kind === 'user') this.assertDeclaredDependency(source, ref, this.readSnapshot(existingPin.snapshotHash))
        continue
      }
      if (parent) {
        const inherited = matchPin(parent.pins, ref)
        if (!inherited) throw new DomainRpcError('dependency_missing', 'Child workflow agent pin is absent from the parent admission')
        if (inherited.kind !== ref.kind || (ref.kind === 'user' && inherited.definitionId !== ref.definitionId)) {
          throw new DomainRpcError('stale_revision', 'Child workflow agent pin does not match the parent snapshot')
        }
        this.readSnapshot(inherited.snapshotHash)
        pins.push(structuredClone(inherited))
        continue
      }
      pins.push(await this.pinRef(request, source, ref))
    }
    const bindings = this.bindingsOf(request.profileId, pins)
    this.writeAdmission({
      version: 1,
      profileId: request.profileId,
      projectId: request.projectId,
      threadId: request.threadId ?? '',
      requestId: request.requestId,
      workflowDefinitionId: record.definitionId,
      workflowRevisionId: request.revisionId ?? record.head?.revisionId ?? record.semanticHash,
      snapshotDigest: bindings.snapshotDigest,
      pins
    })
    return {
      bindings,
      installationPolicy: this.policyForPins(pins)
    }
  }

  private policyForPins(pins: WorkflowAgentPin[]): { allowedTools: string[]; allowedCapabilities: string[] } {
    const allowedTools = new Set<string>()
    const allowedCapabilities = new Set<string>()
    if (pins.length) {
      allowedTools.add('workflow.agent')
      allowedCapabilities.add('model.invoke')
    }
    for (const pin of pins) {
      const grants = this.readSnapshot(pin.snapshotHash).grants
      if (grants.skills.length) allowedCapabilities.add('skill.load')
      for (const tool of grants.builtinTools) {
        allowedTools.add(tool.id)
        const capability = capabilityForTool(tool.id, false)
        if (capability) allowedCapabilities.add(capability)
      }
      for (const tool of grants.mcpTools) {
        allowedTools.add(`mcp:${tool.serverId}/${tool.toolName}`)
        allowedCapabilities.add('mcp.invoke')
      }
    }
    return { allowedTools: [...allowedTools].sort(), allowedCapabilities: [...allowedCapabilities].sort() }
  }

  private async pinRef(request: StartWorkflowRequest, record: WorkflowRecordSnapshot, ref: AgentRef): Promise<WorkflowAgentPin> {
    const projectPath = this.project(request.profileId, request.projectId)
    if (ref.kind === 'main') {
      const resolved = await this.resolveMain(projectPath)
      this.assertSupported(resolved, projectPath)
      const snapshotHash = this.writeSnapshot(resolved)
      return {
        kind: 'main',
        definitionId: WORKFLOW_MAIN_AGENT_DEFINITION_ID,
        revision: resolved.revision,
        snapshotHash,
        runtimeKind: resolved.runtimeKind
      }
    }
    const definitionId = ref.definitionId!
    const published = this.services.platform.agentDefinitions.get(definitionId)
    if (published.profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Agent definition belongs to another profile')
    const revision = ref.revision ?? published.published?.revision
    if (!revision) throw new DomainRpcError('stale_revision', 'Publish an agent revision before pinning it on a workflow')
    const lookup = await this.lookupFor(published.runtimeKind, projectPath, 'user')
    const resolver = new AgentResolver({
      registry: this.services.platform.agentDefinitions,
      modelLookup: new SharedAgentModelLookup(this.services.providerAuth),
      integrationLookup: lookup
    })
    const resolved = resolver.resolve({ definitionId, revision })
    if (resolved.profileId !== this.services.profileId || resolved.definitionId !== definitionId || resolved.revision !== revision) {
      throw new DomainRpcError('stale_revision', 'Resolved agent revision does not match the workflow pin')
    }
    this.assertDeclaredDependency(record, ref, resolved)
    this.assertSupported(resolved, projectPath)
    const snapshotHash = this.writeSnapshot(resolved)
    return {
      kind: 'user',
      requestedDefinitionId: definitionId,
      requestedRevision: ref.revision,
      definitionId,
      revision: resolved.revision,
      snapshotHash,
      runtimeKind: resolved.runtimeKind
    }
  }

  private async resolveMain(projectPath?: string): Promise<ResolvedAgentDefinition> {
    const settings = defaultAgentSettings({ name: 'Main', slug: 'main' })
    const provider = this.services.settings.get().provider
    settings.primaryModel.ref = { providerId: provider.llmProvider, modelId: provider.model }
    settings.context = {
      includeCurrentThread: false,
      selectedFiles: [],
      includeProjectInstructions: false,
      attachmentPolicy: 'none',
      sources: []
    }
    settings.memory = { scope: 'thread' }
    settings.workspace = { mode: 'thread_worktree', permittedRoots: [] }
    settings.browser = { mode: 'disabled', allowedDomains: [], traceRetention: 'none' }
    settings.delegation = { allowedChildDefinitionIds: [], maxConcurrentChildren: 0, maxDepth: 0 }
    settings.script = { enabled: false, interpreters: [], executionMode: 'sandboxed', allowNetwork: false, allowFilesystem: false }
    settings.approval = { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' }
    settings.tools = { mode: 'inherit', allowlist: MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group !== 'devgui').map((tool) => tool.id) }
    settings.skills = { mode: 'inherit', selections: [] }
    settings.mcp = { mode: 'inherit', servers: [] }
    const systemPrompt = ''
    const revision = sha256Hex(canonicalJson({
      kind: 'main',
      profileId: this.services.profileId,
      runtimeKind: 'mousse',
      settings,
      systemPrompt,
      model: settings.primaryModel.ref
    }))
    const resolver = new AgentResolver({
      registry: this.services.platform.agentDefinitions,
      modelLookup: new SharedAgentModelLookup(this.services.providerAuth),
      integrationLookup: await this.lookupFor('mousse', projectPath, 'main')
    })
    return resolver.resolveOwned({
      definitionId: WORKFLOW_MAIN_AGENT_DEFINITION_ID,
      revision,
      runtimeKind: 'mousse',
      settings,
      systemPrompt,
      visualRevision: revision
    })
  }

  private async lookupFor(runtimeKind: AgentRuntimeKind, projectPath: string | undefined, kind: 'main' | 'user') {
    const actor: IntegrationActor = kind === 'main' ? { kind: 'main' } : { kind: 'agent', agentType: runtimeKind }
    const [effective, tools] = await Promise.all([
      this.services.platform.integrations.effectiveForActor(actor, projectPath),
      this.services.mcpManager.getEnabledTools(projectPath, actor)
    ])
    this.assertActive()
    const settings = this.services.settings.get().integrations.tools
    const builtinToolIds = settings.enabled
      ? MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group !== 'devgui' && settings.enabledTools.includes(tool.id)).map((tool) => tool.id)
      : []
    return new StaticAgentIntegrationLookup({
      skills: effective.skills.map((skill) => ({ id: skill.installationId ?? skill.id, revision: skill.revision, hash: skill.contentHash, available: true })),
      mcpTools: tools.map((tool) => ({ serverId: tool.installationId ?? tool.serverId, toolName: tool.toolName, revision: tool.configRevision, hash: tool.configRevision, available: !tool.schemaError })),
      builtinToolIds
    })
  }

  private assertDeclaredDependency(record: WorkflowRecordSnapshot, ref: AgentRef, resolved: ResolvedAgentDefinition): void {
    for (const dependency of record.compiled.dependencies.filter((item) => item.kind === 'agent' && item.id === ref.definitionId)) {
      if (dependency.revision && dependency.revision !== resolved.revision) throw new DomainRpcError('stale_revision', 'Declared agent revision is unavailable')
      if (dependency.hash && dependency.hash !== resolved.revision && dependency.hash !== resolved.dependencyHashes[dependency.id ?? '']) {
        throw new DomainRpcError('stale_revision', 'Declared agent hash is unavailable')
      }
    }
  }

  private assertSupported(resolved: ResolvedAgentDefinition, projectPath?: string): void {
    if (resolved.runtimeKind !== 'mousse') {
      throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'External CLI execution is not yet bound to the workflow agent adapter', {
        details: { runtimeKind: resolved.runtimeKind, hostBindings: ['qualified CLI process lifecycle'] }
      })
    }
    if (resolved.settings.memory.scope !== 'thread' && resolved.settings.memory.scope !== 'off') {
      throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'Persistent agent memory is not yet bound to workflow agent runs', { pointer: '/settings/memory/scope' })
    }
    if (resolved.settings.context.selectedFiles.length > 0) {
      throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'Workflow agent runs cannot bind selected project files from definition settings', {
        pointer: '/settings/context/selectedFiles'
      })
    }
    const host: AgentRuntimeHostBindings = {
      workspaceRoots: projectPath ? [projectPath] : [],
      approveToolRequest: () => Promise.resolve({ status: 'denied' }),
      ...(this.browserRuntime ? { browserRuntime: this.browserRuntime } : {})
    }
    const unsupported = collectUnsupportedRuntimeSettings(resolved, host)
    if (unsupported.length === 0) return
    throw new AgentDefinitionError(
      'SETTINGS_UNSUPPORTED',
      `Agent runtime cannot authoritatively implement ${unsupported.map((item) => item.pointer).join(', ')}.`,
      {
        details: {
          pointers: unsupported.map((item) => item.pointer),
          reasons: Object.fromEntries(unsupported.map((item) => [item.pointer, item.reason])),
          hostBindings: Object.fromEntries(unsupported.filter((item) => item.hostBinding).map((item) => [item.pointer, item.hostBinding]))
        }
      }
    )
  }

  private async invoke(request: Parameters<AgentExecutorAdapter['invoke']>[0]) {
    try {
      return await this.invokeOwned(request)
    } catch (error) {
      throw mapAgentError(error)
    }
  }

  private async invokeOwned(request: Parameters<AgentExecutorAdapter['invoke']>[0]) {
    const { context, policy, signal } = request
    if (signal.aborted) throw new DomainRpcError('cancelled', 'Workflow agent call cancelled')
    const { bindings, projectPath, manifest } = await this.scope(context, policy)
    const pin = matchPin(bindings.pins, request.agent)
    if (!pin) throw new DomainRpcError('dependency_missing', 'Agent was not admitted for this workflow')
    if (request.agent.kind === 'user' && request.agent.definitionId && pin.definitionId !== request.agent.definitionId) {
      throw new DomainRpcError('stale_revision', 'Pinned agent definition does not match this node')
    }
    if (request.agent.revision && pin.revision !== request.agent.revision && pin.requestedRevision !== request.agent.revision) {
      throw new DomainRpcError('stale_revision', 'Pinned agent revision does not match this node')
    }
    if (!policy.allowedTools.includes('workflow.agent') || !policy.allowedCapabilities.includes('model.invoke')) {
      throw new DomainRpcError('capability_denied', 'Agent was not admitted for this workflow')
    }
    const stored = this.readSnapshot(pin.snapshotHash)
    if (stored.profileId !== context.profileId || stored.definitionId !== pin.definitionId || stored.revision !== pin.revision) {
      throw new DomainRpcError('stale_revision', 'Agent snapshot identity does not match its pin')
    }
    const existing = this.readInvocation(request.idempotencyKey)
    if (existing) {
      if (existing.profileId !== context.profileId || existing.requestId !== manifest.requestId || existing.runId !== context.runId) {
        throw new DomainRpcError('profile_mismatch', 'Workflow agent invocation identity does not match this run')
      }
      if (existing.state === 'dispatched') throw new DomainRpcError('unknown_effect', 'Agent effect was dispatched without a durable result')
      if (existing.state === 'cancelled') throw new DomainRpcError('cancelled', existing.error?.message ?? 'Workflow agent call cancelled')
      if (existing.state === 'failed') throw new DomainRpcError(existing.error?.code ?? 'invalid_input', existing.error?.message ?? 'Workflow agent call failed')
      return { output: existing.output, tokens: existing.tokens, cost: existing.cost }
    }
    await this.assertLiveGrants(stored, projectPath)
    const resolved = this.applyNode(stored, request)
    resolved.grants = this.narrowGrants(resolved.grants, policy)
    const workspace = this.workspace(projectPath, request.idempotencyKey)
    const host: AgentRuntimeHostBindings & { browserRuntime?: BrowserRuntimePort } = {
      workspaceRoots: [workspace],
      approveToolRequest: (approval) => this.approve(approval),
      ...(this.browserRuntime ? { browserRuntime: this.browserRuntime } : {})
    }
    try {
      this.writeInvocation({
        version: 1,
        profileId: context.profileId,
        idempotencyKey: request.idempotencyKey,
        requestId: manifest.requestId!,
        runId: context.runId!,
        state: 'dispatched'
      }, true)
    } catch (error) {
      const raced = this.readInvocation(request.idempotencyKey)
      if (raced) {
        if (raced.state === 'dispatched') throw new DomainRpcError('unknown_effect', 'Agent effect was dispatched without a durable result')
        if (raced.state === 'cancelled') throw new DomainRpcError('cancelled', raced.error?.message ?? 'Workflow agent call cancelled')
        if (raced.state === 'failed') throw new DomainRpcError(raced.error?.code ?? 'invalid_input', raced.error?.message ?? 'Workflow agent call failed')
        return { output: raced.output, tokens: raced.tokens, cost: raced.cost }
      }
      throw error
    }
    if (signal.aborted) {
      this.writeInvocation({
        version: 1, profileId: context.profileId, idempotencyKey: request.idempotencyKey,
        requestId: manifest.requestId!, runId: context.runId!, state: 'cancelled',
        error: { code: 'cancelled', message: 'Workflow agent call cancelled' }
      })
      throw new DomainRpcError('cancelled', 'Workflow agent call cancelled')
    }
    await this.scope(context, policy)
    const userMessage = userMessageFromInput(request.input)
    try {
      const result = await this.services.orchestrator.runAgentDefinition({
        profileId: context.profileId,
        resolved,
        threadId: context.threadId,
        projectPath: workspace,
        input: userMessage,
        runId: request.idempotencyKey,
        source: agentSource(context.source),
        host,
        context: {
          profileId: context.profileId,
          threadId: context.threadId,
          definitionId: resolved.definitionId,
          history: [],
          selectedFiles: [],
          memory: { scope: resolved.settings.memory.scope, entries: [] }
        },
        budget: {
          maxToolCalls: policy.maxToolCalls,
          maxElapsedMs: policy.maxElapsedMs
        },
        signal
      })
      return this.finishInvocation(request.idempotencyKey, result, Boolean(request.outputSchema), signal)
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError') || (error instanceof Error && error.name === 'AbortError')) {
        this.writeInvocation({
          version: 1, profileId: context.profileId, idempotencyKey: request.idempotencyKey,
          requestId: manifest.requestId!, runId: context.runId!, state: 'cancelled',
          error: { code: 'cancelled', message: 'Workflow agent call cancelled' }
        })
        throw new DomainRpcError('cancelled', 'Workflow agent call cancelled')
      }
      throw error
    }
  }

  private applyNode(snapshot: ResolvedAgentDefinition, request: Parameters<AgentExecutorAdapter['invoke']>[0]): ResolvedAgentDefinition {
    const clone = structuredClone(snapshot)
    if (request.outputSchema) {
      clone.settings.output = { ...clone.settings.output, format: 'schema', jsonSchema: request.outputSchema as Record<string, unknown> }
    }
    clone.instructions = compileAgentInstructions({
      applicationRules: clone.instructions.applicationRules,
      profileProjectContext: clone.instructions.profileProjectContext,
      definitionInstructions: clone.instructions.definitionInstructions,
      workflowNodeInstructions: request.instructions,
      task: userMessageFromInput(request.input),
      output: clone.settings.output
    })
    return clone
  }

  private async assertLiveGrants(snapshot: ResolvedAgentDefinition, projectPath: string | undefined): Promise<void> {
    const lookup = await this.lookupFor(snapshot.runtimeKind, projectPath, snapshot.definitionId === WORKFLOW_MAIN_AGENT_DEFINITION_ID ? 'main' : 'user')
    const builtinIds = new Set(lookup.listProfileBuiltinToolIds())
    for (const grant of snapshot.grants.builtinTools) {
      if (!builtinIds.has(grant.id)) throw new DomainRpcError('capability_denied', `Agent tool grant was revoked after workflow admission: ${grant.id}`)
    }
    for (const grant of snapshot.grants.skills) {
      const live = lookup.getSkill(grant.id)
      if (!live?.available) throw new DomainRpcError('capability_denied', `Agent Skill grant was revoked after workflow admission: ${grant.id}`)
      if ((grant.hash && live.hash !== grant.hash) || (grant.revision && live.revision !== grant.revision && live.hash !== grant.revision)) {
        throw new DomainRpcError('stale_revision', `Agent Skill changed after workflow admission: ${grant.id}`)
      }
    }
    for (const grant of snapshot.grants.mcpTools) {
      const live = lookup.getMcpTool(grant.serverId, grant.toolName)
      if (!live?.available) throw new DomainRpcError('capability_denied', `Agent MCP grant was revoked after workflow admission: ${grant.id}`)
      if ((grant.hash && live.hash !== grant.hash) || (grant.revision && live.revision !== grant.revision && live.hash !== grant.revision)) {
        throw new DomainRpcError('stale_revision', `Agent MCP configuration changed after workflow admission: ${grant.id}`)
      }
    }
  }

  private narrowGrants(grants: EffectiveAgentGrants, policy: ExecutionPolicySnapshot): EffectiveAgentGrants {
    const denied = [...grants.denied]
    const skills = grants.skills.filter((skill) => {
      if (!policy.allowedCapabilities.includes('skill.load')) {
        denied.push({ kind: 'skill', id: skill.id, reason: 'Workflow policy does not grant Skill context.' })
        return false
      }
      return true
    })
    const builtinTools = grants.builtinTools.filter((tool) => {
      const effect = effectForTool(tool.id, false)
      const capability = capabilityForTool(tool.id, false)
      if (!policy.allowedTools.includes(tool.id) || !policy.allowedEffects.includes(effect) || (capability && !policy.allowedCapabilities.includes(capability))) {
        denied.push({ kind: 'tool', id: tool.id, reason: 'Workflow policy does not grant this tool.' })
        return false
      }
      return true
    })
    const mcpTools = grants.mcpTools.filter((tool) => {
      if (!policy.allowedTools.includes(`mcp:${tool.serverId}/${tool.toolName}`) || !policy.allowedEffects.includes('external') || !policy.allowedCapabilities.includes('mcp.invoke')) {
        denied.push({ kind: 'mcp', id: tool.id, reason: 'Workflow policy does not grant MCP dispatch.' })
        return false
      }
      return true
    })
    return { skills, mcpTools, builtinTools, denied }
  }

  private finishInvocation(idempotencyKey: string, result: AgentExecutionResult, expectSchema: boolean, signal: AbortSignal) {
    const tokens = result.usage.totalTokens
    const cost = result.usage.costUsd
    const current = this.readInvocation(idempotencyKey)
    const requestId = current?.requestId ?? ''
    const runId = current?.runId ?? ''
    if (result.status === 'cancelled' || signal.aborted) {
      this.writeInvocation({
        version: 1, profileId: this.services.profileId, idempotencyKey, requestId, runId,
        state: 'cancelled', tokens, cost, error: { code: 'cancelled', message: result.error?.message ?? 'Workflow agent call cancelled' }
      })
      throw new DomainRpcError('cancelled', result.error?.message ?? 'Workflow agent call cancelled')
    }
    if (result.status !== 'completed') {
      const code = result.error?.code === 'BUDGET_EXCEEDED' ? 'budget_exceeded'
        : result.error?.code === 'SETTINGS_UNSUPPORTED' ? 'executor_unavailable'
          : result.error?.code === 'OUTPUT_INVALID' ? 'invalid_input'
            : 'invalid_input'
      this.writeInvocation({
        version: 1, profileId: this.services.profileId, idempotencyKey, requestId, runId,
        state: 'failed', tokens, cost, error: { code, message: result.error?.message ?? 'Workflow agent call failed' }
      })
      throw new DomainRpcError(code, result.error?.message ?? 'Workflow agent call failed', result.error?.details)
    }
    const output = parseOutput(result.text, expectSchema)
    this.writeInvocation({
      version: 1,
      profileId: this.services.profileId,
      idempotencyKey,
      requestId,
      runId,
      state: 'completed',
      output,
      tokens,
      cost
    })
    return { output, tokens, cost }
  }

  private async approve(request: AgentRuntimeToolApprovalRequest) {
    if (this.stopped) return { status: 'cancelled' as const }
    const argumentsJson = canonicalJson(request.arguments)
    if (Buffer.byteLength(argumentsJson, 'utf8') > APPROVAL_ARGUMENT_MAX_BYTES || sha256Hex(argumentsJson) !== request.argumentDigest) {
      return { status: 'denied' as const }
    }
    try {
      const answers = await this.services.questions.requestAnswers([{
        id: 'approval',
        prompt: `Allow ${request.canonicalToolName}?\nDigest: ${request.argumentDigest}\nArguments: ${argumentsJson}`,
        options: [{ id: 'approve', label: 'Allow this action' }, { id: 'reject', label: 'Reject' }]
      }], request.threadId)
      return { status: !this.stopped && answers.approval === 'approve' ? 'approved' as const : 'denied' as const, digest: request.argumentDigest }
    } catch {
      return { status: 'cancelled' as const }
    }
  }

  private async scope(context: ExecutionContext, policy?: ExecutionPolicySnapshot) {
    const projectPath = this.project(context.profileId, context.projectId)
    const thread = this.services.threads.getThread(context.threadId)
    if (!thread || thread.settledAt || thread.projectId !== context.projectId || !context.runId) throw new DomainRpcError('thread_unavailable', 'Workflow agent thread is unavailable')
    const manifest = await this.run(context)
    if (
      manifest.profileId !== context.profileId || manifest.threadId !== context.threadId || manifest.projectId !== context.projectId
      || manifest.runId !== context.runId || manifest.policySnapshotId !== context.policySnapshotId || manifest.cancellationId !== context.cancellationId
      || context.turnId !== manifest.runId || context.source !== manifest.source || stableStringify(context.actor) !== stableStringify(manifest.actor)
    ) throw new DomainRpcError('profile_mismatch', 'Workflow agent execution context is not owned by this run')
    if (manifest.state !== 'running') throw new DomainRpcError('capability_denied', 'Workflow agent run is not executing')
    if (policy && (
      policy.version !== 1 || policy.id !== manifest.policySnapshotId || policy.profileId !== manifest.profileId
      || this.services.platform.workflowRuns.policy.snapshot(context.profileId, policy).id !== policy.id
    )) throw new DomainRpcError('capability_denied', 'Workflow agent policy differs from its admitted snapshot')
    const fromManifest = this.bindingsFromManifest(manifest)
    const admission = this.readAdmission(manifest.requestId ?? '')
    const bindings = fromManifest ?? admission.bindings
    if (!bindings || bindings.version !== 1 || bindings.profileId !== context.profileId) {
      throw new DomainRpcError('dependency_missing', 'Run has no admitted agent snapshot; start a new run')
    }
    if (admission.record.profileId !== context.profileId || (admission.record.projectId ?? undefined) !== context.projectId) {
      throw new DomainRpcError('profile_mismatch', 'Admitted agent snapshot does not match this profile or project')
    }
    if (admission.record.snapshotDigest !== bindings.snapshotDigest) throw new DomainRpcError('stale_revision', 'Admitted agent snapshot digest does not match the run')
    this.checkBindings(bindings)
    this.project(context.profileId, context.projectId)
    return { bindings, projectPath, manifest }
  }

  private bindingsFromManifest(manifest: WorkflowRunManifest): WorkflowAgentExecutionBindings | undefined {
    const raw = manifest.executionBindings as (typeof manifest.executionBindings & { agents?: WorkflowAgentExecutionBindings }) | undefined
    const agents = raw?.[WORKFLOW_AGENT_BINDINGS_FIELD]
    if (!agents) return undefined
    if (agents.version !== 1 || agents.profileId !== manifest.profileId || !hash(agents.snapshotDigest) || !Array.isArray(agents.pins)) {
      throw new DomainRpcError('invalid_input', 'Workflow agent bindings are malformed')
    }
    this.checkBindings(agents)
    return agents
  }

  private bindingsOf(profileId: string, pins: WorkflowAgentPin[]): WorkflowAgentExecutionBindings {
    const bindings: WorkflowAgentExecutionBindings = {
      version: 1,
      profileId,
      snapshotDigest: sha256Hex(canonicalJson({ profileId, pins })),
      pins
    }
    this.checkBindings(bindings)
    return bindings
  }

  private checkBindings(bindings: WorkflowAgentExecutionBindings): void {
    if (Buffer.byteLength(JSON.stringify(bindings), 'utf8') > WORKFLOW_AGENT_BINDINGS_MAX_BYTES) {
      throw new DomainRpcError('invalid_input', 'Workflow agent snapshot exceeds 8 MiB')
    }
    const seen = new Set<string>()
    for (const pin of bindings.pins) {
      if (!isPlainObject(pin) || (pin.kind !== 'main' && pin.kind !== 'user') || !identity(pin.definitionId) || !hash(pin.revision) || !hash(pin.snapshotHash) || typeof pin.runtimeKind !== 'string') {
        throw new DomainRpcError('invalid_input', 'Workflow agent pin is malformed')
      }
      const key = stableStringify([pin.kind, pin.requestedDefinitionId, pin.requestedRevision, pin.definitionId])
      if (seen.has(key)) throw new DomainRpcError('invalid_input', 'Workflow agent snapshot has duplicate identities')
      seen.add(key)
    }
  }

  private project(profileId: string, projectId?: string): string | undefined {
    this.assertActive()
    if (profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow agent belongs to another profile')
    const project = projectId ? this.services.projects.getProject(projectId) : undefined
    if (projectId && !project) throw new DomainRpcError('project_unavailable', 'Workflow agent project is unavailable')
    return project?.path
  }

  private workspace(projectPath: string | undefined, idempotencyKey: string): string {
    if (projectPath) return realpathSync(projectPath)
    const digest = hash(idempotencyKey) ? idempotencyKey.toLowerCase() : sha256Hex(idempotencyKey)
    const path = join(this.root, 'workspaces', digest)
    this.assertRoot()
    assertOwnedPath(this.root, path)
    mkdirSync(path, { recursive: true })
    return realpathSync(path)
  }

  private writeSnapshot(snapshot: ResolvedAgentDefinition): string {
    const snapshotHash = sha256Hex(canonicalJson(snapshot))
    const path = join(this.root, 'snapshots', snapshotHash + '.json')
    this.assertRoot()
    assertOwnedPath(this.root, path)
    if (existsSync(path)) {
      const existing = this.readSnapshot(snapshotHash)
      if (sha256Hex(canonicalJson(existing)) !== snapshotHash) throw new DomainRpcError('stale_revision', 'Agent snapshot artifact is corrupt')
      return snapshotHash
    }
    const record: SnapshotRecord = { version: 1, profileId: this.services.profileId, snapshotHash, snapshot }
    const stored = this.withIntegrity(record)
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > WORKFLOW_AGENT_SNAPSHOT_MAX_BYTES) {
      throw new DomainRpcError('invalid_input', 'Workflow agent snapshot exceeds its bound')
    }
    durableExclusiveWriteSync(path, `${JSON.stringify(stored, null, 2)}\n`)
    return snapshotHash
  }

  private readSnapshot(snapshotHash: string): ResolvedAgentDefinition {
    if (!hash(snapshotHash)) throw new DomainRpcError('invalid_input', 'Workflow agent snapshot hash is malformed')
    const path = join(this.root, 'snapshots', snapshotHash + '.json')
    this.assertRoot()
    assertOwnedPath(this.root, path)
    const record = JSON.parse(this.readBounded(path, WORKFLOW_AGENT_SNAPSHOT_MAX_BYTES)) as SnapshotRecord
    this.assertIntegrity(record)
    if (record.version !== 1 || record.profileId !== this.services.profileId || record.snapshotHash !== snapshotHash || record.snapshot?.profileId !== this.services.profileId) {
      throw new DomainRpcError('stale_revision', 'Agent snapshot artifact ownership is invalid')
    }
    if (sha256Hex(canonicalJson(record.snapshot)) !== snapshotHash) throw new DomainRpcError('stale_revision', 'Agent snapshot artifact is corrupt')
    return structuredClone(record.snapshot)
  }

  private writeAdmission(record: AdmissionRecord): void {
    const path = join(this.root, 'admissions', record.requestId + '.json')
    this.assertRoot()
    assertOwnedPath(this.root, path)
    if (existsSync(path)) {
      const existing = this.readAdmission(record.requestId)
      if (existing.record.snapshotDigest !== record.snapshotDigest || existing.record.profileId !== record.profileId) {
        throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'This request identity was already used for a different agent snapshot')
      }
      return
    }
    const stored = this.withIntegrity(record)
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > SNAPSHOT_RECORD_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow agent admission exceeds its bound')
    durableExclusiveWriteSync(path, `${JSON.stringify(stored, null, 2)}\n`)
  }

  private readAdmission(requestId: string): { record: AdmissionRecord; bindings: WorkflowAgentExecutionBindings } {
    if (!WORKFLOW_UUID_PATTERN.test(requestId)) throw new DomainRpcError('dependency_missing', 'Run has no admitted agent snapshot; start a new run')
    const path = join(this.root, 'admissions', requestId + '.json')
    this.assertRoot()
    if (!existsSync(path)) throw new DomainRpcError('dependency_missing', 'Run has no admitted agent snapshot; start a new run')
    assertOwnedPath(this.root, path)
    const record = JSON.parse(this.readBounded(path, SNAPSHOT_RECORD_MAX_BYTES)) as AdmissionRecord
    this.assertIntegrity(record)
    if (record.version !== 1 || record.profileId !== this.services.profileId || record.requestId !== requestId || !hash(record.snapshotDigest) || !Array.isArray(record.pins)) {
      throw new DomainRpcError('stale_revision', 'Workflow agent admission ownership is invalid')
    }
    const bindings = this.bindingsOf(record.profileId, record.pins)
    if (bindings.snapshotDigest !== record.snapshotDigest) throw new DomainRpcError('stale_revision', 'Workflow agent admission digest is corrupt')
    return { record, bindings }
  }

  private invocationPath(idempotencyKey: string): string {
    const digest = hash(idempotencyKey) ? idempotencyKey.toLowerCase() : sha256Hex(idempotencyKey)
    return join(this.root, 'invocations', digest + '.json')
  }

  private writeInvocation(record: InvocationRecord, exclusive = false): void {
    const path = this.invocationPath(record.idempotencyKey)
    this.assertRoot()
    assertOwnedPath(this.root, path)
    const current = exclusive ? undefined : this.readInvocation(record.idempotencyKey)
    const merged: InvocationRecord = {
      ...record,
      requestId: record.requestId || current?.requestId || '',
      runId: record.runId || current?.runId || ''
    }
    const stored = this.withIntegrity(merged)
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > INVOCATION_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow agent invocation exceeds its bound')
    if (exclusive) durableExclusiveWriteSync(path, `${JSON.stringify(stored, null, 2)}\n`)
    else atomicWriteJsonSync(path, stored)
  }

  private readInvocation(idempotencyKey: string): InvocationRecord | undefined {
    const path = this.invocationPath(idempotencyKey)
    this.assertRoot()
    if (!existsSync(path)) return undefined
    assertOwnedPath(this.root, path)
    const record = JSON.parse(this.readBounded(path, INVOCATION_MAX_BYTES)) as InvocationRecord
    this.assertIntegrity(record)
    if (record.version !== 1 || record.profileId !== this.services.profileId) throw new DomainRpcError('stale_revision', 'Workflow agent invocation ownership is invalid')
    return record
  }

  private withIntegrity<T extends { integrity?: string }>(record: T): T {
    const { integrity: _ignored, ...body } = record
    return { ...body, integrity: sha256Hex(canonicalJson(body)) } as T
  }

  private assertIntegrity<T extends { integrity?: string }>(record: T): void {
    const { integrity, ...body } = record
    if (typeof integrity !== 'string' || integrity !== sha256Hex(canonicalJson(body))) {
      throw new DomainRpcError('stale_revision', 'Workflow agent artifact integrity is invalid')
    }
  }

  private readBounded(path: string, maxBytes: number): string {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new DomainRpcError('invocation_unavailable', 'Workflow agent artifact is not a bounded regular file')
    const fd = openSync(path, 'r')
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new DomainRpcError('invocation_unavailable', 'Workflow agent artifact changed')
      const bytes = Buffer.alloc(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0)
      if (count > stat.size) throw new DomainRpcError('invocation_unavailable', 'Workflow agent artifact grew while reading')
      return bytes.subarray(0, count).toString('utf8')
    } finally { closeSync(fd) }
  }

  private assertRoot(): void {
    assertOwnedPath(this.services.getProfileHomeDir(), this.root)
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.canonicalRoot) throw new DomainRpcError('invocation_unavailable', 'Workflow agent binding directory changed')
  }

  private assertActive(): void {
    if (this.stopped) throw new DomainRpcError('profile_unavailable', 'Workflow agent services are stopped')
  }
}
