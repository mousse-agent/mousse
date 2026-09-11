import type { EffectClass, ExecutionContext, ExecutionPolicyLayer, ExecutionPolicySnapshot } from '../../shared/execution/types'
import { MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import { isPlainObject, stableStringify, type CompiledGraph, type StartWorkflowRequest, type ToolExecutorAdapter, type WorkflowRunManifest } from '../../shared/workflows'
import type { MmsProfileServices } from '../MmsProfileServices'
import { BuildModeTools } from '../orchestrator/BuildModeTools'
import { PiCodingTools } from '../orchestrator/PiCodingTools'
import { DomainRpcError } from '../protocol/domainRegistry'
import type { WorkflowRecordSnapshot } from '../workflows/registry/WorkflowRegistry'
import { collectTransitiveWorkflowRecords } from '../workflows/engine/childAdmission'

const INPUT_MAX_BYTES = 1024 * 1024
const RESULT_MAX_BYTES = 4 * 1024 * 1024
const PROJECT_TOOL_IDS = new Set(MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === 'project').map((tool) => tool.id))
const GIT_TOOL_IDS = new Set(['git_status', 'git_diff'])
const WRITE_TOOL_IDS = new Set(['write', 'edit'])

/** Profile-bound adapter for the catalog's generic built-in project-tool node. */
export class MmsWorkflowTools {
  readonly adapter: ToolExecutorAdapter = { kind: 'tool', invoke: (request) => this.invoke(request) }
  private readonly coding: PiCodingTools
  private readonly build: BuildModeTools
  private stopped = false

  constructor(
    private readonly services: MmsProfileServices,
    private readonly run: (context: ExecutionContext) => Promise<WorkflowRunManifest>
  ) {
    this.coding = new PiCodingTools(services.lineEditStats)
    this.build = new BuildModeTools(services.fileService, services.gitService, services.lineEditStats)
  }

  dispose(): void { this.stopped = true }

  /** Resolve only supported, currently enabled tools before durable admission. */
  prepare(request: StartWorkflowRequest, record: WorkflowRecordSnapshot, policy: ExecutionPolicyLayer): ExecutionPolicyLayer {
    this.assertActive()
    if (request.profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow tool profile mismatch')
    const ids = new Set<string>()
    const visit = (graph: CompiledGraph): void => {
      for (const node of graph.nodes) {
        if (node.type === 'tool') {
          const id = isPlainObject(node.config.tool) ? String(node.config.tool.id ?? '') : ''
          if (!PROJECT_TOOL_IDS.has(id)) throw new DomainRpcError('dependency_missing', `Workflow built-in tool is unavailable: ${id || '(missing)'}`)
          ids.add(id)
        }
        for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
      }
    }
    visit(record.compiled.graph)
    for (const child of collectTransitiveWorkflowRecords(record, this.services.platform.workflowDefinitions)) visit(child.compiled.graph)
    if (!ids.size) return policy
    if (!request.projectId || !this.services.projects.getProject(request.projectId)) throw new DomainRpcError('project_required', 'Workflow project tools require an owning project')
    const configured = this.services.settings.get().integrations.tools
    if (!configured.enabled) throw new DomainRpcError('capability_denied', 'Mousse project tools are disabled')
    for (const id of ids) if (!configured.enabledTools.includes(id)) throw new DomainRpcError('capability_denied', `Workflow built-in tool is disabled: ${id}`)
    return {
      ...policy,
      allowedTools: [...new Set([...(policy.allowedTools ?? []), ...ids])],
      allowedCapabilities: [...new Set([...(policy.allowedCapabilities ?? []), 'tool.invoke'])]
    }
  }

  private async invoke(request: Parameters<ToolExecutorAdapter['invoke']>[0]) {
    this.assertActive()
    if (request.signal.aborted) throw new DomainRpcError('cancelled', 'Workflow tool call cancelled')
    if (!PROJECT_TOOL_IDS.has(request.toolId)) throw new DomainRpcError('dependency_missing', `Workflow built-in tool is unavailable: ${request.toolId}`)
    if (!isPlainObject(request.input) || Buffer.byteLength(stableStringify(request.input), 'utf8') > INPUT_MAX_BYTES) throw new DomainRpcError('invalid_input', 'Workflow tool input must be a JSON object no larger than 1 MiB')
    const projectPath = await this.scope(request.context, request.policy, request.toolId)
    const configured = this.services.settings.get().integrations.tools
    if (!configured.enabled || !configured.enabledTools.includes(request.toolId)) throw new DomainRpcError('capability_denied', `Workflow built-in tool is disabled: ${request.toolId}`)
    if (request.signal.aborted) throw new DomainRpcError('cancelled', 'Workflow tool call cancelled')
    const result = GIT_TOOL_IDS.has(request.toolId)
      ? await this.build.execute(request.toolId, request.input, projectPath)
      : await this.coding.execute(request.toolId, request.input, projectPath, request.idempotencyKey, request.signal)
    if (result.isError) throw new DomainRpcError('tool_error', result.text.slice(0, 2000) || 'Built-in tool returned an error')
    if (Buffer.byteLength(result.text, 'utf8') > RESULT_MAX_BYTES) throw new DomainRpcError('budget_exceeded', 'Workflow tool result exceeds 4 MiB')
    await this.scope(request.context, request.policy, request.toolId)
    return { output: result.text, effect: this.effect(request.toolId) }
  }

  private async scope(context: ExecutionContext, policy: ExecutionPolicySnapshot, toolId: string): Promise<string> {
    this.assertActive()
    if (context.profileId !== this.services.profileId || policy.profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow tool belongs to another profile')
    const thread = this.services.threads.getThread(context.threadId)
    if (!thread || thread.settledAt || thread.projectId !== context.projectId || !context.projectId || !context.runId) throw new DomainRpcError('thread_unavailable', 'Workflow project-tool thread is unavailable')
    const project = this.services.projects.getProject(context.projectId)
    if (!project) throw new DomainRpcError('project_unavailable', 'Workflow project was removed')
    const manifest = await this.run(context)
    if (manifest.profileId !== context.profileId || manifest.threadId !== context.threadId || manifest.projectId !== context.projectId || manifest.runId !== context.runId || manifest.policySnapshotId !== context.policySnapshotId || manifest.cancellationId !== context.cancellationId || context.turnId !== manifest.runId || context.source !== manifest.source || stableStringify(context.actor) !== stableStringify(manifest.actor)) throw new DomainRpcError('profile_mismatch', 'Workflow tool execution context is not owned by this run')
    if (manifest.state !== 'running') throw new DomainRpcError('capability_denied', 'Workflow run is not executing')
    if (policy.version !== 1 || policy.id !== manifest.policySnapshotId || this.services.platform.workflowRuns.policy.snapshot(context.profileId, policy).id !== policy.id || !policy.allowedTools.includes(toolId) || !policy.allowedCapabilities.includes('tool.invoke') || !policy.allowedEffects.includes('external')) throw new DomainRpcError('capability_denied', 'Workflow tool was not admitted by the run policy')
    return project.path
  }

  private effect(toolId: string): EffectClass {
    if (WRITE_TOOL_IDS.has(toolId)) return 'write'
    if (toolId === 'bash') return 'external'
    return 'read'
  }

  private assertActive(): void {
    if (this.stopped) throw new DomainRpcError('profile_unavailable', 'Workflow tools are stopped')
  }
}
