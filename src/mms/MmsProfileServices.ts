import { ResourceLifecycleError } from './lifecycle/ResourceLifecycleStore'
import { AgentEpisodeStore } from './agents/AgentEpisodeStore'
import { join } from 'path'
import { homedir } from 'os'
import { MousseConfigStore } from './config/MousseConfigStore'
import { MmsEventBus } from './events'
import { SettingsStore } from './settings/SettingsStore'
import { rewriteMovedDefaults } from './settings/movedDefaults'
import { ProviderAuthService } from './providers/ProviderAuthService'
import { AppletStore } from './applets/AppletStore'
import { ClaudeSubscriptionProviderService } from './harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ClaudeIntegrationResolver } from './harness/vendors/claude/integrations'
import { AntigravityProviderService } from './harness/acp/presets/antigravity/AntigravityProviderService'
import { configInstanceStore, ProviderInstanceService } from './harness/instanceMap'
import { createProviderAccess, type ProviderAccess } from './providers/providerAccess'
import { createHarnessGateway, type Harness, type HarnessGateway } from './harness/gateway'
import { antigravityDriver } from './harness/drivers/antigravity'
import { acpDriver } from './harness/drivers/acp'
import { AgentInstalls } from './harness/agents/install'
import { AcpRegistry } from './harness/agents/registry'
import { claudeCodeDriver } from './harness/drivers/claudeCode'
import { codexDriver } from './harness/drivers/codex'
import { cursorDriver } from './harness/drivers/cursor'
import { grokDriver } from './harness/drivers/grok'
import { piDriver } from './harness/drivers/pi'
import { findPiRuntime, piRpcProfileOptions } from './harness/drivers/pi/profile'
import { decodeModelPrefs } from './harness/catalog'
import { piOAuthBroker } from './harness/pi/oauthBroker'
import { harnessAuthRunner, recordHarnessSpawn } from './harness/spawn'
import { spawnCodexAppServer } from './harness/vendors/codex/CodexAppServerClient'
import { createCodexProviderService, findCodexBinary, type CodexProviderService } from './harness/vendors/codex/CodexProviderService'
import { ANTIGRAVITY_INSTANCE_ID, CLAUDE_INSTANCE_ID, CODEX_INSTANCE_ID, piProviderIdOf } from '../shared/providerInstances'
import { ALL_MIRROR_FIELDS, LAUNCH_MIRROR_FIELDS } from './harness/vendorMirror'
import type { CliProviderConfigPatch } from '../shared/providerAuth'
import type { ScheduledJob } from '../shared/types'
import { ProjectManager } from './data/ProjectManager'
import { ThreadDataStore } from './data/ThreadDataStore'
import { backfillSubagentLineage } from './data/subagentLineage'
import { OrchestratorService } from './orchestrator/OrchestratorService'
import { ProfileDatabase } from './run/db/ProfileDatabase'
import { McpCredentials } from './run/mcp/McpCredentials'
import { MousseMcpServer } from './run/mcp/MousseMcpServer'
import { EffectWorker, type EffectWorkerFibres } from './run/EffectWorker'
import { TERMINAL_RUN_STATUSES, type RunRecord, type ThreadEvent } from './run/types'
import { Reconciler } from './run/Reconciler'
import { RunEngine } from './run/RunEngine'
import type { BotEngine } from './bots/activation/BotEngine'
import { openPersonalBots } from './bots/activation/open'
import { BotScheduler } from './bots/triggers/scheduler'
import type { BotStore } from './bots/store/BotStore'
import { RunStore } from './run/RunStore'
import { jobPermissionRequest } from './scheduled/jobPermission'
import { ScheduledJobService, ScheduledWebhookError } from './scheduled/ScheduledJobService'
import { ScheduledJobStore } from './scheduled/ScheduledJobStore'
import { ScheduledWebhookServer, scheduledWebhookPort } from './scheduled/ScheduledWebhookServer'
import { WebhookSecretCache } from './scheduled/webhookSecretCache'
import { scheduledJobOptionsDepsFrom, validateScheduledJobOptions } from './scheduled/validateJobOptions'
import { AgentRegistry } from './agents/AgentRegistry'
import { TaskQueue } from './tasks/TaskQueue'
import { WorktreeManager } from './worktree/WorktreeManager'
import { PtyManager } from './terminals/PtyManager'
import { McpRegistry } from './integrations/mcp/McpRegistry'
import { McpManager } from './integrations/mcp/McpManager'
import { SkillsRegistry } from './integrations/skills/SkillsRegistry'
import { FileService } from './files/FileService'
import { GitService } from './git/GitService'
import { LineEditStatsStore } from './stats/LineEditStatsStore'
import type { TerminalSendSink } from './terminals/PtyManager'
import { type MmsOwnerHandle, type MmsOwnerRecord } from './ownership/MmsOwnerLease'
import { ThreadRuntimeManager } from './runtime/ThreadRuntimeManager'
import { UserQuestionService } from './orchestrator/UserQuestionService'
import { ModeRegistry } from './modes/ModeRegistry'
import { createProfileSecretAdapter, deleteProfileSecret, writeProfileSecret } from './profiles/secrets'
import type { ProfileHost } from './profiles/ProfileHost'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from './integrations/profileContext'
import { NetService } from './net/NetService'
import { mousseIdNetModule } from './net/plus'
import { BridgeProfileService } from './bridge/BridgeProfileService'
import { ChatNetworkBindingService } from './chats/network/ChatNetworkBindingService'
import type { SpaceProfileService } from './spaces/SpaceProfileService'
import type { BotProfileService } from './bots/space/BotProfileService'
import { randomUUID } from 'crypto'
import { DomainHandlerRegistry, DomainRpcError } from './protocol/domainRegistry'
import type { ThreadRouterPort } from './protocol/threadRouterPort'
import type { RoutedTerminalsPort } from './protocol/routedTerminalsPort'
import type { EditorAsksPort } from './protocol/editorAsksPort'
import type { RemoteListsPort } from './protocol/remoteListsPort'
import type { MmsOptions } from './MmsOptions'
import { MmsProfilePlatform } from './platform/MmsProfilePlatform'
import { OwnedWorkBarrier } from './execution/OwnedWorkBarrier'
import { ResourceLifecycleCoordinator } from './lifecycle/ResourceLifecycleCoordinator'
import { buildResourceInventory } from './lifecycle/ResourceInventory'
import { clearCleanupMarker, StorageCleanupService } from './lifecycle/StorageCleanupService'
import { StorageUsageService } from './lifecycle/StorageUsageService'
import { StoragePolicyStore } from './lifecycle/StoragePolicyStore'
import { StorageSweepClock } from './lifecycle/sweepClock'
import { threadHasPendingWork } from './lifecycle/threadIdle'
import { listPendingQueue } from './queue/ThreadMessageQueue'
import { existsSync } from 'node:fs'
import { settleThreadMutationOwnership } from './queue/ThreadExecutionLease'
import type { TaskLifecycleRecord } from '../shared/resourceLifecycle'
import { UndoRetentionSweeper } from './actions/UndoRetentionSweeper'
import { PullRequestWatchService } from './git/PullRequestWatchService'
import { resolveThreadProjectPath } from './data/resolveActiveProjectPath'
import { SpeechRelay } from './speech/SpeechRelay'
import { systemClock } from './net/clock'
import { trustExistingProjectsOnce } from './git/repoPrograms'

const STORAGE_LIFECYCLE_METHODS = new Set([
  'threads.delete',
  'threads.trash',
  'threads.restore',
  'threads.purge'
])

/**
 * Requests that must not make a trash, restore or purge wait or look like other work: the lifecycle calls
 * themselves, a manual cleanup run (which purges through the same checks) and its dry run, and a
 * disk usage read, which can run for seconds and only reads. One set serves both the admission wait and
 * the idle check, so the two cannot disagree.
 */
const LIFECYCLE_EXEMPT_METHODS = new Set([
  ...STORAGE_LIFECYCLE_METHODS,
  'storage.cleanup.run',
  'storage.cleanup.plan',
  'storage.usage',
  // Deleting a bot trashes its home thread once its runs stopped; its own request is not other work.
  'bots.definitions.delete'
])

/** Long-poll requests that sit open while nothing happens; they are not owned profile work. */
const IDLE_WAIT_METHODS = new Set(['speech.host.wait'])

function containsProfileBusy(error: unknown): boolean {
  if (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'profile_busy' || error.code === 'shutdown_timeout')
  )
    return true
  return error instanceof AggregateError && error.errors.some(containsProfileBusy)
}

export class MmsProfileServices {
  readonly domains: DomainHandlerRegistry
  readonly config: MousseConfigStore
  readonly settings: SettingsStore
  readonly providerAuth: ProviderAuthService
  readonly antigravity: AntigravityProviderService
  readonly claudeSubscription: ClaudeSubscriptionProviderService
  /** Codex through `codex app-server`, reusing the terminal `codex login` (never logged out). */
  readonly codex: CodexProviderService
  /** Provider instances of this profile: the agents callers pick by `{ instanceId, model }`. */
  readonly providerInstances: ProviderInstanceService
  /**
   * The shared speech and usage calls as this profile may make them: a provider removed from the
   * profile is refused, whatever key another profile saved. Every caller goes through it.
   */
  readonly providerAccess: ProviderAccess
  /** The harness gateway: the only way app code reaches agents and providers. */
  harness?: HarnessGateway
  private harnessImpl?: Harness
  private catalogUnsubscribe?: () => void
  readonly projects: ProjectManager
  readonly applets: AppletStore
  readonly threads: ThreadDataStore
  readonly lifecycle: ResourceLifecycleCoordinator
  readonly undoRetention: UndoRetentionSweeper
  /** Watches the pull requests of threads that opted in and tells them about checks and reviews. */
  readonly pullRequestWatch: PullRequestWatchService
  readonly storagePolicy: StoragePolicyStore
  /** Storage cleanup rules: the one scheduler for worktree retirement and the trash sweep. */
  readonly storageCleanup: StorageCleanupService
  /** Disk usage for Settings > Storage, measured in the background and cached. */
  readonly storageUsage: StorageUsageService
  readonly orchestrator: OrchestratorService
  readonly scheduled: ScheduledJobService
  readonly agents: AgentRegistry
  readonly tasks: TaskQueue
  readonly events: MmsEventBus
  /**
   * The sequence of the newest event this daemon pushed to its windows. The protocol server sets it while it
   * serves this profile; a routed call reports it as the revision of what it read.
   */
  protocolSequence: () => number = () => 0
  /**
   * Sends the actions of a thread that another of the user's computers runs to that computer. Set by
   * the Bridge service while it is composed and cleared when it closes; the handlers consult it first.
   */
  threadRouter?: ThreadRouterPort
  /** The terminals other computers opened here, set while Bridge is on. */
  routedTerminals?: RoutedTerminalsPort
  /** The asks other computers made for editor connections, set while Bridge is on. */
  editorAsks?: EditorAsksPort
  /**
   * The threads, projects and statuses of the user's other computers, merged into this computer's lists
   * for windows. Set and cleared with `threadRouter`; empty while routing is off.
   */
  remoteLists?: RemoteListsPort
  readonly net: NetService
  readonly chatNetwork: ChatNetworkBindingService
  private bridgeService?: BridgeProfileService
  private speechRelayInstance?: SpeechRelay

  /** Phone speech requests waiting for, or served by, this profile's Mousse windows. */
  get speechRelay(): SpeechRelay {
    this.speechRelayInstance ??= new SpeechRelay(systemClock)
    return this.speechRelayInstance
  }

  private domainService(): BridgeProfileService {
    this.net.runtime()
    if (!this.bridgeService) throw new Error('Bridge profile composition is unavailable')
    return this.bridgeService
  }
  get bridge(): BridgeProfileService {
    this.net.assertFeature('netBridge')
    return this.domainService()
  }
  get spaces(): SpaceProfileService {
    this.net.assertFeature('netSpaces')
    return this.domainService().spaces
  }
  get bots(): BotProfileService {
    this.net.assertFeature('netSpaces')
    return this.domainService().bots
  }
  get archives(): BridgeProfileService['archives'] {
    this.net.assertFeature('netSpaces')
    return this.domainService().archives
  }

  readonly worktrees: WorktreeManager
  readonly ptyManager: PtyManager
  readonly mcpRegistry: McpRegistry
  readonly mcpManager: McpManager
  readonly skillsRegistry: SkillsRegistry
  readonly fileService: FileService
  readonly gitService: GitService
  readonly lineEditStats: LineEditStatsStore
  /** Phase 4 multi-tenant thread runtimes (agents/tasks/PTY ownership). */
  readonly threadRuntimes: ThreadRuntimeManager
  /** Profile Run Engine (`<profileHome>/run/run.db`); Phase 1 dual-writes beside the orchestrator. */
  readonly runEngine: RunEngine
  /** Personal bots (PR 6 §4). */
  /** Null when `bots.db` could not be opened: bots are unavailable, every other thread works. */
  readonly personalBots: BotEngine | null
  private readonly botScheduler: BotScheduler | null
  private readonly botStore: BotStore | null
  /** Phase 5 (SPEC §15.1): durable bearer credentials of the Mousse MCP server. */
  readonly mcpCredentials: McpCredentials
  /** Phase 5: Mousse's tools for vendor runtimes over MCP Streamable HTTP on 127.0.0.1. */
  readonly mcpServer: MousseMcpServer
  private runEffectWorker: EffectWorker | null = null
  private runReconciler: Reconciler | null = null
  private daemonHeartbeat: ReturnType<typeof setInterval> | null = null
  /** Detaches the inbox listener that runs reconciler rule 4 promptly. */
  private stopInboxWakes: (() => void) | null = null
  /** Daemon-owned pending questions, one instance per profile. */
  readonly questions: UserQuestionService
  readonly modeRegistry: ModeRegistry
  readonly profileId: string
  readonly integrationContext: IntegrationRuntimeContext
  readonly platform: MmsProfilePlatform

  private readonly scheduledStore: ScheduledJobStore
  private readonly scheduledWebhookServer: ScheduledWebhookServer
  private readonly webhookSecretCache: WebhookSecretCache
  private webhookRetryTimer: NodeJS.Timeout | null = null
  /** Set when the profile starts shutting down: the webhook listener is not started or retried again. */
  private webhooksClosed = false
  private started = false
  private stopped = false
  private readonly requests = new OwnedWorkBarrier()
  private stopOperation?: Promise<void>
  private readonly ownerHandle: MmsOwnerHandle | null
  private readonly homeDir: string
  private readonly installationHome: string
  private readonly effectFibres: Partial<EffectWorkerFibres> | undefined

  constructor(
    config: MousseConfigStore,
    opts: MmsOptions | undefined,
    ownerHandle: MmsOwnerHandle | null,
    homeDir: string,
    shared: {
      providerAuth: ProviderAuthService
      domains: DomainHandlerRegistry
      installationHome: string
      personal?: boolean
      profileId?: string
      allowLegacyProjectData?: boolean
      /** The profile's integration secrets may fall back to the daemon's environment (the Default profile only). */
      inheritProcessEnvironment?: boolean
      includeExternalCliConfigs?: boolean
      /** The installation's profiles: an agent install another profile uses counts only while it is listed. */
      listProfiles?: () => Array<{ id: string; displayName?: string }>
      /** Whether another profile still has an unmoved provider entry `instanceId` (the profile host's answer for a profile it builds). */
      otherProfilesUse?: (instanceId: string) => boolean
      /**
       * Effect worker fibres per lane class (SPEC §12.3). `turn` caps this profile's concurrent
       * turns (default 8); control fibres keep Stop and steer responsive while turns run.
       */
      effectFibres?: Partial<EffectWorkerFibres>
    }
  ) {
    this.config = config
    this.effectFibres = shared.effectFibres
    this.ownerHandle = ownerHandle
    this.homeDir = homeDir
    this.installationHome = shared.installationHome
    this.domains = shared.domains
    this.profileId = shared.profileId ?? 'default'
    this.questions = new UserQuestionService()
    this.modeRegistry = new ModeRegistry({
      profileRoot: homeDir,
      includeExternalCliConfigs: shared.includeExternalCliConfigs ?? !shared.personal
    })
    this.events = new MmsEventBus()
    this.settings = new SettingsStore(config)
    this.providerAuth = shared.providerAuth
    // The built-in instances' launch settings and sign-out live in their instance config (the
    // gateway's); the vendor services read them from there and save through `configure`.
    const launchOf = (instanceId: string) => () => this.harnessImpl?.launchFor(instanceId) ?? {}
    const signedOutOf = (instanceId: string) => () => this.harnessImpl?.signedOutInMousse(instanceId) ?? false
    const saveLaunchOf = (instanceId: string) => async (patch: CliProviderConfigPatch) => {
      if (!this.harnessImpl) throw new Error('Providers are not ready yet')
      await this.harnessImpl.instances.configure(instanceId, patch)
    }
    this.antigravity = new AntigravityProviderService(
      homeDir,
      shared.installationHome,
      this.questions,
      undefined,
      { launch: launchOf(ANTIGRAVITY_INSTANCE_ID), saveLaunch: saveLaunchOf(ANTIGRAVITY_INSTANCE_ID) }
    )
    this.antigravity.hooks.changed = () => this.harnessImpl?.vendorStateChanged(ANTIGRAVITY_INSTANCE_ID)
    this.antigravity.hooks.installProgress = (message) =>
      this.events.emit({ channel: 'providers:install', data: { instanceId: 'antigravity', type: 'progress', message } })
    // Every profile uses the terminal Claude sign-in, like Codex. Both find their CLI through the
    // gateway (the inherited PATH first, then the login shell's) and start through its spawn path.
    this.claudeSubscription = new ClaudeSubscriptionProviderService(homeDir, this.questions, {
      findBinary: () => this.harnessImpl?.findBinaryFor(CLAUDE_INSTANCE_ID),
      runAuth: harnessAuthRunner(CLAUDE_INSTANCE_ID),
      launchConfig: launchOf(CLAUDE_INSTANCE_ID),
      // The entry's telemetry switch (Settings → Providers), set last on every process.
      telemetryEnv: () => this.harnessImpl?.enforcedFor(CLAUDE_INSTANCE_ID).env,
      signedOut: signedOutOf(CLAUDE_INSTANCE_ID),
      saveLaunch: saveLaunchOf(CLAUDE_INSTANCE_ID)
    })
    this.codex = createCodexProviderService(homeDir, this.questions, {
      findBinary: () => this.harnessImpl?.findBinaryFor(CODEX_INSTANCE_ID) ?? findCodexBinary(),
      launch: (launch) => {
        recordHarnessSpawn({ instanceId: CODEX_INSTANCE_ID, purpose: 'app-server', command: launch.binary, args: launch.args, env: launch.env })
        return spawnCodexAppServer(launch)
      }
    }, {
      launch: launchOf(CODEX_INSTANCE_ID),
      telemetry: () => this.harnessImpl?.enforcedFor(CODEX_INSTANCE_ID),
      signedOut: signedOutOf(CODEX_INSTANCE_ID),
      saveLaunch: saveLaunchOf(CODEX_INSTANCE_ID)
    })
    // Seeded on load; a stored instance is never rewritten.
    this.providerInstances = new ProviderInstanceService({
      providerAuth: this.providerAuth,
      // A seeded built-in starts with what its vendor file holds (`harness/vendorMirror`).
      mirrorFor: (instanceId) =>
        instanceId === CLAUDE_INSTANCE_ID ? this.claudeSubscription.vendorMirror(ALL_MIRROR_FIELDS)
          : instanceId === CODEX_INSTANCE_ID ? this.codex.vendorMirror(ALL_MIRROR_FIELDS)
            : instanceId === ANTIGRAVITY_INSTANCE_ID ? this.antigravity.vendorMirror(LAUNCH_MIRROR_FIELDS)
              : undefined,
      store: configInstanceStore(config)
    })
    this.providerInstances.list()
    this.providerAccess = createProviderAccess(this.providerAuth, this.providerInstances)
    this.integrationContext = shared.personal
      ? {
          profileId: this.profileId,
          profileRoot: homeDir,
          secrets: createProfileSecretAdapter({
            profileRoot: homeDir,
            inheritProcessEnv: shared.inheritProcessEnvironment === true
          })
        }
      : createLegacySingleProfileContext({ profileId: this.profileId, profileRoot: homeDir })
    this.mcpRegistry = new McpRegistry(this.integrationContext)
    this.skillsRegistry = new SkillsRegistry(this.integrationContext)
    this.mcpManager = new McpManager(this.mcpRegistry, this.settings, opts?.openExternal, {
      context: this.integrationContext
    })
    this.fileService = new FileService()
    this.gitService = new GitService()
    this.lineEditStats = new LineEditStatsStore(homeDir)

    const repoRoot = opts?.repoRoot ?? process.env.MOUSSE_REPO_ROOT ?? process.cwd()
    this.worktrees = new WorktreeManager(repoRoot, shared.installationHome)
    this.agents = new AgentRegistry()
    this.tasks = new TaskQueue()
    this.ptyManager = new PtyManager()

    const terminalSink: TerminalSendSink =
      opts?.onTerminalEvent ??
      ((channel, data) => {
        this.events.broadcast(channel, data)
      })
    this.ptyManager.setSendSink(terminalSink)

    this.projects = new ProjectManager(homeDir)
    // Projects added before Mousse recorded their repositories' own Git filters: recorded once, now.
    trustExistingProjectsOnce(homeDir, this.projects.listProjects().map((project) => project.path))
    this.threads = new ThreadDataStore(this.projects, homeDir, {
      profileId: this.profileId,
      allowLegacyProjectData: shared.allowLegacyProjectData ?? !shared.personal
    })
    this.threads.setTransactionalStoreEnabled(this.config.get().features.transactionalThreadStore)
    this.applets = new AppletStore(homeDir, id => this.threads.getThreadDir(id))
    this.projects.setThreadStore(this.threads)
    this.platform = new MmsProfilePlatform(this)

    this.orchestrator = new OrchestratorService(
      this.agents,
      this.tasks,
      this.worktrees,
      this.ptyManager,
      this.settings,
      this.providerAuth,
      this.mcpManager,
      this.skillsRegistry,
      this.fileService,
      this.gitService,
      this.lineEditStats,
      this.projects,
      { questions: this.questions, modeRegistry: this.modeRegistry }
    )
    // MMS owns the canonical per-thread transcript and durable message queue for
    // every surface (GUI client, CLI client, remote sends). Electron never owns MMS.
    this.orchestrator.setThreadStore(this.threads)
    this.runEngine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: homeDir })) })
    this.orchestrator.setRunEngine(this.runEngine)
    this.mcpCredentials = new McpCredentials(this.runEngine.store)
    this.mcpServer = new MousseMcpServer({
      credentials: this.mcpCredentials,
      registry: this.orchestrator.mcpToolRegistry(),
      relay: this.orchestrator.relayHandler()
    })
    this.orchestrator.setAppletStore(this.applets)
    // Registry agents install once per installation; each profile records which versions it uses.
    const agentRegistry = new AcpRegistry({ cachePath: join(shared.installationHome, 'agents', 'registry.json') })
    const agentInstalls = new AgentInstalls({
      installationHome: shared.installationHome,
      profileId: this.profileId,
      registry: agentRegistry,
      liveInstances: () => Object.keys(this.providerInstances.list()),
      ...(shared.listProfiles ? { listProfiles: shared.listProfiles } : {})
    })
    // The harness gateway over this profile's instances: one runtime per instance, built by its
    // driver. Built-in instances share the profile's vendor services (usage, Settings) above.
    this.harnessImpl = createHarnessGateway({
      profileHome: homeDir,
      installationHome: shared.installationHome,
      instanceMap: this.providerInstances,
      drivers: [
        piDriver({
          credentials: () => this.providerAuth,
          // `pi:*` instances run on Pi's agent when this build ships its runtime (PR 2 §5).
          rpc: piRpcProfileOptions({
            auth: () => this.providerAuth,
            runtime: findPiRuntime(),
            customModels: (instanceId) => decodeModelPrefs(config.getProvidersSection().modelPrefs?.[instanceId]).custom,
            registry: () => this.orchestrator.mcpToolRegistry(),
            // Mousse stays the only refresher of an OAuth sign-in; Pi gets the access token only.
            oauth: piOAuthBroker(this.providerAuth)
          })
        }),
        claudeCodeDriver({
          builtIn: () => this.claudeSubscription,
          // Skill resolution follows the instance's environment (its own CLAUDE_CONFIG_DIR, if any).
          integrations: (env) => new ClaudeIntegrationResolver({
            mcpRegistry: this.mcpRegistry,
            mcpManager: this.mcpManager,
            skillsRegistry: this.skillsRegistry,
            settings: this.settings,
            secrets: this.integrationContext.secrets,
            pluginRoot: join(homeDir, 'providers', 'claude-subscription', 'skill-plugins'),
            env
          })
        }),
        codexDriver({ builtIn: () => this.codex }),
        antigravityDriver({ builtIn: () => this.antigravity }),
        acpDriver({ agents: agentInstalls }),
        cursorDriver(),
        grokDriver({ agents: agentInstalls })
      ],
      registry: { search: (query) => agentRegistry.search(query) },
      // A sign-in the profiles share (the pi-ai credentials) stays while another profile still uses it.
      // With no host to ask, it is treated as in use: the credential is kept.
      otherProfilesUse: (instanceId) =>
        shared.otherProfilesUse?.(instanceId) ?? this.getInstallationHost()?.otherProfilesUse(this.profileId, instanceId) ?? true,
      questions: this.questions,
      prefs: {
        read: () => config.getProvidersSection().modelPrefs,
        write: (modelPrefs) => config.updateProvidersSection({ modelPrefs })
      },
      cwd: () => this.worktrees.getRepoRoot(),
      piDisplayName: (providerId) => this.providerAuth.getProviderDisplayName(providerId),
      // A moved entry's device default follows it to the agent; its title model becomes Automatic.
      defaults: {
        rewrite: (from, to) => {
          const { patch, rewritten } = rewriteMovedDefaults(this.settings.get(), from, to)
          if (patch) this.settings.set(patch)
          return rewritten
        }
      }
    })
    this.harness = this.harnessImpl
    // A background catalogue refresh reaches the pickers as a snapshots event.
    this.catalogUnsubscribe = this.providerAuth.onCatalogChanged?.(() => this.harnessImpl?.catalogChanged())
    this.harnessImpl.startModelRefreshSchedule()
    this.orchestrator.setHarness(this.harnessImpl)
    // Personal bots (PR 6): their own database under `<profileHome>/bots/`, which older builds never open.
    // A `bots.db` that cannot be opened (corrupt, newer schema) fails closed for bots only: the
    // profile opens, its other threads work, and bot methods report bots unavailable.
    const harness = this.harnessImpl
    const opened = openPersonalBots({
      profileHome: homeDir,
      threads: {
        ensureExecutionThread: (key, name, projectId, ownership) => this.threads.ensureExecutionThread(key, name, projectId, ownership),
        threadState: (threadId) => {
          const record = this.threads.lifecycleStore.get(threadId)
          if (record && record.state !== 'active') return 'trashed'
          return this.threads.getThread(threadId) ? 'active' : record ? 'trashed' : 'missing'
        }
      },
      // A deleted bot's home thread: like the lifecycle RPCs, wait briefly for other requests to
      // finish, and retry a busy refusal a few times before reporting it.
      trashThread: async (threadId) => {
        const include = (active: string) => !LIFECYCLE_EXEMPT_METHODS.has(active.replace(/^rpc:/, ''))
        for (let attempt = 0; ; attempt += 1) {
          await this.requests.waitForIdle(2_000, include).catch(() => {})
          try {
            return await this.trashThread(threadId)
          } catch (error) {
            const busy = error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'busy'
            if (!busy || attempt >= 2) throw error
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      },
      runs: () => this.runEngine,
      harness,
      notifyEffects: () => this.orchestrator.notifyEffects(),
      stopThread: (threadId) => this.orchestrator.stopThread(threadId, 'user', { clientRequestId: `bot-stop:${threadId}:${Date.now()}` }),
      // A published schedule is read at once; before the scheduler started this does nothing.
      schedulesChanged: () => { void this.botScheduler?.wake() }
    })
    this.botStore = opened?.store ?? null
    this.personalBots = opened?.engine ?? null
    const personalBots = this.personalBots
    if (personalBots) this.orchestrator.setBotThreads(personalBots)
    // Every bot run that ends is settled, whatever path its turn took (no activation stays running).
    if (personalBots) this.runEngine.on('event', (event: ThreadEvent) => {
      if (event.type !== 'run.status') return
      const run = event.payload as RunRecord
      if (run.source !== 'bot' || !TERMINAL_RUN_STATUSES.has(run.status)) return
      setImmediate(() => {
        try { personalBots.settleRun(run.runId) } catch (error) { console.warn('bot dispatch could not be settled', { runId: run.runId, error: error instanceof Error ? error.message : String(error) }) }
      })
    })
    this.orchestrator.setBotDispatcher(personalBots)
    // Bot schedules tick only after the bot startup pass (`startOwned`).
    this.botScheduler = personalBots ? new BotScheduler({ tick: (now) => personalBots.tickSchedules(now) }) : null
    this.orchestrator.setWorkflowChatExecutor(this.platform.workflowChat)
    this.orchestrator.setFeatureFlags(this.config.get().features)
    this.threadRuntimes = new ThreadRuntimeManager()
    this.threadRuntimes.attach({
      threadStore: this.threads,
      orchestrator: this.orchestrator,
      ptyManager: this.ptyManager,
      questions: this.questions
    })
    // Minimum MMS-owned persistence so headless turns survive without the GUI.
    // Load-merges agents/tasks/mousse sessions; never writes messageQueue (queue API only).
    this.orchestrator.setPersistCallback((threadId) => {
      this.persistOrchestratorThread(threadId)
    })
    // PTY membership + capability events (no BrowserWindow).
    this.ptyManager.on('created', (p: { ptyId: string; threadId: string }) => {
      if (p.threadId && p.threadId !== '__unbound__') {
        this.threadRuntimes.registerPty(p.threadId, p.ptyId)
      }
    })
    this.ptyManager.on('exit', (p: { ptyId: string; threadId: string }) => {
      if (p.threadId && p.threadId !== '__unbound__') {
        this.threadRuntimes.unregisterPty(p.threadId, p.ptyId)
      }
    })

    this.scheduledStore = new ScheduledJobStore(config)
    this.scheduled = new ScheduledJobService(
      {
        runIsolated: (prompt, ingress) => this.orchestrator.runIsolatedScheduledJob(prompt, ingress)
      },
      this.scheduledStore,
      this.threads,
      this.projects
    )
    // The Run Engine decides when a scheduled occurrence is over, including after a restart.
    this.scheduledStore.setRunProbe(this.orchestrator.scheduledRunProbe())
    this.orchestrator.setScheduledHooks({
      onOccurrenceSettled: (event) => this.scheduled.occurrenceSettled(event),
      currentPermissionRequest: (jobId) => {
        const job = this.scheduled.getJob(jobId)
        return job ? jobPermissionRequest(job) : undefined
      }
    })
    this.scheduled.setQuestionProbe((threadId) => this.questions.listPendingForThread(threadId).length > 0)
    // Jobs saved before permission ceilings existed get one now: the mode of the thread they run on, else the
    // mode threads start in, else `ask`. Jobs that already have one are untouched, so this is safe on every start.
    try {
      this.scheduledStore.stampMissingPermissionCeilings((job) => this.orchestrator.scheduledCreatorCeiling(job.threadId))
    } catch (error) {
      console.warn('scheduled job permission ceilings could not be stamped; jobs without one follow their thread\'s mode', error instanceof Error ? error.message : String(error))
    }
    // Agents' schedule tools: the same checks and store the protocol uses, behind `scheduled.agentJobs` (off by default).
    const jobOptionDeps = scheduledJobOptionsDepsFrom({
      providerInstances: this.providerInstances,
      harness: () => {
        if (!this.harnessImpl) throw new Error('Providers are not ready yet')
        return this.harnessImpl
      },
      projects: this.projects,
      threads: this.threads
    })
    this.orchestrator.setScheduledJobs({
      enabled: () => config.agentJobsEnabled(),
      jobLimits: () => config.agentJobLimits(),
      list: () => this.scheduled.listJobs(),
      get: (id) => this.scheduled.getJob(id),
      validate: (job) => validateScheduledJobOptions(job, jobOptionDeps),
      create: (input) => this.scheduled.createJob(input),
      update: (id, patch) => this.scheduled.updateJob(id, patch),
      pause: (id, reason) => this.scheduled.pauseJob(id, reason),
      trigger: (id) => this.scheduled.triggerJob(id),
      wake: () => this.scheduled.wake()
    })
    // Job webhooks: secrets live in this profile's secret file, never in the process environment. The listener
    // looks them up in a small in-memory table that is rebuilt on any scheduler change, so a request costs no file work.
    const webhookSecrets = createProfileSecretAdapter({ profileRoot: homeDir, inheritProcessEnv: false })
    this.scheduled.setWebhookSecrets({
      write: (ref, value) => writeProfileSecret(homeDir, ref, value),
      delete: (ref) => deleteProfileSecret(homeDir, ref)
    })
    this.webhookSecretCache = new WebhookSecretCache(this.scheduledStore, webhookSecrets)
    this.scheduledWebhookServer = new ScheduledWebhookServer({
      resolveSecret: (jobId) => this.webhookSecretCache.resolve(jobId),
      schedulerRunning: () => this.scheduled.isRunning(),
      trigger: (jobId, request) => this.scheduledStore.triggerFromWebhook(jobId, request),
      recordRejection: (jobId, outcome, bodyBytes) => this.scheduledStore.recordWebhookRejection(jobId, outcome, bodyBytes),
      accepted: () => this.scheduled.wake()
    })

    this.net = new NetService({
      profileDir: this.homeDir,
      editorSsh: { home: homedir(), mousseHome: this.installationHome, profile: this.profileId },
      hosted: mousseIdNetModule,
      onChanged: (status) => this.events.emit({ channel: 'net:updated', data: status }),
      composeRuntime: (runtime) => {
        this.bridgeService = new BridgeProfileService({
          services: this,
          runtime,
          net: this.net,
          nativeAdapters: opts?.nativeBotAdapters?.({ services: this, runtime, net: this.net }),
          trustedQaAdapters: opts?.trustedQaBotAdapters?.({
            services: this,
            runtime,
            net: this.net
          })
        })
        const composition = this.bridgeService.composition()
        return {
          ...composition,
          beginDisable: () => {
            this.chatNetwork?.beginShutdown()
            composition.beginDisable?.()
          },
          close: () =>
            Promise.all([this.chatNetwork?.close(), composition.close?.()]).then(() => undefined),
          activeCount: () =>
            (composition.activeCount?.() ?? 0) + (this.chatNetwork?.activeCount() ?? 0)
        }
      }
    })
    this.chatNetwork = new ChatNetworkBindingService({
      profileId: this.profileId,
      profileHome: this.homeDir,
      chats: this.platform.chats,
      runtime: () => this.net.runtime(),
      assertNetwork: () => this.net.assertFeature('netSpaces'),
      spaces: () => this.spaces,
      hub: () => this.bridge.hub,
      preparePrivateAudience: (...args) =>
        this.bridge.currentIdentity.preparePrivateAudience(...args)
    })
    this.platform.onDispose(() => this.chatNetwork.close())
    this.lifecycle = new ResourceLifecycleCoordinator(this.threads.lifecycleStore, {
      assertCanTrash: (record) => this.assertLifecycleIdle(record.taskId),
      drain: async (record) => {
        const owned = this.lifecycleOwnedTasks(record.taskId)
        const botThreads = new Set(this.personalBots?.botThreadsAmong(owned.map((task) => task.taskId)) ?? [])
        // Every check that does not depend on the bot's own turns comes first, so a trash refused by
        // other work leaves the bot untouched.
        for (const task of owned) this.threadRuntimes.assertDeletable(task.taskId, { ignoreTurn: botThreads.has(task.taskId) })
        const runs = await this.platform.workflowRuns.runtime.list({ profileId: this.profileId })
        if (
          runs.some(
            (run) =>
              owned.some((task) => task.taskId === run.threadId) &&
              !['succeeded', 'failed', 'cancelled'].includes(run.state)
          )
        ) {
          throw new ResourceLifecycleError(
            'busy',
            'Cannot trash thread: an owned workflow is still active or waiting'
          )
        }
        const inventory = buildResourceInventory(this.threads.lifecycleStore, record)
        if (inventory.blockers.length)
          throw new ResourceLifecycleError('ambiguous', `Resource ownership is not established: ${inventory.blockers.join('; ')}`)
        // The trash was accepted for exactly these threads (fresh operation, current generation) and
        // passed every other check: only now do the bot activations on them end and their runs stop
        // (PR 6 §4). A stale, refused or replayed trash never gets here. A stop that does not finish
        // within its deadline is reported busy and nothing moves; the activations it ended stay ended,
        // since their stop is already under way. Context threads are retired only after the move.
        if (this.personalBots && !(await this.personalBots.quiesceForTrash(owned.map((task) => task.taskId))))
          throw new ResourceLifecycleError('busy', 'Cannot trash thread: the bot working in it is still stopping')
        // The final proof, now that the bot's turns have ended: no turn, and every lease free. A
        // stopped bot turn lets go of its lease as it unwinds, so that is waited for briefly.
        const prove = (): void => {
          for (const task of owned) this.threadRuntimes.assertDeletable(task.taskId)
          for (const task of owned) settleThreadMutationOwnership(task.location)
        }
        const until = Date.now() + 5_000
        for (;;) {
          try {
            prove()
            break
          } catch (error) {
            const busy = error instanceof Error && (('code' in error && (error as { code?: unknown }).code === 'busy') || error.name === 'LeaseBusyError')
            if (!botThreads.size || !busy || Date.now() >= until) throw error
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }
      },
      settleMutationOwnership: async (record) => {
        const owned = this.lifecycleOwnedTasks(record.taskId)
        for (const task of owned) settleThreadMutationOwnership(task.location)
      },
      projectIndex: (record) => {
        this.threads.projectLifecycleIndex(record)
        for (const task of this.lifecycleOwnedTasks(record.taskId)) {
          this.threads.cancelLifecycleQueue(task, record.operations.at(-1)!.id)
          this.threadRuntimes.disposeRuntime(task.taskId)
          if (record.location === record.originalLocation)
            this.orchestrator.markThreadRestored(task.taskId)
          else this.orchestrator.markThreadDeleted(task.taskId)
        }
        // A second, idempotent pass once the threads moved; restoring never revives an activation.
        if (record.location !== record.originalLocation) {
          try { this.personalBots?.afterTrash(this.lifecycleOwnedTasks(record.taskId).map((task) => task.taskId)) } catch (error) { console.warn('bot activations could not be ended after the trash', { error: error instanceof Error ? error.message : String(error) }) }
        }
      },
      quiesceDisk: () => this.storageUsage.pause(),
      projectPurged: (record) => {
        // A permanent delete freed space.
        this.storageUsage.rescanSoon()
        clearCleanupMarker(this.threads.lifecycleStore, record.taskId)
        this.threads.projectPurgedIndex(record)
        this.threadRuntimes.disposeRuntime(record.taskId)
        this.orchestrator.markThreadDeleted(record.taskId)
      },
      configurationChanged: () => {
        this.config.reloadFromDisk()
      }
    })
    this.undoRetention = new UndoRetentionSweeper(this.threads.lifecycleStore)
    this.pullRequestWatch = new PullRequestWatchService({
      threads: this.threads,
      codeHost: this.gitService.codeHost,
      // The project's checkout names the repository every worktree of it shares, and exists whatever happens to a worktree.
      folderFor: (threadId) => resolveThreadProjectPath(this.projects, this.threads, threadId) ?? null,
      isAvailable: (threadId) => {
        const record = this.threads.lifecycleStore.get(threadId)
        return !record || record.state === 'active'
      },
      isSubagent: (threadId) => Boolean(this.threads.getThread(threadId)?.lineage || this.runEngine.delegations.getLineage(threadId)),
      runStore: () => this.runEngine.store,
      inbox: () => this.runEngine.inbox,
      // A person's message is a visible user message that is not a job's prompt; wakes and notices are hidden or not user messages.
      lastPersonMessageAt: (threadId) => {
        const mine = this.orchestrator.getMessages(threadId).filter((message) => message.role === 'user' && !message.scheduled && !message.subagentNotice?.length)
        const at = Date.parse(mine.at(-1)?.timestamp ?? '')
        return Number.isNaN(at) ? null : at
      },
      notify: (threadId, text, messageId) => this.orchestrator.noteThreadUpdate(threadId, text, { messageId }),
      onRunEnd: (listener) => {
        const handler = (event: ThreadEvent): void => {
          if (event.type !== 'run.status') return
          if (TERMINAL_RUN_STATUSES.has((event.payload as RunRecord).status)) listener(event.threadId)
        }
        this.orchestrator.on('run-event', handler)
        return () => { this.orchestrator.off('run-event', handler) }
      }
    })
    // Any Stop that reaches a thread, and every subagent below it, ends its watch at once.
    this.orchestrator.on('threads-stopped', (payload: { threadIds: string[] }) => this.pullRequestWatch.onStopped(payload.threadIds))
    const storageClock = new StorageSweepClock(this.threads.lifecycleStore.root)
    this.storagePolicy = new StoragePolicyStore(this.threads.lifecycleStore, storageClock, () =>
      this.storageCleanup.scheduleAfterPolicyChange()
    )
    this.storageCleanup = new StorageCleanupService({
      store: this.threads.lifecycleStore,
      threads: this.threads,
      purge: this.lifecycle.cleanup,
      policy: this.storagePolicy,
      clock: storageClock,
      idle: (threadId) => this.threadPendingWork(threadId),
      installationHome: shared.installationHome,
      codeHost: this.gitService.codeHost,
      browserCaptures: { workerArtifactRoot: this.platform.workerArtifactRoot, sessions: (staleBefore) => this.platform.browserSessionStates(staleBefore) },
      // A run that freed space has made the cached numbers wrong.
      onRunComplete: (report) => { if (report.counts.removed > 0) this.storageUsage.rescanSoon() },
      quiesceDisk: () => this.storageUsage.pause()
    })
    this.storageUsage = new StorageUsageService({
      store: this.threads.lifecycleStore,
      threads: this.threads,
      projects: this.projects,
      installationHome: shared.installationHome,
      busy: () => this.storageCleanup.isRunning()
    })
    this.wireServiceEvents()
    void opts?.headless
  }

  private assertLifecycleIdle(taskId: string): void {
    const owned = this.lifecycleOwnedTasks(taskId)
    // A bot's turns on these threads are not other work: the accepted trash stops them in its drain.
    const botThreads = new Set(this.personalBots?.botThreadsAmong(owned.map((task) => task.taskId)) ?? [])
    for (const task of owned) this.threadRuntimes.assertDeletable(task.taskId, { ignoreTurn: botThreads.has(task.taskId) })
    this.platform.chats.assertLifecycleIdle(new Set(owned.map((task) => task.taskId)))
    this.platform.workflowRuns.assertLifecycleIdle(new Set(owned.map((task) => task.taskId)))
    const turns = Object.fromEntries(Object.entries(this.orchestrator.getOwnedActivity()).filter(([label]) => !(label.startsWith('bot-turn:') && botThreads.has(label.slice('bot-turn:'.length)))))
    const activity = {
      ...turns,
      platform: this.platform.getActiveCount(),
      scheduled: this.scheduled.getActiveCount(),
      // Headless CLI agents are retired; the key stays for protocol stability.
      headless: 0,
      mcp: this.mcpManager.getActiveCount()
    }
    const activeExecution = Object.entries(activity).filter(([, count]) => count > 0)
    if (activeExecution.length)
      throw new ResourceLifecycleError(
        'busy',
        'Cannot trash thread: profile execution is still active'
      )
    const requests = this.requests.snapshot()
    const activeRequests = Object.entries(requests).filter(
      ([key, count]) =>
        count > 0 && !LIFECYCLE_EXEMPT_METHODS.has(key.replace(/^rpc:/, ''))
    )
    if (activeRequests.length) {
      throw new ResourceLifecycleError(
        'busy',
        'Cannot trash thread: profile requests are still active'
      )
    }
    const root = this.threads.lifecycleStore.require(taskId)
    const settle = () => {
      for (const task of owned) {
        // A bot turn on a thread this trash would stop holds that thread's execution lease. The drain
        // stops it and then proves ownership, so admission does not refuse the trash for it.
        if (root.state === 'active' && botThreads.has(task.taskId)) continue
        if (existsSync(task.location)) settleThreadMutationOwnership(task.location)
      }
    }
    if (['trashed', 'purge-started'].includes(root.state))
      this.threads.lifecycleStore.withCleanupSettlement(taskId, settle)
    else settle()
  }

  /** Why a thread is not idle for storage cleanup, or undefined. Looks only at what is already loaded. */
  private threadPendingWork(threadId: string): string | undefined {
    return threadHasPendingWork(
      {
        orchestrator: this.orchestrator,
        runEngine: this.runEngine,
        pendingQueueLength: (id) => listPendingQueue(this.threads.loadMessageQueue(id)).length,
        questions: this.questions,
        ptyManager: this.ptyManager,
        threadRuntimes: this.threadRuntimes,
        executionBusy: (ids) => {
          try { this.platform.chats.assertLifecycleIdle(new Set(ids)) } catch { return 'A chat is running' }
          try { this.platform.workflowRuns.assertLifecycleIdle(ids) } catch { return 'A workflow is running or waiting' }
          return undefined
        },
        listThreads: () => this.threads.listAllThreads()
      },
      threadId
    )
  }

  /** The "Remove worktrees of deleted threads" rule; an unreadable policy keeps today's behaviour. */
  private removesWorktreesWithDeletedThreads(): boolean {
    try { return this.storagePolicy.policy().worktrees.removeWithDeletedThreads } catch { return true }
  }

  private lifecycleOwnedTasks(taskId: string): TaskLifecycleRecord[] {
    const records = this.threads.lifecycleStore.list()
    const ids = new Set([taskId])
    let changed = true
    while (changed) {
      changed = false
      for (const record of records)
        if (record.parentTaskId && ids.has(record.parentTaskId) && !ids.has(record.taskId)) {
          ids.add(record.taskId)
          changed = true
        }
    }
    const byId = new Map(records.map((record) => [record.taskId, record]))
    return records.filter((record) => {
      if (!ids.has(record.taskId)) return false
      let child = record
      while (child.taskId !== taskId) {
        // Independently trashed children retain their own fence and restore choice.
        if (child.state === 'trashed') return false
        if (child.state !== 'active')
          throw new Error(
            'Owned child lifecycle operation requires recovery before moving its parent'
          )
        const parent = child.parentTaskId ? byId.get(child.parentTaskId) : undefined
        if (!parent) throw new Error('Owned child lifecycle parent is missing')
        child = parent
      }
      return true
    })
  }

  resolveLifecycleOperationId(
    taskId: string,
    kind: 'trash' | 'restore',
    operationId?: string
  ): string {
    if (operationId !== undefined) return operationId
    const pending = this.threads.lifecycleStore.get(taskId)?.operations.at(-1)
    return pending?.kind === kind && !['completed', 'rejected'].includes(pending.phase)
      ? pending.id
      : randomUUID()
  }

  async trashThread(
    taskId: string,
    operationId?: string,
    expectedGeneration?: number
  ): Promise<TaskLifecycleRecord> {
    this.threads.assertLifecycleMutationAvailable()
    if (!this.threads.lifecycleStore.get(taskId)) this.threads.getThreadDir(taskId)
    // A trashed thread is not listed and cannot be written to, so its watch ends now, while its folder still resolves, and a
    // restore does not bring it back with a backlog.
    this.pullRequestWatch.onEnded(taskId, 'trashed')
    const record = await this.lifecycle.trash({
      taskId,
      operationId: this.resolveLifecycleOperationId(taskId, 'trash', operationId),
      expectedGeneration
    })
    if (record.state === 'trashed' && this.removesWorktreesWithDeletedThreads()) {
      try {
        // The same keep rules as the hourly run (unpublished commits, links, files in use); a checkout that is kept stays until purge.
        const item = await this.storageCleanup.retireDeletedWorktree(taskId)
        if (item?.outcome === 'removed') this.storageUsage.rescanSoon()
      } catch (error) {
        this.threads.lifecycleStore.update(taskId, (current) => {
          current.blockedReason = `Checkout retirement retained resources: ${(error as Error).message}`
        })
      }
    }
    return this.threads.lifecycleStore.require(taskId)
  }

  async restoreThread(
    taskId: string,
    operationId?: string,
    expectedGeneration?: number
  ): Promise<TaskLifecycleRecord> {
    this.threads.assertLifecycleMutationAvailable()
    return this.lifecycle.restore({
      taskId,
      operationId: this.resolveLifecycleOperationId(taskId, 'restore', operationId),
      expectedGeneration
    })
  }

  getOwnerLease(): MmsOwnerHandle | null {
    return this.ownerHandle
  }

  getOwnerRecord(): MmsOwnerRecord | null {
    return this.ownerHandle?.owner ?? null
  }

  getHomeDir(): string {
    return this.installationHome
  }

  getProfileHomeDir(): string {
    return this.homeDir
  }

  getProfileId(): string {
    return this.profileId
  }

  async runOwnedRequest<T>(method: string, work: () => T | Promise<T>): Promise<T> {
    const label = `rpc:${method}`
    // An idle window's wait holds no profile state and ends when the relay closes, so it must not
    // make storage changes or shutdown wait for it. It is still refused once the profile drains.
    try {
      if (IDLE_WAIT_METHODS.has(method)) {
        this.requests.assertAccepting()
        return await work()
      }
      return await this.requests.run(label, async () => {
        if (!STORAGE_LIFECYCLE_METHODS.has(method)) return work()
        // Let short GUI polls and writes settle without exempting their ownership.
        // Completion RPCs must remain available to the work being drained. The
        // unchanged synchronous idle check and durable task fence below authorize
        // the move; this wait alone never does. Exclude lifecycle calls consistently
        // with that idle check, avoiding a pair of lifecycle calls waiting on itself.
        const include = (active: string) =>
          !LIFECYCLE_EXEMPT_METHODS.has(active.replace(/^rpc:/, ''))
        try {
          await this.requests.waitForIdle(2_000, include)
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'profile_busy')
            throw error
          const remaining = Object.entries(this.requests.snapshot()).filter(([key]) => include(key))
          throw new DomainRpcError(
            'profile_busy',
            `Cannot change task storage: profile requests are still active (${remaining.map(([key, count]) => `${key}=${count}`).join(', ')})`
          )
        }
        this.requests.assertAccepting()
        return await work()
      })
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'profile_draining' || error.code === 'profile_busy')
      ) {
        throw new DomainRpcError(
          error.code,
          error.message,
          'details' in error ? error.details : undefined
        )
      }
      throw error
    }
  }

  getOwnedActivity(): Record<string, number> {
    return {
      ...this.requests.snapshot(),
      ...this.orchestrator.getOwnedActivity(),
      scheduledTicks: this.scheduled.getActiveCount(),
      ptyProcesses: this.ptyManager.getActiveCount(),
      // Headless CLI agents are retired; the key stays for protocol stability.
      headlessProcesses: 0,
      agentRuns: this.platform.getActiveCount() + (this.chatNetwork?.activeCount() ?? 0),
      mcpWork: this.mcpManager.getActiveCount(),
      netWork: this.net.getActiveCount()
    }
  }

  /** Close admission synchronously, before any teardown await can admit another request. */
  beginShutdown(): void {
    void this.undoRetention.stop()
    void this.pullRequestWatch.stop()
    void this.storageCleanup.stop()
    void this.storageUsage.stop()
    void this.lifecycle.cleanup.stop()
    this.requests.beginShutdown()
    // Ends open and late window speech waits now, even when Net never started and so never closes
    // the relay.
    this.speechRelay.shutdown()
    this.mcpManager.beginShutdown()
    this.chatNetwork?.beginShutdown()
    this.net.beginShutdown()
    this.platform.beginShutdown()
    this.orchestrator.beginShutdown()
    this.scheduled.beginShutdown()
    this.botScheduler?.stop()
    this.webhooksClosed = true
    if (this.webhookRetryTimer) clearTimeout(this.webhookRetryTimer)
    this.webhookRetryTimer = null
    void this.scheduledWebhookServer.stop().catch(() => undefined)
    this.ptyManager.beginShutdown()
  }

  /** Installation host; only MousseMainService returns a live host. */
  getInstallationHost(): ProfileHost | null {
    return null
  }

  async initialize(): Promise<void> {
    await this.lifecycle.recoverAll()
    for (const thread of this.threads.listAllThreads()) {
      const episodes = new AgentEpisodeStore(this.threads.getThreadDir(thread.id))
      if (existsSync(episodes.path)) episodes.interruptOrphans()
    }
    this.repairSubagentLineage()
    // A packaged GUI can start before the user opens a Git project. Keep the
    // worktree manager lazy in that state; project-bound operations still call
    // RepositoryContext.open() and fail clearly if their project is invalid.
    if (await this.gitService.isRepo(this.worktrees.getRepoRoot())) {
      await this.worktrees.init()
    }
    this.config.startWatching(() => {
      /* external edits reload sections; stores read on demand */
    })
  }

  /**
   * Boot repair for subagent threads (thread metadata against the run store's lineage rows): a child
   * whose creation died before its rows committed is discarded while empty, and older children get
   * the lineage their metadata lacks. A failure here never blocks start.
   */
  private repairSubagentLineage(): void {
    try {
      const rows = this.runEngine.delegations.listLineage('subagent')
      const known = new Set(rows.map((row) => row.threadId))
      this.threads.discardOrphanedSubagents((threadId) => known.has(threadId))
      backfillSubagentLineage(this.threads, rows)
    } catch (error) {
      console.warn('subagent lineage repair failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private wireServiceEvents(): void {
    this.scheduled.on('updated', (jobs) => {
      this.events.emit({ channel: 'scheduled:updated', data: jobs })
      // A change to the jobs (a rotated or removed secret, a deleted job) applies to the listener at once.
      this.webhookSecretCache.invalidate()
      this.reconcileScheduledWebhookListener(jobs as ScheduledJob[])
    })
    this.scheduled.on('status', (status) => {
      this.events.emit({ channel: 'scheduled:status', data: status })
    })
  }

  /** True when at least one job has a webhook (the listener has a reason to run). */
  private hasScheduledWebhooks(jobs: ScheduledJob[] = this.scheduled.listJobs()): boolean {
    return jobs.some((job) => job.trigger?.webhook !== undefined)
  }

  /** Brings the job webhook listener up when the profile has it enabled; a taken port is reported and retried, not fatal. */
  private async listenScheduledWebhooksIfEnabled(): Promise<void> {
    const section = this.config.getScheduledSection().webhooks
    if (!section?.enabled || this.webhooksClosed) return
    if (!this.hasScheduledWebhooks()) {
      this.config.updateScheduledSection({ webhooks: { enabled: false, port: scheduledWebhookPort(section.port) } })
      return
    }
    await this.listenScheduledWebhooks(scheduledWebhookPort(section.port))
  }

  /** Binds the listener; returns the reason when it could not. A failed bind is tried again every half minute. */
  private async listenScheduledWebhooks(port: number): Promise<string | undefined> {
    if (this.webhooksClosed) return 'The profile is shutting down.'
    // A forward set up for a net transport (Tailscale Serve) would reach whatever listens on its port.
    if (this.net.localPorts().includes(port)) {
      const message = `Webhook listener not started: port ${port} is used by this profile's net service. Choose another port.`
      this.scheduled.setWebhookListenerError(message)
      return message
    }
    try {
      await this.scheduledWebhookServer.start(port)
      this.scheduled.setWebhookListenerError(null)
      return undefined
    } catch (error) {
      const message = `Webhook listener could not start on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`
      this.scheduled.setWebhookListenerError(message)
      this.scheduleWebhookRetry()
      return message
    }
  }

  private scheduleWebhookRetry(): void {
    if (this.webhookRetryTimer || this.webhooksClosed) return
    this.webhookRetryTimer = setTimeout(() => {
      this.webhookRetryTimer = null
      void this.listenScheduledWebhooksIfEnabled().catch(() => undefined)
    }, 30_000)
    this.webhookRetryTimer.unref?.()
  }

  /** The listener runs only while some job has a webhook: removing the last one stops it and turns it off. */
  private reconcileScheduledWebhookListener(jobs: ScheduledJob[]): void {
    const section = this.config.getScheduledSection().webhooks
    if (!section?.enabled || this.hasScheduledWebhooks(jobs)) return
    if (this.webhookRetryTimer) clearTimeout(this.webhookRetryTimer)
    this.webhookRetryTimer = null
    this.scheduled.setWebhookListenerError(null)
    this.config.updateScheduledSection({ webhooks: { enabled: false, port: scheduledWebhookPort(section.port) } })
    void this.scheduledWebhookServer.stop().catch(() => undefined)
  }

  /** The URL a sender posts to for a job (the configured port; the listener may not be up). */
  scheduledWebhookUrl(jobId: string): string {
    const port = scheduledWebhookPort(this.config.getScheduledSection().webhooks?.port)
    return `http://127.0.0.1:${port}/hooks/${jobId}`
  }

  /**
   * Gives a job a webhook, turns the listener on (and moves it when a different port is asked for) and returns the
   * secret, shown only here. For a job that already has a webhook, a port moves the listener and no secret is
   * issued. A listener that cannot bind is reported with the result; the job keeps its webhook.
   */
  async enableScheduledWebhook(
    jobId: string,
    options: { port?: number } = {}
  ): Promise<{ job: ScheduledJob; secret?: string; url: string; listening: boolean; error?: string; warning?: string }> {
    const existing = this.scheduled.getJob(jobId)
    let job: ScheduledJob
    let secret: string | undefined
    if (existing?.trigger?.webhook) {
      if (options.port === undefined) {
        throw new ScheduledWebhookError('This job already has a webhook. Rotate its secret to get a new one, or give a port to move the listener.')
      }
      job = existing
    } else {
      ;({ job, secret } = this.scheduled.enableWebhook(jobId))
    }
    const current = this.config.getScheduledSection().webhooks
    const port = scheduledWebhookPort(options.port ?? current?.port)
    if (!current?.enabled || current.port !== port) this.config.updateScheduledSection({ webhooks: { enabled: true, port } })
    this.webhooksClosed = false
    let error = await this.listenScheduledWebhooks(port)
    if (error && current?.enabled && current.port !== port) {
      // The new port is not available: go back to the one that was working.
      this.config.updateScheduledSection({ webhooks: { enabled: true, port: current.port } })
      await this.listenScheduledWebhooks(current.port)
      error = `${error} The listener stays on port ${current.port}.`
    }
    const warning = this.scheduled.isRunning()
      ? undefined
      : 'The scheduler is off, so requests are refused (503) until it is turned on (scheduled.enabled).'
    return { job, ...(secret ? { secret } : {}), url: this.scheduledWebhookUrl(jobId), listening: error === undefined, ...(error ? { error } : {}), ...(warning ? { warning } : {}) }
  }

  async start(): Promise<void> {
    await this.requests.run('profile-start', () => this.startOwned())
    // Bot deletions a crash or a refused trash left unfinished, once the start's own request ended.
    void this.personalBots?.finishDeletions().catch(() => {})
  }

  private async startOwned(): Promise<void> {
    this.requests.assertAccepting()
    if (this.started) return
    this.started = true

    // Runs the previous daemon left active cannot resume (SPEC §5); settle them before any turn,
    // and before anything that can send one (H4): scheduled jobs and the network both
    // start below, so none of their sends can create a run that boot recovery then interrupts.
    this.orchestrator.recoverRunEngineOnBoot()
    // Personal bots settle what the crash left before any worker can change a bot run (PR 6 §5a).
    if (this.personalBots) {
      try {
        await this.personalBots.reconcileOnStartup()
      } catch (error) {
        console.warn('the bot startup pass failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.startRunEngineWorkers()

    if (this.config.getScheduledSection().enabled) {
      this.scheduled.start()
      // Bot schedules follow the same switch: with the scheduler off, nothing starts on its own.
      this.botScheduler?.start()
    }
    await this.net.start()
    // After the net service has loaded its ports, so the listener can refuse one of them.
    await this.listenScheduledWebhooksIfEnabled()

    await this.startMcpServer()
    // Restore multi-tenant runtimes; mark non-reattachable PTY/agents interrupted.
    this.threadRuntimes.restoreOnStartup()
    // Questions are memory-only — new process has none; document interrupted semantics.
    this.questions.markInterruptedByDaemonRestart()
    await this.platform.workflowRuns.startRecovery()
    this.undoRetention.start()
    this.pullRequestWatch.start()
    // A profile with no storage policy gets one now: what it had before for a profile in use, the recommended rules for a new one.
    try { this.storagePolicy.initialize(() => this.threads.lifecycleStore.list().length > 0 || this.threads.listAllThreads().length > 0) }
    catch { /* The policy is read again by every run; one that cannot be written is reported there. */ }
    // The storage service is the only scheduler; it runs the trash sweep inside its own run.
    this.storageCleanup.start()
    this.storageUsage.start()

    // Headless-safe: reclaim abandoned claims and drain pending normal work without the GUI.
    // Non-blocking; live peer ownership is never stolen.
    this.orchestrator.scheduleStartupQueueRecovery()

    this.events.emit({ channel: 'projects:updated', data: this.projects.listProjects() })
    this.events.emit({ channel: 'threads:updated', data: this.threads.listAllThreads() })
    this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
    this.events.emit({ channel: 'scheduled:status', data: this.scheduled.getStatus() })
  }

  /**
   * Persist orchestrator messages + native context for a thread.
   * Merges existing agents, tasks, and Mousse-agent sessions from disk.
   * Never passes messageQueue — queue persistence is exclusively via saveMessageQueue.
   *
   * Missing/deleted threads are a safe no-op. Real I/O/persistence failures propagate
   * so queue acceptance cannot complete a claim after a silent write failure.
   */
  private persistOrchestratorThread(threadId?: string | null): void {
    const id = threadId ?? this.orchestrator.getBoundThreadId()
    if (!id) return
    if (!this.threads.getThread(id)) return

    // Atomic RMW: merge live messages/llm with latest agents/tasks under one lock.
    this.threads.mutateThreadData(id, (current) => {
      let agents = current.agents
      let tasks = current.tasks
      try {
        const rt = this.threadRuntimes.getOrHydrate(id)
        agents = rt.agents.list()
        tasks = rt.tasks.list()
      } catch {
        /* keep current */
      }
      return {
        messages: this.orchestrator.getMessagesForPersistence(id),
        agents,
        tasks,
        llmContext: this.orchestrator.getNativeContext(id)
      }
    })
  }

  /** Stop personal services only. Installation retains shared providers and owner lease. */
  stop({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      return Promise.reject(new Error('Invalid shutdown timeout'))
    this.beginShutdown()
    if (this.stopped) return Promise.resolve()
    if (!this.stopOperation) {
      const operation = this.finishStop()
      this.stopOperation = operation
      void operation.catch(() => {
        if (this.stopOperation === operation) this.stopOperation = undefined
      })
    }
    // Deadline only limits this caller's wait. The underlying operation retains
    // ownership and is reused by later attempts until it has actually settled.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new DomainRpcError('profile_busy', 'Profile work is still draining', {
              profileId: this.profileId,
              activity: this.getOwnedActivity()
            })
          ),
        timeoutMs
      )
      this.stopOperation!.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error) => {
          clearTimeout(timer)
          reject(
            containsProfileBusy(error)
              ? new DomainRpcError('profile_busy', 'Profile work is still draining', {
                  profileId: this.profileId,
                  activity: this.getOwnedActivity()
                })
              : error
          )
        }
      )
    })
  }

  /** Executes `turn.*` effects (SPEC §12.3); null until `start()` has recovered the engine. */
  get effectWorker(): EffectWorker | null {
    return this.runEffectWorker
  }

  /** Repairs stored run/effect state (SPEC §12.4); null until `start()`. */
  get reconciler(): Reconciler | null {
    return this.runReconciler
  }

  /** SPEC §12.5 step 6: effect worker, reconciler and daemon heartbeat, after boot recovery. */
  private startRunEngineWorkers(): void {
    const engine = this.runEngine
    const worker = new EffectWorker({
      outbox: engine.outbox,
      executors: this.orchestrator.effectExecutors(),
      owner: engine.leaseOwner,
      fibres: this.effectFibres
    })
    const reconciler = new Reconciler({
      store: engine.store,
      outbox: engine.outbox,
      tools: engine.tools,
      capabilitiesFor: (threadId) => this.orchestrator.capabilitiesForThread(threadId),
      credentials: this.mcpCredentials
    })
    this.runEffectWorker = worker
    this.runReconciler = reconciler
    worker.start()
    reconciler.start()
    // A stored inbox row is the source of truth; its event only makes rule 4 run sooner.
    let wakePass: ReturnType<typeof setImmediate> | null = null
    const onInbox = (event: ThreadEvent): void => {
      if (event.type !== 'inbox.status' || wakePass || this.runReconciler !== reconciler) return
      wakePass = setImmediate(() => {
        wakePass = null
        if (this.runReconciler !== reconciler) return
        try {
          reconciler.runOnce()
        } catch (error) {
          console.warn('run engine reconciler pass failed', error)
        }
      })
    }
    engine.on('event', onInbox)
    this.stopInboxWakes = () => {
      engine.off('event', onInbox)
      if (wakePass) clearImmediate(wakePass)
      wakePass = null
    }
    this.orchestrator.attachEffectWorker(worker)
    this.daemonHeartbeat = setInterval(() => {
      try {
        engine.heartbeatDaemon()
      } catch (error) {
        console.warn('run engine daemon heartbeat failed', error)
      }
    }, 10_000)
    this.daemonHeartbeat.unref?.()
  }

  /**
   * SPEC §15.1: the Mousse MCP server starts after the run engine workers; turns of MCP-capable
   * adapters then get a credential. A server that cannot bind leaves those turns without Mousse
   * tools rather than failing the profile.
   */
  private async startMcpServer(): Promise<void> {
    try {
      await this.mcpServer.start()
      this.orchestrator.setMcpAttachment(this.mcpServer)
    } catch (error) {
      console.warn('Mousse MCP server failed to start; vendor runtimes run without Mousse tools', error)
    }
  }

  /**
   * Stops the reconciler and the worker (in-flight turns abort through their effect signal) and
   * waits for the orchestrator and every executor to drain. The clean daemon end is not written
   * here: `finishStop` writes it (`endRunEngineEpoch`) once requests are idle.
   */
  private async stopRunEngine(): Promise<void> {
    if (this.daemonHeartbeat) clearInterval(this.daemonHeartbeat)
    this.daemonHeartbeat = null
    // Before the worker stops (it aborts the live turns): a stop handler must not withdraw saved approvals.
    this.orchestrator.holdApprovals()
    this.runReconciler?.stop()
    this.stopInboxWakes?.()
    this.stopInboxWakes = null
    // No new credentials; in-flight Mousse tool calls (a blocked ask_user) abort so turns can drain.
    // Only detach what start() attached; a partially constructed profile has no server.
    const mcpServer = this.mcpServer as MousseMcpServer | undefined
    if (mcpServer?.running) this.orchestrator.setMcpAttachment(null)
    const mcpStopped = mcpServer?.stop().catch((error) => {
      console.warn('Mousse MCP server stop failed', error)
    })
    const workerStopped = this.runEffectWorker?.stop()
    await this.orchestrator.shutdown()
    await workerStopped
    await mcpStopped
    // Only detach what start() attached; a profile stopped before start() has no worker.
    if (this.runEffectWorker) this.orchestrator.attachEffectWorker(null)
    this.runEffectWorker = null
    this.runReconciler = null
  }

  /**
   * H5: the clean `ended_at` of this daemon epoch, written only after every cleanup settled, the
   * requests went idle and no owner reports activity, so no live writer
   * can still touch the run database. A stop that failed to drain leaves the epoch open: the next
   * boot treats it as a crash, which is the conservative reading.
   */
  private endRunEngineEpoch(): void {
    // Test fixtures stop a partially constructed profile; a missing engine has nothing to end.
    const engine = this.runEngine as RunEngine | undefined
    try {
      engine?.shutdown()
    } catch (error) {
      console.warn('run engine epoch end failed', error)
    }
  }

  private async finishStop(): Promise<void> {
    // Invoke each cleanup in its own promise. Calling the methods while
    // constructing the array would let one synchronous throw prevent every
    // later owner from even receiving shutdown.
    const cleanups = [
      () => this.undoRetention.stop(),
      () => this.pullRequestWatch.stop(),
      () => this.storageCleanup.stop(),
      () => this.storageUsage.stop(),
      () => this.lifecycle.cleanup.stop(),
      () => this.platform.dispose(),
      () => this.scheduledWebhookServer.stop(),
      () => this.scheduled.shutdown(),
      () => this.stopRunEngine(),
      () => this.net.shutdown(),
      () => this.requests.waitForIdle(),
      () => this.catalogUnsubscribe?.(),
      () => this.harnessImpl?.stop(),
      () => this.antigravity.stop(),
      () => this.claudeSubscription.stop(),
      () => this.codex.stop(),
      () => this.ptyManager.shutdown(),
      () => this.mcpManager.shutdown()
    ]
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => Promise.resolve().then(cleanup))
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Failed to drain profile services')
    // Every remaining owner must drain before profile storage is released.
    const activity = this.getOwnedActivity()
    if (Object.values(activity).some((count) => count > 0)) {
      throw new DomainRpcError('profile_busy', 'Profile work is still draining', {
        profileId: this.profileId,
        activity
      })
    }
    this.endRunEngineEpoch()
    this.config.stopWatching()
    try {
      this.orchestrator.setRunEngine(null)
      this.orchestrator.setBotDispatcher(null)
      this.orchestrator.setBotThreads(null)
      this.personalBots?.close()
      this.botStore?.close()
      this.runEngine.store.db.close()
    } catch (error) {
      console.warn('run engine database close failed', error)
    }
    this.started = false
    this.stopped = true
  }
}
