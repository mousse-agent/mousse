import Ajv from 'ajv'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../shared/execution/types'
import type { IntegrationActor } from '../../shared/integrations/actor'
import type { McpToolDescriptor } from '../../shared/integrations'
import { isPlainObject, stableStringify, type CompiledGraph, type McpExecutorAdapter, type SkillLoaderAdapter, type StartWorkflowRequest, type WorkflowRunManifest } from '../../shared/workflows'
import { WORKFLOW_EXECUTION_BINDINGS_MAX_BYTES, type WorkflowExecutionBindings } from '../../shared/workflows/executionBindings'
import type { MmsProfileServices } from '../MmsProfileServices'
import { DomainRpcError } from '../protocol/domainRegistry'
import { sha256Utf8 } from '../workflows/hash'
import type { WorkflowRecordSnapshot } from '../workflows/registry/WorkflowRegistry'
import { collectTransitiveWorkflowRecords, collectWorkflowIntegrationRefs, inheritChildAdmission, isChildAdmissionError } from '../workflows/engine/childAdmission'
import { splitSkillMarkdown } from '../integrations/skills/yamlFrontmatter'

const SKILL_MAX_BYTES = 1024 * 1024
const SCHEMA_MAX_BYTES = 256 * 1024
const RESULT_MAX_BYTES = 4 * 1024 * 1024
const workflowActor = (runId?: string): IntegrationActor => ({ kind: 'workflow', agentType: 'mousse', runId })
const schemaIdentity = (tool: { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }): string => sha256Utf8(stableStringify({ input: tool.inputSchema, output: tool.outputSchema }))

/** Profile-bound preparation and dispatch over the production integration services. */
export class MmsWorkflowIntegrations {
  readonly mcp: McpExecutorAdapter = { kind: 'mcp', invoke: (request) => this.invokeMcp(request) }
  readonly skill: SkillLoaderAdapter = { kind: 'skill', load: (request) => this.loadSkill(request) }
  private stopped = false

  constructor(private readonly services: MmsProfileServices, private readonly run: (context: ExecutionContext) => Promise<WorkflowRunManifest>) {}

  dispose(): void { this.stopped = true }

  async prepare(request: StartWorkflowRequest, record: WorkflowRecordSnapshot) {
    const projectPath = this.project(request.profileId, request.projectId)
    const bindings: WorkflowExecutionBindings = { version: 1, profileId: request.profileId, skills: [], mcpTools: [] }
    const skillRefs = new Map<string, { id: string; revision?: string }>()
    const mcpRefs = new Map<string, { serverId: string; toolName: string }>()
    const addRefs = (graph: CompiledGraph): void => {
      const refs = collectWorkflowIntegrationRefs(graph)
      for (const ref of refs.skills) skillRefs.set(stableStringify(ref), ref)
      for (const ref of refs.mcpTools) mcpRefs.set(stableStringify(ref), ref)
    }
    addRefs(record.compiled.graph)
    try {
      for (const child of collectTransitiveWorkflowRecords(record, this.services.platform.workflowDefinitions)) addRefs(child.compiled.graph)
    } catch (error) {
      if (isChildAdmissionError(error) || (error instanceof DomainRpcError)) throw error instanceof DomainRpcError ? error : new DomainRpcError(error.code, error.message)
      throw new DomainRpcError('dependency_missing', error instanceof Error ? error.message : 'Pinned child workflow revision is unavailable')
    }
    if (!skillRefs.size && !mcpRefs.size) return { bindings, installationPolicy: request.installationPolicy }

    // Refresh metadata before pinning. This does not invoke an MCP tool.
    this.services.skillsRegistry.invalidateDiscoveryCache()
    this.services.mcpManager.invalidateDiscoveryCache()
    const effective = await this.services.platform.integrations.effectiveForActor(workflowActor(), projectPath)
    this.project(request.profileId, request.projectId)
    for (const ref of skillRefs.values()) {
      const matches = effective.skills.filter((skill) => skill.id === ref.id || skill.installationId === ref.id)
      if (matches.length !== 1) throw new DomainRpcError('dependency_missing', 'Workflow Skill must identify one enabled installation: ' + ref.id)
      const skill = matches[0]
      if (skill.profileId && skill.profileId !== request.profileId) throw new DomainRpcError('profile_mismatch', 'Skill belongs to another profile')
      const id = skill.installationId ?? skill.id
      const loaded = ref.revision && ref.revision !== skill.contentHash
        ? await this.services.skillsRegistry.readSkillRevision(id, ref.revision, { projectPath })
        : await this.services.skillsRegistry.readSkill(id, { projectPath })
      const hash = sha256Utf8(loaded.content)
      if (Buffer.byteLength(loaded.content, 'utf8') > SKILL_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow Skill exceeds 1 MiB')
      if (hash !== (ref.revision ?? skill.contentHash)) throw new DomainRpcError('stale_revision', 'Skill changed while preparing this workflow')
      bindings.skills.push({ requestedId: ref.id, requestedRevision: ref.revision, installationId: id, revision: hash, contentHash: hash, name: skill.name, content: loaded.content })
      this.checkSize(bindings)
    }

    for (const ref of mcpRefs.values()) {
      const servers = effective.servers.filter((server) => server.id === ref.serverId || server.installationId === ref.serverId)
      if (servers.length !== 1) throw new DomainRpcError('dependency_missing', 'Workflow MCP tool must identify one enabled server installation: ' + ref.serverId)
      const server = servers[0], id = server.installationId ?? server.id
      if (server.profileId && server.profileId !== request.profileId) throw new DomainRpcError('profile_mismatch', 'MCP installation belongs to another profile')
      const actor = { ...workflowActor(), mcpServerIds: [id], mcpToolIds: [id + '/' + ref.toolName] }
      const tools = await this.services.mcpManager.getEnabledToolsForServer(id, projectPath, actor)
      const tool = this.exactTool(tools, id, ref.toolName)
      if (!tool.configRevision || tool.configRevision !== server.configRevision) throw new DomainRpcError('stale_revision', 'MCP configuration changed while preparing this workflow')
      for (const dependency of record.compiled.dependencies.filter((item) => item.kind === 'mcp-tool' && [ref.serverId + '/' + ref.toolName, id + '/' + ref.toolName].includes(item.id))) {
        if ((dependency.revision && dependency.revision !== tool.configRevision) || (dependency.hash && dependency.hash !== tool.configRevision)) throw new DomainRpcError('stale_revision', 'Declared MCP revision is unavailable')
      }
      if (Buffer.byteLength(stableStringify({ input: tool.inputSchema, output: tool.outputSchema }), 'utf8') > SCHEMA_MAX_BYTES) throw new DomainRpcError('invalid_input', 'MCP schema exceeds its workflow bound')
      bindings.mcpTools.push({ requestedServerId: ref.serverId, installationId: id, toolName: ref.toolName, configRevision: tool.configRevision, inputSchema: structuredClone(tool.inputSchema), outputSchema: structuredClone(tool.outputSchema) })
      this.checkSize(bindings)
    }
    this.project(request.profileId, request.projectId)
    return { bindings, installationPolicy: {
      ...request.installationPolicy,
      allowedTools: [...new Set([...(request.installationPolicy.allowedTools ?? []), ...bindings.mcpTools.map((tool) => `mcp:${tool.requestedServerId}/${tool.toolName}`)])],
      allowedCapabilities: [...new Set([...(request.installationPolicy.allowedCapabilities ?? []), ...(bindings.mcpTools.length ? ['mcp.invoke'] : []), ...(bindings.skills.length ? ['skill.load'] : [])])]
    } }
  }

  /** Subset the parent's persisted pins. Never resolves current Skill/MCP heads. */
  prepareChildAdmission(request: StartWorkflowRequest, parent: WorkflowRunManifest, child: WorkflowRecordSnapshot) {
    this.project(request.profileId, request.projectId ?? parent.projectId)
    try {
      const prepared = inheritChildAdmission({ parent, child, request })
      this.checkSize(prepared.executionBindings)
      this.project(request.profileId, request.projectId ?? parent.projectId)
      return prepared
    } catch (error) {
      if (error instanceof DomainRpcError) throw error
      if (isChildAdmissionError(error)) throw new DomainRpcError(error.code, error.message)
      throw new DomainRpcError('dependency_missing', error instanceof Error ? error.message : 'Child workflow admission failed')
    }
  }

  private async invokeMcp(request: Parameters<McpExecutorAdapter['invoke']>[0]) {
    const { context, policy, signal } = request
    if (signal.aborted) throw new DomainRpcError('cancelled', 'Workflow MCP call cancelled')
    const { bindings, projectPath } = await this.scope(context, policy)
    const pin = bindings.mcpTools.find((tool) => tool.requestedServerId === request.serverId && tool.toolName === request.toolName)
    if (!pin || !policy.allowedTools.includes(`mcp:${request.serverId}/${request.toolName}`) || !policy.allowedCapabilities.includes('mcp.invoke') || !policy.allowedEffects.includes('external')) throw new DomainRpcError('capability_denied', 'MCP tool was not admitted for this workflow')
    if (!isPlainObject(request.input)) throw new DomainRpcError('invalid_input', 'MCP arguments must be a JSON object')
    const actor = { ...workflowActor(context.runId), mcpServerIds: [pin.installationId], mcpToolIds: [pin.installationId + '/' + pin.toolName] }
    this.services.mcpManager.invalidateDiscoveryCache()
    const current = await this.services.platform.integrations.effectiveForActor(workflowActor(context.runId), projectPath)
    if (!current.servers.some((server) => (server.installationId ?? server.id) === pin.installationId)) throw new DomainRpcError('capability_denied', 'MCP installation is no longer enabled for this workflow')
    const tools = await this.services.mcpManager.getEnabledToolsForServer(pin.installationId, projectPath, actor)
    const tool = this.exactTool(tools, pin.installationId, pin.toolName)
    if (tool.configRevision !== pin.configRevision || schemaIdentity(tool) !== schemaIdentity(pin)) throw new DomainRpcError('stale_revision', 'MCP configuration or schema changed since workflow admission')
    this.validateData(pin.inputSchema, request.input, 'MCP input')
    await this.scope(context, policy)
    if (signal.aborted) throw new DomainRpcError('cancelled', 'Workflow MCP call cancelled')
    const result = await this.services.mcpManager.callTool(tool.providerName, request.input, projectPath, signal, actor, {
      ...pin, requireProfileSelection: true, assertExecutionActive: async () => { await this.scope(context, policy) }
    })
    if (result.isError) throw new DomainRpcError('mcp_tool_error', result.text.slice(0, 2000) || 'MCP tool returned an error')
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > RESULT_MAX_BYTES) throw new DomainRpcError('budget_exceeded', 'MCP result exceeds 4 MiB')
    if (pin.outputSchema) this.validateData(pin.outputSchema, result.structuredContent, 'MCP structured output')
    return { output: { content: result.content, structuredContent: result.structuredContent, text: result.text, provenance: result.provenance }, effect: 'external' as const }
  }

  private async loadSkill(request: Parameters<SkillLoaderAdapter['load']>[0]) {
    const { bindings, projectPath } = await this.scope(request.context)
    const pin = bindings.skills.find((skill) => skill.requestedId === request.skillId && skill.requestedRevision === request.revision)
    if (!pin || sha256Utf8(pin.content) !== pin.contentHash) throw new DomainRpcError('stale_revision', 'Skill snapshot is missing or corrupt')
    this.services.skillsRegistry.invalidateDiscoveryCache()
    const effective = await this.services.platform.integrations.effectiveForActor(workflowActor(request.context.runId), projectPath)
    if (!effective.skills.some((skill) => (skill.installationId ?? skill.id) === pin.installationId)) throw new DomainRpcError('capability_denied', 'Skill installation is no longer enabled for this workflow')
    await this.scope(request.context)
    return { skillContext: { installationId: pin.installationId, name: pin.name, revision: pin.revision, contentHash: pin.contentHash }, instructions: splitSkillMarkdown(pin.content).body }
  }

  private async scope(context: ExecutionContext, policy?: ExecutionPolicySnapshot) {
    const projectPath = this.project(context.profileId, context.projectId)
    const thread = this.services.threads.getThread(context.threadId)
    if (!thread || thread.settledAt || thread.projectId !== context.projectId || !context.runId) throw new DomainRpcError('thread_unavailable', 'Workflow integration thread is unavailable')
    const manifest = await this.run(context)
    if (manifest.profileId !== context.profileId || manifest.threadId !== context.threadId || manifest.projectId !== context.projectId || manifest.runId !== context.runId || manifest.policySnapshotId !== context.policySnapshotId || manifest.cancellationId !== context.cancellationId || context.turnId !== manifest.runId || context.source !== manifest.source || stableStringify(context.actor) !== stableStringify(manifest.actor)) throw new DomainRpcError('profile_mismatch', 'Workflow integration execution context is not owned by this run')
    if (manifest.state !== 'running') throw new DomainRpcError('capability_denied', 'Workflow integration run is not executing')
    if (policy && (policy.version !== 1 || policy.id !== manifest.policySnapshotId || policy.profileId !== manifest.profileId || this.services.platform.workflowRuns.policy.snapshot(context.profileId, policy).id !== policy.id)) throw new DomainRpcError('capability_denied', 'Workflow integration policy differs from its admitted snapshot')
    const bindings = manifest.executionBindings
    if (!bindings || bindings.version !== 1 || bindings.profileId !== context.profileId || !Array.isArray(bindings.skills) || !Array.isArray(bindings.mcpTools)) throw new DomainRpcError('dependency_missing', 'Run has no admitted integration snapshot; start a new run')
    this.checkSize(bindings)
    this.project(context.profileId, context.projectId)
    return { bindings, projectPath }
  }

  private project(profileId: string, projectId?: string): string | undefined {
    if (this.stopped) throw new DomainRpcError('profile_unavailable', 'Workflow integration services are stopped')
    if (profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow integration belongs to another profile')
    const project = projectId ? this.services.projects.getProject(projectId) : undefined
    if (projectId && !project) throw new DomainRpcError('project_unavailable', 'Workflow integration project is unavailable')
    return project?.path
  }

  private exactTool(tools: McpToolDescriptor[], installationId: string, name: string): McpToolDescriptor {
    const matches = tools.filter((tool) => (tool.installationId ?? tool.serverId) === installationId && tool.toolName === name && !tool.schemaError)
    if (matches.length !== 1) throw new DomainRpcError('dependency_missing', 'MCP tool is unavailable or its schema is unsupported')
    return matches[0]
  }

  private checkSize(bindings: WorkflowExecutionBindings): void {
    if (Buffer.byteLength(JSON.stringify(bindings), 'utf8') > WORKFLOW_EXECUTION_BINDINGS_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow integration snapshot exceeds 8 MiB')
    const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096
    const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    const seen = new Set<string>()
    for (const skill of bindings.skills) {
      if (!isPlainObject(skill) || !identity(skill.requestedId) || !identity(skill.installationId) || !identity(skill.name) || !hash(skill.contentHash) || skill.revision !== skill.contentHash || (skill.requestedRevision !== undefined && skill.requestedRevision !== skill.contentHash) || typeof skill.content !== 'string' || Buffer.byteLength(skill.content, 'utf8') > SKILL_MAX_BYTES || sha256Utf8(skill.content) !== skill.contentHash) throw new DomainRpcError('invalid_input', 'Workflow Skill snapshot is malformed or corrupt')
      const key = stableStringify(['skill', skill.requestedId, skill.requestedRevision])
      if (seen.has(key)) throw new DomainRpcError('invalid_input', 'Workflow Skill snapshot has duplicate identities')
      seen.add(key)
    }
    for (const tool of bindings.mcpTools) {
      if (!isPlainObject(tool) || !identity(tool.requestedServerId) || !identity(tool.installationId) || !identity(tool.toolName) || !hash(tool.configRevision) || (tool.inputSchema !== undefined && !isPlainObject(tool.inputSchema)) || (tool.outputSchema !== undefined && !isPlainObject(tool.outputSchema))) throw new DomainRpcError('invalid_input', 'Workflow MCP snapshot is malformed')
      if (Buffer.byteLength(stableStringify({ input: tool.inputSchema, output: tool.outputSchema }), 'utf8') > SCHEMA_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow MCP snapshot schema exceeds its bound')
      const key = stableStringify(['mcp', tool.requestedServerId, tool.toolName])
      if (seen.has(key)) throw new DomainRpcError('invalid_input', 'Workflow MCP snapshot has duplicate identities')
      seen.add(key)
    }
  }

  private validateData(schema: Record<string, unknown> | undefined, data: unknown, label: string): void {
    if (!schema) return
    try {
      const validate = new Ajv({ strict: false, allErrors: false, validateFormats: false }).compile(schema)
      if (!validate(data)) throw new DomainRpcError('invalid_input', label + ' does not match the admitted schema')
    } catch (error) {
      if (error instanceof DomainRpcError) throw error
      throw new DomainRpcError('schema_unsupported', label + ' schema cannot be validated')
    }
  }
}
