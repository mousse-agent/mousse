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

/** Personal platform services live exactly as long as their owning profile runtime. */
export class MmsProfilePlatform {
  readonly agentDefinitions: AgentDefinitionRegistry
  readonly workflowDefinitions: WorkflowRegistry
  readonly integrations: IntegrationCatalog
  readonly workflowInvocation: WorkflowInvocationResolver
  readonly workflowRuns: MmsWorkflowCoordinator
  private readonly models: SharedAgentModelLookup
  private readonly disposers = new Set<() => void | Promise<void>>()
  private disposed = false

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
    this.workflowInvocation = new WorkflowInvocationResolver(this.workflowDefinitions,
      async () => new Set((await this.integrations.effectiveForActor({ kind: 'main' })).skills.map((skill) => skill.name)))
    this.workflowRuns = new MmsWorkflowCoordinator({ profileId, profileRoot, registry: this.workflowDefinitions,
      threads: services.threads, projects: services.projects,
      onError: (runId, error) => services.events.broadcast('workflow-runs:error', { profileId, runId, message: error instanceof Error ? error.message : String(error) }) })
    this.onDispose(() => this.workflowRuns.dispose())
  }

  /** Registration cleanup happens before MCP shutdown and before profile deletion. */
  onDispose(dispose: () => void | Promise<void>): void {
    this.assertActive()
    this.disposers.add(dispose)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const results = await Promise.allSettled([...this.disposers].map(async (dispose) => dispose()))
    this.disposers.clear()
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose profile platform services')
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
      integrationLookup
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
