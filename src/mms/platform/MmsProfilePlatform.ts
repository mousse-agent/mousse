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
import { MmsWorkflowTools } from './MmsWorkflowTools'
import { MmsWorkflowAgents } from './MmsWorkflowAgents'
import { MmsWorkflowBrowser } from './MmsWorkflowBrowser'
import { mergeWorkflowAgentPreparation } from '../../shared/workflows/agentExecutionBindings'
import { MmsAgentExecutionService } from './MmsAgentExecutionService'
import { join } from 'node:path'
import { BrowserArtifactService } from '../browser/BrowserArtifactService'
import { MmsBrowserService } from '../browser/MmsBrowserService'
import type { AttachedCommandDispatchPort } from '../browser/AttachedBrowserConnectionBackend'

export interface MmsBrowserPlatformConfig {
  installationBrowserRoot: string
  workerModulePath?: string
  admitManagedLaunch?: () => Promise<{ release(): void }>
}

/** Personal platform services live exactly as long as their owning profile runtime. */
export class MmsProfilePlatform {
  readonly agentDefinitions: AgentDefinitionRegistry
  readonly workflowDefinitions: WorkflowRegistry
  readonly integrations: IntegrationCatalog
  readonly workflowInvocation: WorkflowInvocationResolver
  readonly workflowRuns: MmsWorkflowCoordinator
  readonly workflowChat: MmsWorkflowChatBridge
  readonly workflowIntegrations: MmsWorkflowIntegrations
  readonly workflowTools: MmsWorkflowTools
  readonly workflowAgents: MmsWorkflowAgents
  readonly workflowBrowser: MmsWorkflowBrowser
  readonly agentRuns: MmsAgentExecutionService
  readonly browserArtifacts: BrowserArtifactService
  readonly workerArtifactRoot: string
  private browserAssembly?: MmsBrowserService
  private commandRouter?: AttachedCommandDispatchPort
  private browserConfig?: MmsBrowserPlatformConfig
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
    this.workerArtifactRoot = join(profileRoot, 'browser', 'worker-artifacts')
    this.browserArtifacts = new BrowserArtifactService({ profileId, profileRoot, workerArtifactRoot: this.workerArtifactRoot })
    this.workflowInvocation = new WorkflowInvocationResolver(this.workflowDefinitions,
      async () => new Set((await this.integrations.effectiveForActor({ kind: 'main' })).skills.map((skill) => skill.name)))
    this.workflowIntegrations = new MmsWorkflowIntegrations(services, async (context) => (await this.workflowRuns.runtime.get(context.runId!, { profileId })).manifest)
    this.workflowTools = new MmsWorkflowTools(services, async (context) => (await this.workflowRuns.runtime.get(context.runId!, { profileId })).manifest)
    this.workflowAgents = new MmsWorkflowAgents(services, async (context) => (await this.workflowRuns.runtime.get(context.runId!, { profileId })).manifest)
    this.workflowBrowser = new MmsWorkflowBrowser(services, () => this.browser,
      async (context) => this.workflowRuns.runtime.get(context.runId!, { profileId }))
    this.workflowRuns = new MmsWorkflowCoordinator({ profileId, profileRoot, registry: this.workflowDefinitions,
      threads: services.threads, projects: services.projects,
      adapters: { agent: this.workflowAgents.agent, tool: this.workflowTools.adapter, mcp: this.workflowIntegrations.mcp, skill: this.workflowIntegrations.skill, browser: this.workflowBrowser.adapter },
      prepareExecution: async (request, record) => {
        const prepared = await this.workflowIntegrations.prepare(request, record)
        const tools = this.workflowTools.prepare(request, record, prepared.installationPolicy)
        const base = { ...prepared, installationPolicy: this.workflowBrowser.prepare(request, record, tools) }
        return mergeWorkflowAgentPreparation(base, await this.workflowAgents.prepare(request, record))
      },
      prepareChildAdmission: async (request, parent, child) => {
        const prepared = this.workflowIntegrations.prepareChildAdmission(request, parent, child)
        const agents = await this.workflowAgents.prepareInherited({ parent: parent.executionBindings?.agents ?? { requestId: parent.requestId ?? '' }, request, record: child })
        // Child preparation only adds the inherited pins. Its policy remains the
        // narrowed parent policy; helper grant unions are for top-level admission.
        return { ...prepared, executionBindings: { ...prepared.executionBindings, agents: agents.bindings } }
      },
      onError: (runId, error) => services.events.broadcast('workflow-runs:error', { profileId, runId, message: error instanceof Error ? error.message : String(error) }) })
    this.onDispose(() => this.workflowRuns.dispose())
    this.onDispose(() => this.workflowIntegrations.dispose())
    this.onDispose(() => this.workflowTools.dispose())
    this.onDispose(() => this.workflowAgents.dispose())
    this.onDispose(() => this.workflowBrowser.dispose())
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

  /** Root injects the installation-global reverse-command router after construction. */
  setBrowserCommandRouter(router: AttachedCommandDispatchPort | undefined): void {
    this.commandRouter = router
    this.browserAssembly?.setCommandRouter(router)
  }

  /** Root injects installation-shared browser binaries / worker module. No download happens here. */
  configureBrowser(config: MmsBrowserPlatformConfig): void {
    if (!this.browserAssembly) this.browserConfig = config
  }

  /**
   * Lazy per-profile browser composition. Construction does not start Chromium
   * or the managed worker. Reuses `browserArtifacts` rather than a second store.
   */
  get browser(): MmsBrowserService {
    this.assertActive()
    return this.ensureBrowser()
  }

  /** Close platform-owned run admission synchronously before profile drain awaits. */
  beginShutdown(): void {
    this.disposed = true
    this.agentRuns.beginShutdown()
    this.browserAssembly?.beginShutdown()
    this.browserArtifacts.beginShutdown()
  }

  getActiveCount(): number {
    return this.agentRuns.getActiveCount() + (this.browserAssembly?.getActiveCount() ?? 0) + this.browserArtifacts.getActiveCount()
  }

  getManagedBrowserActiveCount(): number {
    return this.browserAssembly?.getManagedActiveCount() ?? 0
  }

  dispose(): Promise<void> {
    this.beginShutdown()
    if (this.disposeOperation) return this.disposeOperation
    const operation = (async () => {
      const errors: unknown[] = []
      // Backends and session work settle before the artifact owner. Failed
      // attached closes stay unproven; empty transport counts are not guest proof.
      if (this.browserAssembly) {
        try { await this.browserAssembly.dispose() }
        catch (error) { errors.push(error) }
      }
      const results = await Promise.allSettled([...this.disposers].map(async (dispose) => {
        await dispose()
        this.disposers.delete(dispose)
      }))
      errors.push(...results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason))
      if (errors.length) throw new AggregateError(errors, 'Failed to dispose profile platform services')
      await this.browserArtifacts.dispose()
    })()
    this.disposeOperation = operation
    void operation.catch(() => { if (this.disposeOperation === operation) this.disposeOperation = undefined })
    return operation
  }

  private ensureBrowser(): MmsBrowserService {
    if (this.browserAssembly) return this.browserAssembly
    const { profileId, integrationContext: { profileRoot } } = this.services
    const installationBrowserRoot = this.browserConfig?.installationBrowserRoot ?? join(this.services.getHomeDir(), 'browser-binaries')
    this.browserAssembly = new MmsBrowserService({
      profileId,
      profileRoot,
      workerArtifactRoot: this.workerArtifactRoot,
      artifacts: this.browserArtifacts,
      installationBrowserRoot,
      workerModulePath: this.browserConfig?.workerModulePath,
      admitManagedLaunch: this.browserConfig?.admitManagedLaunch,
      threadExists: (threadId) => Boolean(this.services.threads.getThread(threadId)),
      commandRouter: this.commandRouter
    })
    return this.browserAssembly
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
