import { ResourceLifecycleError } from './lifecycle/ResourceLifecycleStore'
import { forgetWorktreeFolders, refreshWorktreeFolders, setWorktreeFolders } from './worktree/worktreeLayout'
import { AgentEpisodeStore } from './agents/AgentEpisodeStore'
import { join } from 'path'
import { homedir, hostname } from 'os'
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
import type { ScheduledJob, Thread } from '../shared/types'
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
import { botApiHost, createBotConnectivity } from './bots/activation/connectivity'
import { createBotActivitySink } from './bots/activity/BotActivitySink'
import { BotBrowsers } from './bots/browser/BotBrowsers'
import { botFilesFolder } from './bots/grants/compile'
import { botInstructions } from './bots/instructions'
import { createBotMemoryAdmin } from './bots/memory/admin'
import { BotMemoryStore } from './bots/memory/BotMemoryStore'
import { botThreadsForCatchUp, createBotJournal } from './bots/memory/capture'
import { createBotContextProvider } from './bots/memory/contextPack'
import { createBotModelResolver, type BotModelChooser } from './bots/model/BotModelResolver'
import { BOT_SUPERVISOR_MISSING, createBotProcessRegistry, type BotProcessRegistry } from './bots/supervisor/BotProcessRegistry'
import { BotScheduleBook, botWhenOf } from './scheduled/botJobs'
import { migrateBotSchedules } from './scheduled/botScheduleMigration'
import type { BotStore } from './bots/store/BotStore'
import { botScheduleLabel } from '../shared/scheduleLabel'
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
import { createProfileSecretAdapter, deleteProfileSecret, listProfileKeyNames, writeProfileSecret } from './profiles/secrets'
import { isKeyName } from '../shared/automationKeys'
import { AutomationDrafts } from './automations/AutomationDrafts'
import { AutomationRuns } from './automations/AutomationRuns'
import type { AutomationInbox, InboxCounts } from '../shared/automationInbox'
import { AUTOMATION_MANAGER_NAME, AUTOMATION_MANAGER_THREAD_KEY, automationManagerWorkspace } from './automations/automationManager'
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
import { ThreadExpiryService } from './lifecycle/ThreadExpiryService'
import { threadFolderExpired, threadFolderRoot } from './data/expiredThreads'
import { isThreadExpired } from '../shared/threadExpiry'
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
import { returnTrashedThreadsToArchive } from './lifecycle/trashToArchive'
import { ThreadDeleter, type DeleteOptions } from './lifecycle/threadDelete'
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
import { releaseThreadSnapshots } from './actions/SnapshotRefReleaseService'
import { PullRequestWatchService, type PullRequestWatchRead, type PullRequestWatchUpdate } from './git/PullRequestWatchService'
import { ThreadEventTriggers } from './automations/threadEventTriggers'
import { buildAutomationIndex, mergeRemoteAutomations } from './automations/AutomationIndex'
import { jobSharedWithComputers, privateThreadOf } from './automations/sharedAutomations'
import type { RemoteAutomationsPart, RemoteAutomationsPort } from './protocol/remoteAutomationsPort'
import { AgentJobAskStore, type AgentJobAsk } from './automations/AgentJobAsks'
import { agentJobExpiry, isActiveAgentJob } from './scheduled/agentJobLimits'
import type { AutomationIndex } from '../shared/automations'
import { resolveThreadProjectPath } from './data/resolveActiveProjectPath'
import { SpeechRelay } from './speech/SpeechRelay'
import { systemClock } from './net/clock'
import { trustExistingProjectsOnce } from './git/repoPrograms'

const STORAGE_LIFECYCLE_METHODS = new Set([
  'threads.delete'
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
  // Deleting a bot archives its threads once its runs stopped; its own request is not other work.
  'bots.delete'
])

/** How often deleted bots past their 30 days are purged. */
const BOT_SWEEP_EVERY_MS = 24 * 60 * 60_000

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
  private readonly threadDeletes: ThreadDeleter
  readonly undoRetention: UndoRetentionSweeper
  /** Watches the pull requests of threads that opted in and tells them about checks and reviews. */
  readonly pullRequestWatch: PullRequestWatchService
  readonly storagePolicy: StoragePolicyStore
  /** Storage cleanup rules: the one scheduler for worktree retirement and the trash sweep. */
  readonly storageCleanup: StorageCleanupService
  /** Disk usage for Settings > Storage, measured in the background and cached. */
  readonly storageUsage: StorageUsageService
  /** Deletes threads whose expiry passed (`Thread.expiresAt`). */
  readonly threadExpiry: ThreadExpiryService
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
  /** The automations of the user's other computers, for windows' Automations page. Set and cleared with `threadRouter`. */
  remoteAutomations?: RemoteAutomationsPort
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
  /** Skill ids a bot's ask may name; refreshed when bots open. Unknown until the first discovery. */
  private botKnownSkills: Set<string> | undefined
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
  /** The bots' hidden model choice; also lists the Settings bot model choices (`holdable`). */
  readonly botModels: BotModelChooser
  /** Each bot's own browser (`bots.browser.*`, the browser tools of a bot with "use the browser"). */
  readonly botBrowsers: BotBrowsers
  /** Bots' schedules: automations whose Who is the bot, in the shared scheduled-job store. */
  readonly botSchedules: BotScheduleBook
  private readonly botStore: BotStore | null
  /** The daily purge of deleted bots past their 30 days, also while the schedulers are off. */
  private botSweepTimer: ReturnType<typeof setInterval> | null = null
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
    // Before anything reads or moves a worktree: the folders this profile chose for them are Mousse's (`worktreeLayout`).
    setWorktreeFolders(homeDir, this.settings.get().storage)
    this.providerAuth = shared.providerAuth
    // The built-in instances' launch settings and sign-out live in their instance config (the
    // gateway's); the vendor services read them from there and save through `configure`.
    const launchOf = (instanceId: string) => () => this.harnessImpl?.launchFor(instanceId) ?? {}
    // Bot processes (Bot Phase 1 §5.9): the runtimes report each one by pid and thread, and the
    // profile's registry supervises it outside the daemon's loop. The drivers are built before
    // `bots.db` opens, so the registry is bound later; a report before then (or without bots) is
    // refused, and the runtime ends that process.
    let botProcesses: BotProcessRegistry | undefined
    const superviseBotProcess = (pid: number, threadId: string): void => {
      if (!botProcesses) throw new Error(BOT_SUPERVISOR_MISSING)
      botProcesses.attachThread(threadId, pid)
    }
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
    this.threads.setSqliteStoreEnabled(this.config.get().features.sqliteThreadStore)
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
            oauth: piOAuthBroker(this.providerAuth),
            onBotProcess: superviseBotProcess
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
          }),
          onLockedProcess: superviseBotProcess
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
      names: {
        read: () => config.getProvidersSection().modelNames,
        write: (modelNames) => config.updateProvidersSection({ modelNames })
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
    // Bots run on the owner's own entries: the separate entry an earlier build added for them goes.
    void harness.removeRetiredBotRunner().catch((error) => console.warn('[bots] could not remove the old bot runner entry', { error: error instanceof Error ? error.message : String(error) }))
    // The bots' hidden model (§5.6): the ready providers in this device's scope that can hold the bot.
    const botModels = createBotModelResolver({
      snapshots: () => harness.instances.snapshots({ kind: 'device' }),
      models: (instanceId) => harness.catalog.models(instanceId, { kind: 'device' }),
      hold: { canHoldBot: (instanceId, policy, model) => harness.canHoldBot(instanceId, policy, model) },
      refresh: (instanceId) => harness.refreshPolicyFacts(instanceId),
      // Settings → Models → Bots: blank is Automatic. A choice saved before instances names its provider.
      defaultModel: () => {
        const chosen = this.settings.get().botModel
        const instanceId = chosen?.instanceId || chosen?.llmProvider
        return instanceId && chosen?.model ? { instanceId, model: chosen.model } : undefined
      }
    })
    this.botModels = botModels
    // Activity chips (§5.8): live as `bots.activity` through the engine, rolled up into each message.
    const botActivity = createBotActivitySink({
      emit: (event) => this.personalBots?.publishActivity(event),
      chipContext: (ctx) => ({ filesFolder: botFilesFolder(homeDir, ctx.botId), home: homedir() })
    })
    let botMemory: BotMemoryStore | undefined
    // Each bot's own browser: a managed Chromium session on a profile of its own, apart from the owner's tabs.
    const botBrowsers = new BotBrowsers({
      profileId: this.profileId,
      browser: () => {
        try { return this.platform.browser } catch { return undefined }
      },
      homeThread: (botId) => {
        const entry = this.botStore?.registry(botId)
        return entry && !entry.deletedAt ? entry.homeThreadId ?? undefined : undefined
      }
    })
    this.botBrowsers = botBrowsers
    this.platform.onDispose(() => botBrowsers.dispose())
    const opened = openPersonalBots({
      profileHome: homeDir,
      threads: {
        // Every thread the bot engine makes is the bot's: no thread list or search shows it.
        ensureExecutionThread: (key, name, projectId, ownership) => this.threads.ensureExecutionThread(key, name, projectId, ownership, { botOwned: true }),
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
            // Through the one delete: it is archived, then deleted for good; with unpublished work it stays in Archived.
            return await this.deleteThreadForGood(threadId, { human: false, discard: false, internal: true })
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
      // A resumed bot's due schedules are claimed at once; before the scheduler started this does nothing.
      schedulesChanged: () => { this.scheduled?.wake() },
      // The shared store, through the book made once the scheduler exists below (nothing reads it before that).
      schedules: {
        list: (botId) => this.botSchedules?.list(botId) ?? [],
        get: (botId, scheduleId) => this.botSchedules?.get(botId, scheduleId),
        add: (botId, input, createdBy, options) => this.botSchedules.add(botId, input, createdBy, options),
        remove: (botId, scheduleId) => this.botSchedules?.remove(botId, scheduleId) ?? false,
        removeAll: (botId) => this.botSchedules?.removeAll(botId) ?? 0,
        labelOf: (when) => botScheduleLabel(when)
      },
      models: botModels,
      activity: botActivity,
      clearContext: (threadId) => this.orchestrator.clearConversationContext(threadId),
      archiveThread: (threadId) => { this.threads.setThreadSettled(threadId, true) },
      // Naming a new bot: one short call on the model its activations would use.
      oneShot: async ({ selection, prompt, signal }) => (await harness.oneShot({
        selection: { instanceId: selection.instanceId, llmProvider: selection.instanceId.split(':')[0] ?? '', model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) },
        signal,
        purpose: 'title',
        system: 'Name a helper in 2–3 words.',
        prompt,
        maxChars: 60
      })).text,
      instructions: (bot) => botInstructions(bot),
      scheduleLabel: (when) => botScheduleLabel(when),
      providerLabel: (instanceId) => this.botProviderLabel(instanceId),
      // No internet: a bot waits instead of failing (a DNS lookup and a connection, never a model call).
      connectivity: createBotConnectivity({
        apiHost: (instanceId) => {
          const driver = this.providerInstances.get(instanceId)?.driver
          return botApiHost(driver, driver === 'pi' ? instanceId.split(':')[1] : undefined)
        }
      }),
      // By hand (#673): the ready models that can hold a bot here, named by their provider.
      modelChoices: async () => {
        const seen = new Set<string>()
        return (await botModels.holdable()).flatMap(({ instanceId, model }) => {
          if (seen.has(model)) return []
          seen.add(model)
          const family = this.botProviderLabel(instanceId)
          return [{ model, label: family ? `${family} · ${model}` : model }]
        })
      },
      computerName: () => hostname(),
      otherComputers: () => this.remoteAutomations?.computers() ?? [],
      // A run may only ask for a skill this profile has; MCP tools can't be granted to bots yet.
      knownAsk: (permission) => 'skill' in permission && (this.botKnownSkills?.has(permission.skill) ?? true),
      browser: botBrowsers
    }, ({ store }) => {
      // Memory (WP6) on `bots.db`, right after its migration: the journal, the packs and the owner's memory operations.
      const memory = new BotMemoryStore({ db: store.db, log: (message, error) => console.warn(message, error instanceof Error ? error.message : error ?? '') })
      botMemory = memory
      const journal = createBotJournal({
        store: memory,
        readThread: (threadId) => this.threads.loadThreadData(threadId),
        listThreads: () => botThreadsForCatchUp(store.captureThreads())
      })
      const pack = createBotContextProvider({
        store: memory,
        journal,
        situation: (botId) => this.botSituation(botId),
        scheduleCreatedAt: (botId, scheduleId) => this.botSchedules?.get(botId, scheduleId)?.createdAt
      })
      // A scheduled run of a bot's automation learns the report levels, its context and Tuning, as any automation run does.
      const context: typeof pack = {
        ...pack,
        runPreamble: async (input) => {
          const text = await pack.runPreamble(input)
          const jobId = input.scheduleId ? this.botSchedules?.get(input.botId, input.scheduleId)?.jobId : undefined
          if (!jobId || !this.automationRuns) return text
          try {
            const notice = this.automationRuns.notice(jobId, this.scheduled.getJob(jobId)?.name)
            return text ? `${text}\n\n${notice}` : notice
          } catch {
            return text
          }
        }
      }
      const admin = createBotMemoryAdmin({
        store: memory,
        definition: (botId) => {
          try { return this.personalBots?.definitionOf(botId) } catch { return undefined }
        }
      })
      // Process control (WP1) over this `bots.db`: the engine arms each dispatch, the runtimes attach to it.
      botProcesses = createBotProcessRegistry({ store })
      return { journal, context, memory: admin, supervision: botProcesses }
    })
    this.botStore = opened?.store ?? null
    // A bot's thread from an earlier build, or of a bot that never runs again, is marked as well.
    if (opened) {
      try {
        this.threads.markBotOwned(opened.store.allThreads().map((thread) => thread.threadId))
      } catch (error) {
        console.warn('bot threads could not be marked', error instanceof Error ? error.message : String(error))
      }
    }
    this.personalBots = opened?.engine ?? null
    if (this.personalBots) {
      void this.skillsRegistry.discover()
        .then((snapshot) => { this.botKnownSkills = new Set(snapshot.skills.map((skill) => skill.id)) })
        .catch(() => undefined)
    }
    const personalBots = this.personalBots
    if (personalBots) this.orchestrator.setBotThreads(personalBots)
    // The bots' own app tools (schedules, profile, depth) and memory tools, through the engine.
    if (personalBots && botMemory) {
      const memory = botMemory
      this.orchestrator.setBotAppTools({
        bots: { host: personalBots.tools, activity: botActivity, models: botModels },
        memory: {
          activationOf: (threadId) => personalBots.tools.activationOf(threadId),
          memory,
          // A save's or forget's chip, on the caller's current dispatch.
          onAppResult: (at, tool, result) => botActivity.onAppResult({ botId: at.botId, activationId: at.activationId, dispatchId: personalBots.activationOf(at.threadId)?.dispatchId ?? '' }, tool, result)
        }
      })
    }
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

    // A job whose Who is a saved agent runs it through the profile's agent library.
    this.orchestrator.setScheduledAgentRunner(this.platform.scheduledAgentRunner)
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
    // One scheduler for bots too: a bot's schedule is a job whose Who is the bot, run in the bot's run lane. Its
    // occurrences start only after the bot startup pass (`startOwned`); each tick then does the bots' upkeep.
    this.botSchedules = new BotScheduleBook({ jobs: this.scheduled, label: (when) => botScheduleLabel(when) })
    // An older build that saved the jobs dropped the fields it does not know (a bot's link, drafts, keys...): put back.
    try {
      const restored = this.scheduledStore.restoreDroppedFields()
      if (restored.length) console.info('scheduled jobs: fields an older build dropped were put back', { jobs: restored.length })
    } catch (error) {
      console.warn('scheduled jobs: fields an older build dropped could not be put back', { error: error instanceof Error ? error.message : String(error) })
    }
    // Schedules earlier builds kept in `bots.db` move here once (marked there, never deleted), before anything ticks.
    if (opened) {
      try {
        const moved = migrateBotSchedules({ bots: opened.store, jobs: this.scheduledStore })
        if (moved.moved.length || moved.marked.length || moved.repaired.length || moved.removed.length) console.info('bot schedules moved to the shared scheduler', { moved: moved.moved.length, marked: moved.marked.length, repaired: moved.repaired.length, removed: moved.removed.length })
        for (const failure of moved.failed) console.warn('a bot schedule could not be moved; the next start tries again', failure)
      } catch (error) {
        console.warn('bot schedules could not be moved; the next start tries again', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    // The Automations inbox: every run, its report, usage and the Needs you queue (`automations/automations.db`).
    try {
      this.automationRuns = new AutomationRuns({ profileHome: homeDir })
    } catch (error) {
      console.warn('the automations inbox could not be opened; runs are kept only in each automation\'s history', { error: error instanceof Error ? error.message : String(error) })
    }
    const runs = this.automationRuns
    if (runs) {
      this.scheduled.setRunLedger(runs)
      let pending: NodeJS.Timeout | null = null
      // The page and the project dots read again; a burst of changes is one event.
      runs.onChange(() => {
        if (pending) return
        pending = setTimeout(() => {
          pending = null
          this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
        }, 200)
        pending.unref?.()
      })
      // A deleted automation's Tuning notes and meta go; its runs and their threads stay in the inbox.
      this.scheduled.on('jobRemoved', (jobId: string) => {
        try { runs.forgetAutomation(jobId) } catch { /* the notes stay; nothing reads them */ }
      })
    }
    if (personalBots) {
      this.scheduled.setBotRunner({ runOccurrence: (input) => personalBots.runScheduledOccurrence(input) })
      // Each tick also brings the inbox's bot runs up to date, so their items appear without the page open.
      this.scheduled.setTickHook(async (now) => {
        await personalBots.maintain(now)
        this.syncBotRuns()
      })
    }
    this.orchestrator.setScheduledHooks({
      onOccurrenceSettled: (event) => this.scheduled.occurrenceSettled(event),
      currentPermissionRequest: (jobId) => {
        const job = this.scheduled.getJob(jobId)
        return job ? jobPermissionRequest(job) : undefined
      }
    })
    this.scheduled.setQuestionProbe((threadId) => this.questions.listPendingForThread(threadId).length > 0)
    // An approval or a question on an automation run's thread is a Needs you item until it is answered where it was asked.
    if (runs) {
      this.questions.on('pending', (event: { requestId: string; threadId: string; approval?: unknown }) => {
        try { runs.openAsk(event.threadId, event.requestId, event.approval ? 'approval' : 'ask') } catch { /* the run still asks in its thread */ }
      })
      this.questions.on('cleared', (event: { requestId: string }) => {
        try { runs.closeAsk(event.requestId) } catch { /* the item stays until Resolve */ }
      })
      this.orchestrator.setAutomationRunHooks({
        notice: (jobId, jobName) => runs.notice(jobId, jobName),
        usage: ({ threadId, runId, ...usage }) => { runs.addUsage({ threadId, ...(runId ? { runId } : {}) }, usage) }
      })
    }
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
    this.agentJobAsks = new AgentJobAskStore(homeDir)
    this.orchestrator.setScheduledJobs({
      // A thread whose first ask the person allowed; a profile that turned the old switch on lets every thread add them.
      threadAllowed: (threadId) => config.agentJobsEnabled() || this.agentJobAsks.threadAllowed(threadId),
      askFirst: (input) => {
        const ask = this.agentJobAsks.ask(input)
        this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
        return ask
      },
      jobLimits: () => config.agentJobLimits(),
      // A bot's schedules are the bot's: an agent's schedule tools never see or change them.
      list: () => this.scheduled.listJobs().filter((job) => !job.bot),
      get: (id) => {
        const job = this.scheduled.getJob(id)
        return job?.bot ? undefined : job
      },
      validate: (job) => validateScheduledJobOptions(job, jobOptionDeps),
      create: (input) => this.scheduled.createJob(input),
      update: (id, patch) => this.scheduled.updateJob(id, patch),
      pause: (id, reason) => this.scheduled.pauseJob(id, reason),
      trigger: (id) => this.scheduled.triggerJob(id),
      wake: () => this.scheduled.wake()
    })
    // Automation drafts (v4): the Automation manager's and granted bots' `automation_*` tools, and the page's Turn on.
    this.automationDrafts = new AutomationDrafts({
      get: (id) => this.scheduled.getJob(id),
      list: () => this.scheduled.listJobs(),
      create: (input) => this.scheduled.createJob(input),
      update: (id, patch) => this.scheduled.updateJob(id, patch),
      remove: (id) => this.scheduled.deleteJob(id),
      pause: (id, reason, until) => this.scheduled.pauseJob(id, reason, until),
      projects: () => this.projects.listProjects().map(({ id, name }) => ({ id, name })),
      thread: (id) => this.threads.getThread(id),
      watch: (threadId) => this.syncThreadEventWatch(threadId),
      botExists: (botId) => this.personalBots?.list().some((bot) => bot.id === botId) ?? false,
      addBotSchedule: (botId, input) => {
        const when = botWhenOf(input.schedule)
        if (!when) throw new Error('A bot repeats: give it a time that repeats.')
        const entry = this.botSchedules.add(botId, { when, prompt: input.prompt, name: input.name, tellMe: input.tellMe }, 'owner')
        return this.scheduled.getJob(entry.jobId)!
      },
      personCeiling: (threadId) => this.orchestrator.scheduledCreatorCeiling(threadId),
      reuseThread: (jobId, name, projectId) => this.threads.ensureExecutionThread(`automation-thread:${jobId}`, name.slice(0, 120), projectId),
      ...(runs ? { meta: { get: (jobId: string) => runs.meta(jobId), set: (jobId: string, meta: { originThreadId?: string; context?: string }) => runs.setMeta(jobId, meta), move: (from: string, to: string) => runs.moveMeta(from, to) } } : {})
    })
    this.orchestrator.setAutomationTools({
      drafts: this.automationDrafts,
      isManagerThread: (threadId) => this.threads.getThread(threadId)?.automationManager === true,
      personRequest: (threadId) => [...this.orchestrator.getMessages(threadId)].reverse().find((message) => message.role === 'user')?.content,
      managerWorkspace: () => automationManagerWorkspace(this.homeDir, this.automationManagerProjectId ? this.projects.getProject(this.automationManagerProjectId)?.path : undefined),
      botOf: (threadId) => this.personalBots?.tools.activationOf(threadId)?.botId,
      activationOf: (threadId) => this.personalBots?.tools.activationOf(threadId)?.activationId,
      // "Check this daily" in an ordinary chat: a person's thread, not a run's, a bot's or the manager's.
      ordinaryThread: (threadId) => {
        const thread = this.threads.getThread(threadId)
        if (!thread || thread.automationManager || thread.botOwned || thread.scheduledJobId || thread.settledAt) return false
        if (this.personalBots?.tools.activationOf(threadId)) return false
        return !runs?.liveRunFor({ threadId })
      },
      ...(runs ? { runs: { liveRunFor: (caller) => runs.liveRunFor(caller), report: (caller, level, summary) => runs.report(caller, level, summary) } } : {})
    })
    // Job webhooks: secrets live in this profile's secret file, never in the process environment. The listener
    // looks them up in a small in-memory table that is rebuilt on any scheduler change, so a request costs no file work.
    const webhookSecrets = createProfileSecretAdapter({ profileRoot: homeDir, inheritProcessEnv: false })
    this.scheduled.setWebhookSecrets({
      write: (ref, value) => writeProfileSecret(homeDir, ref, value),
      delete: (ref) => deleteProfileSecret(homeDir, ref)
    })
    this.webhookSecretCache = new WebhookSecretCache(this.scheduledStore, webhookSecrets)
    // Saved keys live in the same secret file, by name; a run that names one that is not there ends Incomplete.
    this.automationKeys = {
      list: () => listProfileKeyNames(homeDir),
      set: (name, value) => {
        if (!isKeyName(name)) throw new Error('A key name is a word like GITHUB_TOKEN')
        writeProfileSecret(homeDir, name, value)
        this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
      },
      has: (name) => listProfileKeyNames(homeDir).includes(name)
    }
    this.scheduled.setKeyStore(this.automationKeys)
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
    this.threadDeletes = new ThreadDeleter({
      store: this.threads.lifecycleStore,
      purge: { preview: (taskId) => this.lifecycle.cleanup.preview(taskId), purge: (input) => this.lifecycle.cleanup.purge(input) },
      getThread: (threadId) => this.threads.getThread(threadId),
      listThreads: () => this.threads.listAllThreads(),
      trash: (threadId, operationId, expectedGeneration) => this.trashThread(threadId, operationId, expectedGeneration),
      restore: (threadId) => this.restoreThread(threadId),
      archive: (threadId) => this.archiveIfStartedByPerson(threadId)
    })
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
        const inventory = await buildResourceInventory(this.threads.lifecycleStore, record)
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
      quiesceDisk: () => { this.threads.quiesceAllThreadStorage(); return this.storageUsage.pause() },
      beforePurgeRemoval: async (record) => {
        // What a deleted thread holds in a snapshot store goes on every pass, while the receipts that name it still exist.
        // Releasing again is harmless; a failure (a file another process holds) stops the pass, so the purge resumes and
        // tries again instead of leaving the refs or the store behind for good.
        const failures: string[] = []
        for (const task of this.lifecycleOwnedTasks(record.taskId)) {
          try { await releaseThreadSnapshots(task.location, undefined, { discardAuthorized: Boolean(record.purge?.discardAuthorized) }) } catch (error) { failures.push(`${task.taskId}: ${error instanceof Error ? error.message : String(error)}`) }
        }
        if (failures.length) throw new Error(`The snapshots of a deleted thread could not be released yet; the delete will try again. ${failures.join('; ')}`)
      },
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
      },
      expired: (record) => this.lifecycleRecordExpired(record)
    })
    this.undoRetention = new UndoRetentionSweeper(this.threads.lifecycleStore)
    this.threadExpiry = new ThreadExpiryService({
      listThreads: () => this.threads.listAllThreads(),
      // The ledger says an expiry purge began even once the thread's folder (with its expiry) is gone.
      unfinished: (now) => this.threads.lifecycleStore.list()
        .filter((record) => !record.parentTaskId && (record.state === 'trashed' || record.state === 'purge-started') &&
          (record.purge?.expired === true || threadFolderExpired(record.location, now)))
        .map((record) => record.taskId),
      runInProgress: (threadId) => this.lifecycleOwnedTasks(threadId).some((task) => this.orchestrator.isTurnActive(task.taskId) || this.runEngine.getActiveRun(task.taskId) !== null),
      stop: async (threadId) => { await this.orchestrator.stopThread(threadId, 'expired', { clearQueue: true }) },
      quiesce: (threadId) => {
        // A question waiting for an answer and an open terminal are not a run: they end at expiry.
        for (const task of this.lifecycleOwnedTasks(threadId)) {
          this.questions.dismissAllForThread(task.taskId, 'thread_deleted')
          this.ptyManager.killByThreadId(task.taskId)
        }
      },
      deleteForGood: (threadId) => this.deleteExpiredThread(threadId),
      onRunEnd: (listener) => {
        const handler = (event: ThreadEvent): void => {
          if (event.type === 'run.status' && TERMINAL_RUN_STATUSES.has((event.payload as RunRecord).status)) listener(event.threadId)
        }
        this.orchestrator.on('run-event', handler)
        return () => { this.orchestrator.off('run-event', handler) }
      },
      log: (message, details) => console.warn(message, details)
    })
    this.pullRequestWatch = new PullRequestWatchService({
      threads: this.threads,
      codeHost: this.gitService.codeHost,
      // The project's checkout names the repository every worktree of it shares, and exists whatever happens to a worktree.
      folderFor: (threadId) => resolveThreadProjectPath(this.projects, this.threads, threadId) ?? null,
      isAvailable: (threadId) => {
        const record = this.threads.lifecycleStore.get(threadId)
        return !record || record.state === 'active'
      },
      runStore: () => this.runEngine.store,
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
    // Thread-event automations wake on their pull request's activity, never on what their own run caused.
    const threadEvents = new ThreadEventTriggers({
      jobs: () => this.scheduled.listJobs(),
      queue: (jobId, kinds, options) => this.scheduled.queueThreadEvent(jobId, kinds, options)
    })
    this.pullRequestWatch.on('read', (event: PullRequestWatchRead) => threadEvents.onRead(event))
    this.pullRequestWatch.on('updated', (event: PullRequestWatchUpdate) => threadEvents.onUpdated(event))
    const storageClock = new StorageSweepClock(this.threads.lifecycleStore.root)
    this.storagePolicy = new StoragePolicyStore(this.threads.lifecycleStore, storageClock, () =>
      this.storageCleanup.scheduleAfterPolicyChange()
    , { deletedThreadsRuleRetired: true })
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
      quiesceDisk: () => { this.threads.quiesceAllThreadStorage(); return this.storageUsage.pause() }
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
        // Independently trashed children retain their own fence and restore choice; one deleted for good holds nothing.
        if (child.state === 'trashed' || child.state === 'purged') return false
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

  /**
   * Deletes a thread whose expiry passed, for good, with its subagent threads (`ThreadDeleter`, with the expiry's
   * intent: no archive first, and the purge has the expiry's authority). A delete a crash or a refusal cut short is
   * finished the same way, also by the next start.
   */
  private async deleteExpiredThread(taskId: string): Promise<void> {
    const record = await this.deleteThreadForGood(taskId, { human: false, discard: false, expiry: true })
    if (record.state !== 'purged') throw new Error(record.blockedReason ?? `The delete stopped with the thread ${record.state}`)
    this.events.emit({ channel: 'threads:updated', data: this.threads.listAllThreads() })
  }

  /**
   * The expiry that lets a purge stand in for a person's Discard has passed for this thread: its own, or for a
   * subagent its owner's (a subagent has no expiry of its own; see `Thread.expiresAt`).
   */
  private lifecycleRecordExpired(record: TaskLifecycleRecord): boolean {
    const seen = new Set<string>()
    const expired = (current: TaskLifecycleRecord | undefined): boolean => {
      if (!current || seen.has(current.taskId)) return false
      seen.add(current.taskId)
      if (threadFolderExpired(current.location)) return true
      // A subagent thread that is not owned by its root follows the root's expiry all the same.
      const root = threadFolderRoot(current.location)
      if (root) {
        const listed = this.threads.getThread(root)
        if (listed) return isThreadExpired(listed)
        if (expired(this.threads.lifecycleStore.get(root))) return true
      }
      return expired(current.parentTaskId ? this.threads.lifecycleStore.get(current.parentTaskId) : undefined)
    }
    return expired(record)
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
    // The trash is a step of a delete: the purge that follows removes the checkout, so it is not retired first.
    await this.lifecycle.trash({
      taskId,
      operationId: this.resolveLifecycleOperationId(taskId, 'trash', operationId),
      expectedGeneration
    })
    return this.threads.lifecycleStore.require(taskId)
  }

  /**
   * Deletes a thread and its subagent threads for good (`ThreadDeleter`): it must be archived, or be Mousse's own
   * delete (`internal`), and only a person in the app may discard unpublished work.
   */
  deleteThreadForGood(taskId: string, options: DeleteOptions): Promise<TaskLifecycleRecord> {
    this.threads.assertLifecycleMutationAvailable()
    return this.threadDeletes.delete(taskId, options)
  }

  async restoreThread(
    taskId: string,
    operationId?: string,
    expectedGeneration?: number
  ): Promise<TaskLifecycleRecord> {
    this.threads.assertLifecycleMutationAvailable()
    const record = await this.lifecycle.restore({
      taskId,
      operationId: this.resolveLifecycleOperationId(taskId, 'restore', operationId),
      expectedGeneration
    })
    // Its delete is over: the consent recorded for it can never be used again.
    if (record.state === 'active') this.threadDeletes.forgetIntent(taskId)
    return record
  }

  /** First-creation asks of agents that add automations (`AgentJobAskStore`). */
  agentJobAsks!: AgentJobAskStore

  /**
   * Answers an agent's first-creation ask. Allow makes the automation as the agent asked, ending after the lifetime
   * limit from now and counted against the active limit, and lets that thread add more; Not now closes the ask.
   */
  answerAgentJobAsk(askId: string, answer: 'allow' | 'not_now'): AgentJobAsk {
    const limits = this.config.agentJobLimits()
    const answered = this.agentJobAsks.answer(askId, answer, (ask) => {
      const active = this.scheduled.listJobs().filter(isActiveAgentJob).length
      if (active >= limits.maxActive) throw new Error(`Agents already have ${active} active automations (the limit is ${limits.maxActive}). Pause or delete one, or raise the limit in Settings, Agent access.`)
      return this.scheduled.createJob({ ...ask.input, expiresAt: agentJobExpiry(limits.lifetimeDays) })
    })
    this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
    return answered
  }

  /** The Automations page's one list (`automations.list`): jobs (bots' schedules among them) and pull request watches. */
  /**
   * A thread's pull request watch for its thread-event automations: on (in `event` mode, unless Notify already serves it)
   * while one of them needs it, and an `event` watch off once none does. A failure to turn it on is shown on the row
   * (the watch is off), never thrown at the edit that caused it.
   */
  syncThreadEventWatch(threadId: string): void {
    try {
      // A draft never runs, so it needs no watch until it is turned on.
      const needed = this.scheduled.listJobs().some((job) => !job.draft && job.trigger?.threadEvent?.threadId === threadId)
      if (needed) this.pullRequestWatch.ensureEventWatch(threadId)
      else this.pullRequestWatch.releaseEventWatch(threadId)
    } catch (error) {
      console.warn('a thread-event automation\'s pull request watch did not change', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Saved keys (#595, the automation part): names in the profile's secret store; values are written, never read back out. */
  automationKeys!: { list(): string[]; set(name: string, value: string): void; has(name: string): boolean }
  automationDrafts!: AutomationDrafts

  /** The project the composer picked for the manager's next turns (see `automationManagerWorkspace`). */
  private automationManagerProjectId: string | undefined

  /** The profile's Automation manager thread: hidden, reusable, made the first time the composer sends. */
  automationManagerThread(projectId?: string): { id: string } {
    this.automationManagerProjectId = projectId
    return this.threads.ensureExecutionThread(AUTOMATION_MANAGER_THREAD_KEY, AUTOMATION_MANAGER_NAME, undefined, undefined, { automationManager: true })
  }

  /** The Automations inbox (`automations/automations.db`); absent when it could not be opened. */
  automationRuns: AutomationRuns | undefined

  /** Brings the inbox's bot runs up to date with their activations. */
  syncBotRuns(): void {
    const runs = this.automationRuns
    const bots = this.personalBots
    if (!runs || !bots) return
    for (const job of this.scheduled.listJobs()) {
      if (!job.bot) continue
      try {
        const facts = bots.service.automationFacts(job.bot.botId, job.bot.scheduleId)
        if (facts) runs.syncBotRuns(job.id, facts.runs)
      } catch {
        // That bot's runs follow at the next read.
      }
    }
  }

  /** `automations.inbox.list`: every run (newest first) with its report, items and usage, the Tuning notes and this month's cost. */
  automationInbox(): AutomationInbox {
    const runs = this.automationRuns
    if (!runs) throw new Error('The automations inbox is not available in this profile.')
    this.syncBotRuns()
    const inbox = runs.list()
    // A run's pull request is its thread's link, read now.
    const threads = new Map<string, Thread | undefined>()
    return {
      ...inbox,
      runs: inbox.runs.map((run) => {
        if (!run.threadId) return run
        if (!threads.has(run.threadId)) threads.set(run.threadId, this.threads.getThread(run.threadId))
        const link = threads.get(run.threadId)?.pullRequest
        return link ? { ...run, pr: { number: link.number, url: link.url } } : run
      })
    }
  }

  /** `automations.inbox.counts`: the project dots. */
  automationInboxCounts(): InboxCounts {
    const runs = this.automationRuns
    if (!runs) return { byProject: {}, total: 0 }
    this.syncBotRuns()
    return runs.counts()
  }

  automationIndex(): AutomationIndex {
    const bots = this.personalBots
    return buildAutomationIndex({
      jobs: () => this.scheduled.listJobs(),
      thread: (id) => this.threads.getThread(id),
      threads: () => this.threads.listAllThreads(),
      projectName: (id) => this.projects.getProject(id)?.name,
      threadMode: (threadId) => this.orchestrator.scheduledCreatorCeiling(threadId),
      savedAgentName: (definitionId) => {
        try {
          return this.platform.agentDefinitions.get(definitionId).settings.identity.name
        } catch {
          return undefined
        }
      },
      ...(bots ? { bot: (botId: string, scheduleId: string) => bots.service.automationFacts(botId, scheduleId) } : {}),
      asks: () => this.agentJobAsks?.open() ?? [],
      pendingApproval: (threadId) => {
        const pending = this.questions.listPendingForThread(threadId)[0]
        const question = pending?.questions.length === 1 ? pending.questions[0] : undefined
        const allow = question?.options.find((option) => option.decision === 'allow' && option.scope !== 'always')
        const deny = question?.options.find((option) => option.decision === 'reject')
        return pending && question && allow && deny && pending.approval
          ? { kind: 'thread_approval', threadId, requestId: pending.requestId, questionId: question.id, allow: allow.id, deny: deny.id }
          : undefined
      },
      workflowApproval: (runId) => {
        const open = this.platform.workflowRuns.approvals.listOpen(this.profileId, runId)
          .filter((record) => Date.parse(record.expiresAt) > Date.now())
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        return open ? { kind: 'workflow_approval', runId, approvalId: open.approvalId, nodeId: open.nodeId, instanceKey: open.instanceKey, attempt: open.attempt } : undefined
      },
      watchStatus: (threadId) => this.pullRequestWatch.status(threadId),
      requestUrl: (jobId) => this.scheduledWebhookUrl(jobId),
      deliveries: (jobId) => this.scheduled.listWebhookDeliveries(jobId),
      payloadKept: (jobId, occurrenceId) => this.scheduled.hasWebhookPayload(jobId, occurrenceId),
      keyStored: (name) => this.automationKeys.has(name)
    })
  }

  /**
   * The list another of the user's computers is given (`automations.list` over Bridge): only what it may see (no
   * bot's automation, no agent's ask, nothing of a private thread), with the full records of its job rows so its
   * window can edit them. Asks are answered on this computer, so nothing is answered in place from there.
   */
  automationIndexForComputer(): AutomationIndex {
    const isPrivate = privateThreadOf(this.threads)
    const index = this.automationIndex()
    const jobs = this.scheduled.listJobs().filter((job) => jobSharedWithComputers(job, isPrivate))
    const shared = new Set(jobs.map((job) => job.id))
    const items = index.items
      .filter((item) => (item.kind === 'job' ? shared.has(item.id) : item.kind === 'watch' ? !isPrivate(item.id) : false))
      .map((item) => {
        if (!item.attention?.answer) return item
        const { answer: _answer, ...attention } = item.attention
        return { ...item, attention }
      })
    return { ...index, items, jobs }
  }

  /** The list a window of this computer is given: this computer's automations, then the other computers'. */
  async automationIndexForWindow(signal?: AbortSignal): Promise<AutomationIndex> {
    const local = this.automationIndex()
    const remote = this.remoteAutomations
    if (!remote) return local
    let parts: RemoteAutomationsPart[] = []
    try {
      parts = await remote.read(signal)
    } catch {
      // The other computers could not be read now: this computer's rows still show.
    }
    return mergeRemoteAutomations(local, parts)
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

  /** Aborts when the profile starts shutting down; a request waiting for a folder's volume ends then. */
  get requestShutdownSignal(): AbortSignal {
    return this.requests.signal
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
    void this.threadExpiry.stop()
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
    if (this.botSweepTimer) clearInterval(this.botSweepTimer)
    this.botSweepTimer = null
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

  /** The one-time move of the old trash to Archived (see `returnTrashedThreadsToArchive`). */
  returnTrashToArchive(): ReturnType<typeof returnTrashedThreadsToArchive> {
    return returnTrashedThreadsToArchive({
      store: this.threads.lifecycleStore,
      restore: (taskId) => this.restoreThread(taskId),
      archive: (taskId) => this.archiveIfStartedByPerson(taskId)
    })
  }

  /** Finishes the deletes a crash or a lock cut short (see `ThreadDeleter.finishCutShort`); run at start, after the move above is done. */
  finishCutShortDeletes(skip?: ReadonlySet<string>): ReturnType<ThreadDeleter['finishCutShort']> {
    return this.threadDeletes.finishCutShort(skip)
  }

  /** What a bot's context pack says about the present (bot-context.md §5.1): the owner's name, open asks and schedules. */
  private botSituation(botId: string): { ownerName?: string; openAsks?: string[]; schedules?: Array<{ label: string; nextAt?: string }> } {
    const engine = this.personalBots
    const store = this.botStore
    if (!engine || !store) return {}
    const ownerName = this.settings.get().profile.username.trim()
    const openAsks = store.openAsks(botId).filter((ask) => ask.messageId !== null).map((ask) => engine.chat.card(ask).title)
    const schedules = engine.listSchedules(botId).map((schedule) => ({ label: schedule.label, ...(schedule.nextAt ? { nextAt: schedule.nextAt } : {}) }))
    return { ...(ownerName ? { ownerName } : {}), ...(openAsks.length ? { openAsks } : {}), ...(schedules.length ? { schedules } : {}) }
  }

  /** A provider family in plain words for a bot's usage-limit pause ("your Claude usage limit"); never a model. */
  private botProviderLabel(instanceId: string): string {
    const driver = this.providerInstances.get(instanceId)?.driver
    if (driver === 'claude') return 'Claude'
    if (driver === 'codex') return 'ChatGPT'
    const provider = driver === 'pi' ? instanceId.split(':')[1] : undefined
    return provider ? this.providerAuth.getProviderDisplayName(provider) : ''
  }

  /**
   * Archives a thread a person started, or a subagent thread whose parent chain is gone (it is then listed on its
   * own). A subagent thread under its parent, or a thread another owns (a bot's), is left as it is.
   */
  private archiveIfStartedByPerson(taskId: string): void {
    const thread = this.threads.getThread(taskId)
    const root = thread?.lineage?.rootThreadId
    if (!thread || thread.settledAt || (root && root !== taskId && this.threads.getThread(root)) || this.threads.lifecycleStore.get(taskId)?.parentTaskId) return
    this.threads.setThreadSettled(taskId, true)
  }

  async initialize(): Promise<void> {
    // The chosen worktree folders that are connected, with what Mousse made in them, before anything recovers or runs Git there.
    await refreshWorktreeFolders()
    await this.lifecycle.recoverAll()
    // After the trash operations a crash left are finished: once, what was in the old trash comes back, archived.
    // Only then is a thread still in the trash a delete that was cut short, and it is finished.
    try {
      const returned = await this.returnTrashToArchive()
      if (returned.failed.length) console.warn('some threads in the trash could not be moved to Archived; trying again at the next start', { failed: returned.failed })
      // While the move is still bringing threads back, those are left to it; everything else is finished now.
      const finished = await this.finishCutShortDeletes(new Set(returned.waiting))
      const kept = finished.filter((entry) => entry.outcome === 'kept')
      if (kept.length) console.warn('some threads in the trash could not be finished or put back; trying again at the next start', { kept })
    } catch (error) {
      console.warn('threads in the trash could not be moved to Archived or finished', { error: error instanceof Error ? error.message : String(error) })
    }
    // Threads no longer wait in a trash, so its automatic emptying has nothing to do; a value saved before is turned off.
    try {
      const trash = this.lifecycle.cleanup.policy()
      if (trash.automaticPurge) this.lifecycle.cleanup.configure({ ...trash, automaticPurge: false }, true)
    } catch { /* An unreadable policy keeps the sweep off: it reads the same file and stops. */ }
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
    // A bot's schedules are its About's too: an edit from the Automations page (or a moved next run) tells its bot.
    let botSchedulesSeen = new Map<string, string>()
    this.scheduled.on('updated', (jobs) => {
      this.events.emit({ channel: 'scheduled:updated', data: jobs })
      const seen = new Map<string, string>()
      for (const job of jobs as ScheduledJob[]) {
        if (!job.bot) continue
        seen.set(job.bot.botId, `${seen.get(job.bot.botId) ?? ''}|${job.id}:${job.name}:${job.prompt}:${JSON.stringify(job.schedule)}:${job.enabled}:${job.state === 'paused'}:${job.nextRunAt}:${job.tellMe ?? ''}`)
      }
      for (const botId of new Set([...seen.keys(), ...botSchedulesSeen.keys()])) {
        if (seen.get(botId) !== botSchedulesSeen.get(botId)) this.personalBots?.schedulesEdited(botId)
      }
      botSchedulesSeen = seen
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
    // Threads that expired, also while the daemon was not running, are deleted once the start's own request
    // ended (a delete waits for the profile to be idle). Until then no turn starts in them: the orchestrator refuses.
    this.threadExpiry.start()
    // Bot deletions a crash or a refused trash left unfinished, once the start's own request ended,
    // then every day: a deleted bot is purged 30 days after its delete, also while schedules are off.
    void this.personalBots?.finishDeletions().catch(() => {})
    if (this.personalBots && !this.botSweepTimer) {
      const bots = this.personalBots
      this.botSweepTimer = setInterval(() => { void bots.sweepDeleted().catch(() => []) }, BOT_SWEEP_EVERY_MS)
      this.botSweepTimer.unref?.()
    }
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
    // Wake rows of a kind no longer written (an earlier pull request watch's) are settled before any worker can run one.
    this.runEngine.inbox.withdrawRetiredRows()
    this.startRunEngineWorkers()

    if (this.config.getScheduledSection().enabled) {
      // Bot schedules are jobs in the same scheduler: with it off, nothing starts on its own.
      this.scheduled.start()
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
    // Each database closes on its own, so one that fails to close never keeps the next open: an open SQLite file
    // keeps the profile's folder from being removed on Windows.
    const closes: Array<[string, () => void]> = [
      ['run engine detach', () => {
        this.orchestrator.setRunEngine(null)
        this.orchestrator.setBotDispatcher(null)
        this.orchestrator.setBotThreads(null)
        this.orchestrator.setBotAppTools(null)
      }],
      ['personal bots close', () => this.personalBots?.close()],
      ['bots database close', () => this.botStore?.close()],
      ['automations database close', () => this.automationRuns?.close()],
      ['run engine database close', () => this.runEngine.store.db.close()],
      ['thread databases close', () => this.threads.closeThreadStorage()]
    ]
    for (const [what, close] of closes) {
      try {
        close()
      } catch (error) {
        console.warn(`${what} failed`, error)
      }
    }
    // What this profile chose for worktrees is no longer Mousse's to act on through it.
    forgetWorktreeFolders(this.homeDir)
    this.started = false
    this.stopped = true
  }
}
