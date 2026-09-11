import { AgentDefinitionRegistry, AgentResolver, StaticAgentIntegrationLookup } from '../agentDefinitions'
import type { AgentDefinitionDomainServices } from '../agentDefinitions/registerMethods'
import type { AgentDefinitionMethod } from '../../shared/agentPlatform'
import type { AgentRuntimeKind } from '../../shared/agents/types'
import { MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import type { IntegrationActor } from '../../shared/integrations/actor'
import { IntegrationCatalog } from '../integrations/catalog/IntegrationCatalog'
import { SkillLifecycleService } from '../integrations/skills/SkillLifecycleService'
import { McpLifecycleService } from '../integrations/mcp/McpLifecycleService'
import { WorkflowRegistry } from '../workflows/registry/WorkflowRegistry'
import { WorkflowInvocationResolver } from '../workflows/commands/WorkflowInvocationResolver'
import type { MmsProfileServices } from '../MmsProfileServices'
import { SharedAgentModelLookup } from './SharedAgentModelLookup'
import { MmsWorkflowCoordinator } from './MmsWorkflowCoordinator'
import { MmsWorkflowChatBridge } from './MmsWorkflowChatBridge'
import { MmsWorkflowIntegrations } from './MmsWorkflowIntegrations'
import { MmsAgentExecutionService } from './MmsAgentExecutionService'

/** Personal platform services live exactly as long as their owning profile runtime. */
export class MmsProfilePlatform {
  readonly agentDefinitions: AgentDefinitionRegistry
  readonly workflowDefinitions: WorkflowRegistry
  readonly integrations: IntegrationCatalog
  readonly workflowInvocation: WorkflowInvocationResolver
  readonly workflowRuns: MmsWorkflowCoordinator
  readonly workflowChat: MmsWorkflowChatBridge
  readonly workflowIntegrations: MmsWorkflowIntegrations
  readonly agentRuns: MmsAgentExecutionService
  private readonly models: SharedAgentModelLookup
  private readonly disposers = new Set<() => void | Promise<void>>()
  private disposed = false
  private disposeOperation?: Promise<void>

  constructor(private readonly services: MmsProfileServices) {
    const { profileId, integrationContext: { profileRoot } } = services
    this.agentDefinitions = new AgentDefinitionRegistry({ profileId, profileRoot })
    this.workflowDefinitions = new WorkflowRegistry({ profileId, profileRoot })
    this.integrations = new IntegrationCatalog(
      services.skillsRegistry, services.mcpRegistry, services.mcpManager, services.settings,
      new SkillLifecycleService(services.skillsRegistry, services.integrationContext),
      new McpLifecycleService(services.mcpRegistry, services.mcpManager, services.integrationContext)
    )
    this.models = new SharedAgentModelLookup(services.providerAuth)
    this.agentRuns = new MmsAgentExecutionService(services)
    this.onDispose(() => this.agentRuns.dispose())
    this.workflowInvocation = new WorkflowInvocationResolver(this.workflowDefinitions,
      async () => new Set((await this.integrations.effectiveForActor({ kind: 'main' })).skills.map((skill) => skill.name)))
    this.workflowIntegrations = new MmsWorkflowIntegrations(services, async (context) => (await this.workflowRuns.runtime.get(context.runId!, { profileId })).manifest)
    this.workflowRuns = new MmsWorkflowCoordinator({ profileId, profileRoot, registry: this.workflowDefinitions,
      threads: services.threads, projects: services.projects,
      adapters: { mcp: this.workflowIntegrations.mcp, skill: this.workflowIntegrations.skill },
      prepareExecution: (request, record) => this.workflowIntegrations.prepare(request, record),
      onError: (runId, error) => services.events.broadcast('workflow-runs:error', { profileId, runId, message: error instanceof Error ? error.message : String(error) }) })
    this.onDispose(() => this.workflowRuns.dispose())
    this.onDispose(() => this.workflowIntegrations.dispose())
    this.workflowChat = new MmsWorkflowChatBridge({ profileId, profileRoot, threads: services.threads, resolver: this.workflowInvocation, runs: this.workflowRuns,
      skillMode: async (name) => {
        const skills = (await this.integrations.effectiveForActor({ kind: 'main' })).skills.filter((skill) => skill.name === name)
        return skills.length === 1 ? { type: 'skill', skillId: skills[0].id } : undefined
      } })
  }

  /** Registration cleanup happens before MCP shutdown and before profile deletion. */
  onDispose(dispose: () => void | Promise<void>): void {
    this.assertActive()
    this.disposers.add(dispose)
  }

  /** Close platform-owned run admission synchronously before profile drain awaits. */
  beginShutdown(): void {
    this.disposed = true
    this.agentRuns.beginShutdown()
  }

  getActiveCount(): number {
    return this.agentRuns.getActiveCount()
  }

  dispose(): Promise<void> {
    this.beginShutdown()
    if (this.disposeOperation) return this.disposeOperation
    const operation = (async () => {
      const results = await Promise.allSettled([...this.disposers].map(async (dispose) => {
        await dispose()
        this.disposers.delete(dispose)
      }))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Failed to dispose profile platform services')
    })()
    this.disposeOperation = operation
    void operation.catch(() => { if (this.disposeOperation === operation) this.disposeOperation = undefined })
    return operation
  }

  async agentDomain(method: AgentDefinitionMethod, params: Readonly<Record<string, unknown>>): Promise<AgentDefinitionDomainServices> {
    this.assertActive()
    let integrationLookup = new StaticAgentIntegrationLookup()
    // Ordinary editor CRUD never starts a configured MCP executable. Explicit
    // validate/publish/run requests resolve a fresh, immutable grant snapshot.
    if (typeof params.id === 'string' && ['agentDefinitions.validate', 'agentDefinitions.publish', 'agentDefinitions.tryRun'].includes(method)) {
      const record = this.agentDefinitions.get(params.id)
      const runtimeKind = typeof params.revision === 'string'
        ? this.agentDefinitions.getRevision(record.id, params.revision).runtimeKind
        : record.runtimeKind
      integrationLookup = await this.integrationLookup(runtimeKind)
    }
    this.assertActive()
    return {
      registry: this.agentDefinitions,
      resolver: new AgentResolver({ registry: this.agentDefinitions, modelLookup: this.models, integrationLookup }),
      integrationLookup,
      tryRun: (input) => this.agentRuns.tryRun(input)
    }
  }

  async integrationLookup(runtimeKind: AgentRuntimeKind, projectPath?: string): Promise<StaticAgentIntegrationLookup> {
    this.assertActive()
    const actor: IntegrationActor = { kind: 'agent', agentType: runtimeKind }
    const [effective, tools] = await Promise.all([
      this.integrations.effectiveForActor(actor, projectPath),
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

  private assertActive(): void {
    if (this.disposed) throw Object.assign(new Error('Profile platform services are stopped'), { code: 'profile_unavailable' })
  }
}
