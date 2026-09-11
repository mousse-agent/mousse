import type { ExecutionContext, ExecutionPolicyLayer } from '../../shared/execution/types'
import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool, type BrowserWorkflowRequest } from '../../shared/browser/automation'
import type { BrowserActionResult } from '../../shared/browser/types'
import { isPlainObject, stableStringify, type BrowserExecutorAdapter, type CompiledGraph, type CompiledNode, type StartWorkflowRequest, type WorkflowRunSnapshot } from '../../shared/workflows'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { MmsBrowserService } from '../browser/MmsBrowserService'
import { browserToolCapability, browserToolEffect } from '../orchestrator/browser/tools'
import { ExecutionPolicyService } from '../execution/ExecutionPolicyService'
import { DomainRpcError } from '../protocol/domainRegistry'
import { collectTransitiveWorkflowRecords } from '../workflows/engine/childAdmission'
import type { WorkflowRecordSnapshot } from '../workflows/registry/WorkflowRegistry'

const BROWSER_TOOLS = new Set<string>(BROWSER_AUTOMATION_TOOLS)

/** Production workflow binding over the profile's existing browser service. */
export class MmsWorkflowBrowser {
  readonly adapter: BrowserExecutorAdapter = { kind: 'browser', invoke: (request) => this.invoke(request) }
  private readonly policies = new ExecutionPolicyService()
  private stopped = false

  constructor(
    private readonly services: MmsProfileServices,
    private readonly browser: () => MmsBrowserService,
    private readonly run: (context: ExecutionContext) => Promise<WorkflowRunSnapshot>
  ) {}

  dispose(): void { this.stopped = true }

  prepare(request: StartWorkflowRequest, record: WorkflowRecordSnapshot, installationPolicy: ExecutionPolicyLayer): ExecutionPolicyLayer {
    this.assertActive()
    if (request.profileId !== this.services.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow browser profile mismatch')
    const tools = new Set<BrowserAutomationTool>()
    const visit = (graph: CompiledGraph): void => {
      for (const node of graph.nodes) {
        const tool = toolForNode(node)
        if (tool) tools.add(tool)
        for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
      }
    }
    visit(record.compiled.graph)
    for (const child of collectTransitiveWorkflowRecords(record, this.services.platform.workflowDefinitions)) visit(child.compiled.graph)
    if (!tools.size) return installationPolicy
    const settings = this.services.settings.get().integrations.tools
    if (!settings.enabled) throw new DomainRpcError('capability_denied', 'Browser tools are disabled')
    for (const tool of tools) if (!settings.enabledTools.includes(tool)) throw new DomainRpcError('capability_denied', `Workflow browser tool is disabled: ${tool}`)
    return {
      ...installationPolicy,
      allowedTools: [...new Set([...(installationPolicy.allowedTools ?? []), 'workflow.browser', ...tools])],
      allowedCapabilities: [...new Set([...(installationPolicy.allowedCapabilities ?? []), ...[...tools].map(browserToolCapability)])]
    }
  }

  private async invoke(request: Parameters<BrowserExecutorAdapter['invoke']>[0]) {
    this.assertActive()
    if (request.signal.aborted) throw new DomainRpcError('cancelled', 'Workflow browser call cancelled')
    const requestedTool = toolForRequest(request.nodeType, request.config)
    const snapshot = await this.scope(request.context, request.policy, request.idempotencyKey, request.nodeType, request.config, requestedTool)
    this.assertEnabled(requestedTool)
    const effect = browserToolEffect(requestedTool)
    const capability = browserToolCapability(requestedTool)
    const narrow = this.policies.snapshot(this.services.profileId, {
      allowedTools: [requestedTool],
      allowedCapabilities: [capability],
      allowedEffects: [effect],
      approvalEffects: [],
      maxToolCalls: request.policy.maxToolCalls,
      maxElapsedMs: request.policy.maxElapsedMs,
      maxArtifactBytes: request.policy.maxArtifactBytes
    })
    const browserRequest: BrowserWorkflowRequest = {
      ...request,
      nodeType: request.nodeType as BrowserWorkflowRequest['nodeType'],
      context: { ...request.context, policySnapshotId: narrow.id },
      policy: narrow,
      vision: false
    }
    const result = await this.browser().workflow.invoke(browserRequest)
    if (request.signal.aborted) throw new DomainRpcError('cancelled', 'Workflow browser call cancelled after dispatch')
    await this.scope(request.context, request.policy, request.idempotencyKey, request.nodeType, request.config, requestedTool, snapshot.manifest.runId)
    this.assertEnabled(requestedTool)
    const action = isPlainObject(result.output) && isPlainObject(result.output.action)
      ? result.output.action as unknown as BrowserActionResult
      : undefined
    if (requestedTool === 'browser_act' && (!action || action.outcome !== 'verified')) {
      const outcome = action?.outcome ?? 'failed'
      throw new DomainRpcError(outcome === 'unknown-effect' || action?.dispatched ? 'unknown_effect' : 'browser_action_failed', action?.message ?? `Browser action did not verify (${outcome})`)
    }
    return result
  }

  private async scope(
    context: ExecutionContext,
    policy: Parameters<BrowserExecutorAdapter['invoke']>[0]['policy'],
    idempotencyKey: string,
    nodeType: string,
    config: Record<string, unknown>,
    tool: BrowserAutomationTool,
    expectedRunId?: string
  ): Promise<WorkflowRunSnapshot> {
    this.assertActive()
    if (context.profileId !== this.services.profileId || policy.profileId !== this.services.profileId || !context.runId || (expectedRunId && context.runId !== expectedRunId)) throw new DomainRpcError('profile_mismatch', 'Workflow browser belongs to another run or profile')
    const thread = this.services.threads.getThread(context.threadId)
    if (!thread || thread.settledAt || thread.projectId !== context.projectId) throw new DomainRpcError('thread_unavailable', 'Workflow browser thread is unavailable')
    if (context.projectId && !this.services.projects.getProject(context.projectId)) throw new DomainRpcError('project_unavailable', 'Workflow browser project was removed')
    const snapshot = await this.run(context)
    const manifest = snapshot.manifest
    if (manifest.profileId !== context.profileId || manifest.threadId !== context.threadId || manifest.projectId !== context.projectId || manifest.runId !== context.runId || manifest.policySnapshotId !== context.policySnapshotId || manifest.cancellationId !== context.cancellationId || context.turnId !== manifest.runId || context.source !== manifest.source || stableStringify(context.actor) !== stableStringify(manifest.actor)) throw new DomainRpcError('profile_mismatch', 'Workflow browser execution context is not owned by this run')
    if (manifest.state !== 'running') throw new DomainRpcError('capability_denied', 'Workflow browser run is not executing')
    if (policy.version !== 1 || policy.id !== manifest.policySnapshotId || this.policies.snapshot(context.profileId, policy).id !== policy.id || !policy.allowedTools.includes('workflow.browser') || !policy.allowedTools.includes(tool) || !policy.allowedCapabilities.includes(browserToolCapability(tool)) || !policy.allowedEffects.includes('external')) throw new DomainRpcError('capability_denied', 'Workflow browser node was not admitted by the run policy')
    const attempt = snapshot.attempts.find((item) => item.idempotencyKey === idempotencyKey)
    const nodes = attempt ? findNodes(snapshot.compiled.graph, attempt.nodeId) : []
    const node = nodes.length === 1 ? nodes[0] : undefined
    if (!attempt || attempt.completedAt || attempt.type !== nodeType || !node || node.type !== nodeType || stableStringify(node.config) !== stableStringify(config) || toolForNode(node) !== tool) throw new DomainRpcError('capability_denied', 'Workflow browser node does not match the active durable attempt')
    return snapshot
  }

  private assertEnabled(tool: BrowserAutomationTool): void {
    const settings = this.services.settings.get().integrations.tools
    if (!settings.enabled || !settings.enabledTools.includes(tool)) throw new DomainRpcError('capability_denied', `Workflow browser tool is disabled: ${tool}`)
  }

  private assertActive(): void {
    if (this.stopped) throw new DomainRpcError('profile_unavailable', 'Workflow browser adapter is stopped')
  }
}

function toolForRequest(nodeType: string, config: Record<string, unknown>): BrowserAutomationTool {
  if (nodeType === 'browser-session') return 'browser_open'
  if (nodeType === 'browser-observe') return 'browser_observe'
  if (nodeType === 'browser-action') return 'browser_act'
  if (nodeType === 'browser-extract') return 'browser_extract'
  if (nodeType !== 'browser-task') throw new DomainRpcError('executor_unavailable', `Unsupported workflow browser node: ${nodeType}`)
  const tool = typeof config.tool === 'string' ? config.tool : typeof config.toolName === 'string' ? config.toolName : ''
  if (!BROWSER_TOOLS.has(tool)) throw new DomainRpcError('invalid_input', 'browser-task requires one bounded browser tool name')
  return tool as BrowserAutomationTool
}

function toolForNode(node: CompiledNode): BrowserAutomationTool | undefined {
  if (!String(node.type).startsWith('browser-')) return undefined
  return toolForRequest(node.type, node.config)
}

function findNodes(graph: CompiledGraph, nodeId: string): CompiledNode[] {
  const found = graph.nodes.filter((node) => node.id === nodeId)
  for (const owner of graph.nodes) for (const child of Object.values(owner.subgraphs ?? {})) {
    found.push(...findNodes(child, nodeId))
  }
  return found
}
