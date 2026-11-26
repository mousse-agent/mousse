import { registerUpdateRolloutMethods } from './updates/registerRollout'
import { registerChatMethods } from './chats/registerMethods'
import { registerChatNetworkMethods } from './chats/network/registerMethods'
import { registerChatResourceMethods } from './chats/resources/registerMethods'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { MousseConfigStore } from './config/MousseConfigStore'
import { MmsProfileServices } from './MmsProfileServices'
import type { MmsOptions } from './MmsOptions'
import { ProviderAuthService } from './providers/ProviderAuthService'
import { DomainHandlerRegistry } from './protocol/domainRegistry'
import { acquireMmsOwnerLease, canonicalizeHome, type MmsOwnerHandle } from './ownership/MmsOwnerLease'
import { createInstallationPaths, createProfilePaths } from './profiles/paths'
import { ProfileManager } from './profiles/ProfileManager'
import { ProfileMigrationService } from './profiles/migration/MigrationService'
import {
  createControlStoreCredentialAdapter,
  createRetainingGitWorktreeAdapter
} from './profiles/migration/adapters'
import { ProfileHost } from './profiles/ProfileHost'
import { startsAtLogin } from './netEngine/loginStart'
import { startupPhase } from './startup/startupTiming'
import { registerProfileDomain } from './profiles/profileDomain'
import type { ProfileId } from '../shared/profiles/ids'
import { registerEditorTunnelMethods, registerNetMethods } from './net/registerMethods'
import { registerBridgeMethods } from './bridge/registerMethods'
import { registerSpaceMethods } from './spaces/registerMethods'
import { registerSpaceArchiveMethods } from './spaces/archive/registerMethods'
import { registerBotMethods } from './bots/space/registerMethods'
import { BotLocalService } from './bots/space/BotLocalService'
import { registerAgentDefinitionMethods } from './agentDefinitions/registerMethods'
import { registerPersonalBotMethods } from './bots/registerMethods'
import { registerBotDeviceMethods } from './bots/deviceMethods'
import { BotDefinitionError } from './bots/definitions/BotDefinitionStore'
import { registerBotBrowserMethods } from './bots/browser/registerBotBrowserMethods'
import { registerAutomationMethods } from './automations/registerMethods'
import { registerComputerUseMethods } from './computerUse/registerMethods'
import { registerSourceControlMethods } from './sourceControl/registerMethods'
import { GitHubAccount } from './git/GitHubAccount'
import { registerSecretMethods } from './secrets/registerMethods'
import { registerBugReportMethods } from './bugReports/registerMethods'
import { registerWorkflowDefinitionMethods } from './workflows/registerDefinitionMethods'
import { registerWorkflowRunMethods } from './workflows/registerRunMethods'
import { registerIntegrationMethods, type IntegrationDomainRegistration } from './integrations/registerMethods'
import { ConnectionCommandRouter } from './protocol/connectionCommands'
import { registerBrowserMethods, type BrowserDomainRegistration } from './browser/registerBrowserMethods'
import { registerBrowserViewMethods } from './browser/viewer/registerBrowserViewMethods'
import type { BrowserRuntimePort } from '../shared/browser/runtime'
import { BrowserAutomationError } from './browser/automation/BrowserSessionManager'
import { mainBrowserBinding } from './platform/mainBrowserBinding'
import { createBrowserSetupService, type BrowserSetupService } from './browser/BrowserSetupService'
import { createManagedBrowserInstaller } from './browser/install'
import { bundledBrowserWorkerModule } from './browser/workerModulePath'
import { registerBrowserSetupMethods, type BrowserSetupDomainRegistration } from './browser/registerBrowserSetupMethods'
import { registerSpeechHostMethods } from './speech/registerSpeechHostMethods'
import { registerNetEngineMethods, registerNetEngineSshServe } from './netEngine/registerMethods'
import { SshRemote } from './netEngine/ssh/remote'

export type { MmsOptions } from './MmsOptions'

/** One installation owner and shared provider catalog; profile services acquire no lease. */
export class MousseMainService extends MmsProfileServices {
  readonly browserCommandRouter = new ConnectionCommandRouter()
  readonly browserSetup: BrowserSetupService
  private browserSetupDomains?: BrowserSetupDomainRegistration
  private readonly browserProfiles = new Set<MmsProfileServices>()
  private browserDomains?: BrowserDomainRegistration
  private installationLease: MmsOwnerHandle | null
  private installationStopped = false
  private installationStopOperation?: Promise<void>
  private profileHost: ProfileHost | null = null
  /** Checks give the engines of profiles an SSH add reaches their helper (a fake one, or a test build). */
  netEngineLauncher?: (engine: import('./netEngine/NetEngineService').NetEngineService) => void
  /** B's side of Add over SSH for this installation (1b §3.4). */
  private sshRemoteNow?: SshRemote
  private integrationDomains: IntegrationDomainRegistration | null = null
  private readonly domainCleanupSubscriptions: Array<() => void> = []

  private constructor(
    config: MousseConfigStore,
    options: MmsOptions | undefined,
    owner: MmsOwnerHandle | null,
    profileHome: string,
    providers: ProviderAuthService,
    domains: DomainHandlerRegistry,
    installationHome: string,
    profileId: string,
    isDefault: boolean
  ) {
    super(config, options, owner, profileHome, {
      providerAuth: providers,
      domains,
      installationHome,
      personal: true,
      profileId,
      allowLegacyProjectData: isDefault,
      inheritProcessEnvironment: isDefault,
      includeExternalCliConfigs: isDefault
    })
    this.installationLease = owner
    this.browserSetup = createBrowserSetupService({
      root: join(installationHome, 'browser'),
      installer: createManagedBrowserInstaller(),
      activity: { activeManagedSessions: () => [...this.browserProfiles].reduce((sum, services) => sum + services.platform.getManagedBrowserActiveCount(), 0) }
    })
  }

  static async create(options?: MmsOptions): Promise<MousseMainService> {
    const home = canonicalizeHome(options?.homeDir ?? process.env.MOUSSE_HOME ?? join(homedir(), '.mousse'))
    // Installation identity only. Profile bind/switch never changes this.
    process.env.MOUSSE_HOME = home
    const owner = options?.requireOwnership === false ? null : startupPhase('create.ownerLease', () => acquireMmsOwnerLease(home, {
      kind: options?.ownerKind ?? (options?.headless ? 'cli' : 'gui'),
      version: options?.version ?? process.env.npm_package_version,
      build: options?.build,
      token: options?.ownerToken
    }))
    let providers: ProviderAuthService | undefined
    let service: MousseMainService | undefined
    try {
      const installation = createInstallationPaths(home)
      providers = new ProviderAuthService(installation.authJson)
      await startupPhase('create.providers', () => providers!.init())

      const manager = ProfileManager.open(installation)
      const migration = new ProfileMigrationService(installation, manager)
      startupPhase('create.profileMigration', () => migration.run({
        adapters: {
          credentials: createControlStoreCredentialAdapter(),
          gitWorktrees: createRetainingGitWorktreeAdapter()
        }
      }))
      if (!manager.isInitialized()) manager.initializeFresh()

      const defaultId = manager.getDefaultProfileId()
      const defaultPaths = createProfilePaths(installation, defaultId)
      const installationConfig = MousseConfigStore.loadInstallation(home)
      const profileConfig = MousseConfigStore.loadProfile(defaultPaths.root, installationConfig)
      const domains = new DomainHandlerRegistry()

      const providerAuth = providers
      service = startupPhase('create.services', () => new MousseMainService(
        profileConfig,
        options,
        owner,
        defaultPaths.root,
        providerAuth,
        domains,
        home,
        defaultId,
        true
      ))
      const host = new ProfileHost({
        providerAuth: providers,
        domains,
        // One installation store for every profile: the default profile already reads through it.
        installationConfig,
        options: { ...options, homeDir: home },
        configureServices: (profile) => {
          service!.configureProfileBrowser(profile)
          // A profile's networking switch is said in `endpoints.json`, which `mousse-helper pipe` reads.
          profile.netEngine.onSwitched = () => service!.sshEndpointsChanged()
        },
        onProfilesChanged: () => service!.sshEndpointsChanged()
      })
      host.attachDefault(service, defaultId)
      service.profileHost = host
      startupPhase('create.domains', () => { registerProfileDomain(domains, service!); service!.registerPlatformDomains() })
      await service.initialize()
      return service
    } catch (error) {
      if (service) await service.stop()
      else { providers?.stop(); owner?.release() }
      throw error
    }
  }

  override getOwnerLease(): MmsOwnerHandle | null { return this.installationLease }
  override getOwnerRecord() { return this.installationLease?.owner ?? null }

  override getInstallationHost(): ProfileHost | null {
    return this.profileHost
  }

  async getProfileServices(profileId: string): Promise<MmsProfileServices> {
    const host = this.requireHost()
    if (profileId === this.profileId || profileId === host.getDefaultProfileId()) return this
    return host.getProfileServices(profileId)
  }

  override async start(): Promise<void> {
    await super.start()
    const host = this.profileHost
    if (!host) return
    for (const record of host.manager.list()) {
      if (record.status !== 'active' || record.id === this.profileId) continue
      const services = await startupPhase(`profile.${record.id.slice(0, 8)}.open`, () => host.getProfileServices(record.id))
      await startupPhase(`profile.${record.id.slice(0, 8)}.start`, () => services.start())
    }
  }

  /**
   * Called once the daemon published its readiness. The start's deferred passes, and the network engines and their
   * helpers, start now, in the background: readiness never waited for them.
   */
  afterReady(): void {
    // The start's slow passes (lifecycle recovery, the restart's runtime pass, the search index's first sweep) run now.
    if (this.profileHost) this.profileHost.startAfterReadyWork()
    else this.startAfterReadyWork()
    void this.profileHost?.startNetworkedProfiles()
    void this.sshRemote()
      ?.afterReady()
      .catch((error) => console.warn('SSH add setup did not finish', error instanceof Error ? error.message : String(error)))
  }

  /** B's side of Add over SSH: profiles, their engines and the request journal of this installation. */
  sshRemote(): SshRemote | undefined {
    const host = this.profileHost
    if (!host) return undefined
    // Profiles an SSH add made start here; the others started with the daemon.
    const made = new Set<string>()
    this.sshRemoteNow ??= new SshRemote({
      home: host.manager.getInstallationPaths().homeDir,
      profiles: () =>
        host.manager.list().map((record) => ({
          id: record.id,
          label: record.displayName,
          root: host.manager.getPaths(record.id).root,
          active: record.status === 'active'
        })),
      engine: async (id) => {
        const services = await this.getProfileServices(id)
        if (made.delete(id)) await services.start()
        this.netEngineLauncher?.(services.netEngine)
        return services.netEngine
      },
      createProfile: async (label) => {
        // A label another profile has gets a slug of its own (the label stays as the other computer typed it).
        const taken = new Set(host.manager.list().map((record) => record.slug))
        const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'profile'
        let slug = base
        for (let n = 2; taken.has(slug); n++) slug = base + '-' + n
        const id = host.manager.create({ displayName: label, slug }).id
        made.add(id)
        return id
      },
      startsAtLogin: () => startsAtLogin()
    })
    return this.sshRemoteNow
  }

  /** A profile came or went, or its networking switch changed: `endpoints.json` follows, once SSH add is set up. */
  sshEndpointsChanged(): void {
    try {
      this.sshRemoteNow?.writeEndpoints()
    } catch (error) {
      console.warn('endpoints.json was not rewritten', error instanceof Error ? error.message : String(error))
    }
  }

  override stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    this.browserSetup.beginShutdown()
    if (this.installationStopped) return Promise.resolve()
    if (this.installationStopOperation) return this.installationStopOperation
    const operation = (async () => {
      this.sshRemoteNow?.close()
      const results = await Promise.allSettled([this.profileHost?.stopAll(), super.stop(options), this.browserSetup.shutdown(options)])
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
      // An unsuccessful drain still owns the installation. Releasing the lease
      // would allow a second daemon to write alongside unfinished personal work.
      if (errors.length) throw new AggregateError(errors, 'Failed to stop installation services')
      await this.browserCommandRouter.shutdown({ timeoutMs: options.timeoutMs ?? 30_000 })
      this.browserDomains?.dispose()
      this.browserDomains = undefined
      this.browserSetupDomains?.dispose()
      this.browserSetupDomains = undefined
      for (const unsubscribe of this.domainCleanupSubscriptions.splice(0)) unsubscribe()
      this.integrationDomains?.dispose()
      this.integrationDomains = null
      this.providerAuth.stop()
      this.installationLease?.release()
      this.installationLease = null
      this.installationStopped = true
    })()
    this.installationStopOperation = operation
    void operation.catch(() => { if (this.installationStopOperation === operation) this.installationStopOperation = undefined })
    return operation
  }

  private registerPlatformDomains(): void {
    this.browserSetupDomains = registerBrowserSetupMethods(this.domains, this.browserSetup)
    const registeredProfiles = new WeakSet<MmsProfileServices>()
    const profile = async (profileId: string): Promise<MmsProfileServices> => {
      const services = await this.getProfileServices(profileId)
      if (!registeredProfiles.has(services)) {
        services.platform.onDispose(() => this.integrationDomains?.disposeProfile(profileId))
        registeredProfiles.add(services)
      }
      return services
    }
    registerNetMethods(
      this.domains,
      async profileId => (await profile(profileId)).net,
      async profileId => {
        const services = await profile(profileId)
        return { peers: services.peers, engine: { isEngine: (node) => services.netEngine.isEngine(node), setPolicy: (node, change) => services.netEngine.setPolicy(node, change), updateThere: (params) => services.netEngine.updateThere(params) } }
      }
    )
    registerEditorTunnelMethods(this.domains, async profileId => (await profile(profileId)).net)
    registerNetEngineMethods(this.domains, async profileId => (await profile(profileId)).netEngine)
    registerUpdateRolloutMethods(this.domains, async profileId => (await profile(profileId)).updateRollouts())
    registerNetEngineSshServe(this.domains, () => this.sshRemote())
    registerBridgeMethods(this.domains, async profileId => (await profile(profileId)).bridge)
    this.domainCleanupSubscriptions.push(
      registerSpeechHostMethods(this.domains, async profileId => (await profile(profileId)).speechRelay)
    )
    registerSpaceMethods(this.domains, async profileId => (await profile(profileId)).spaces.local)
    registerSpaceArchiveMethods(this.domains, async profileId => (await profile(profileId)).archives)
    const botLocals = new WeakMap<import('./bots/space/BotProfileService').BotProfileService, BotLocalService>()
    registerBotMethods(this.domains, async profileId => {
      const bots = (await profile(profileId)).bots
      let local = botLocals.get(bots)
      if (!local) {
        local = new BotLocalService(bots)
        botLocals.set(bots, local)
      }
      return local
    })
    registerChatMethods(this.domains, async (profileId) => (await profile(profileId)).platform.chats, async profileId => (await profile(profileId)).chatNetwork)
    registerChatNetworkMethods(this.domains, async profileId => (await profile(profileId)).chatNetwork)
    const chatResourceDomains = registerChatResourceMethods(this.domains, async (profileId) => (await profile(profileId)).platform.chatResources)
    this.domainCleanupSubscriptions.push(() => chatResourceDomains.dispose())
    // The Bot UI's methods (`bots.personal.v2`): the profile's bot engine answers them.
    registerPersonalBotMethods(this.domains, async (profileId) => (await profile(profileId)).personalBots?.service)
    // About → Devices: which of the owner's devices reach each bot, kept and set on this computer only.
    registerBotDeviceMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      const engine = services.personalBots
      if (!engine) return null
      return {
        assertBot: (botId) => {
          if (!engine.botIds().includes(botId)) throw new BotDefinitionError('bot_not_found', 'This bot is gone.')
        },
        store: services.botDeviceAccess,
        devices: async () => services.botReach?.devices(),
        changed: (botId) => engine.reachChanged(botId)
      }
    })
    // Each bot's own browser, as its owner sees it (`bots.browser.*`).
    registerBotBrowserMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return services.personalBots ? services.botBrowsers : null
    })
    // Settings → Computer use: whether Cua Driver is here, and its installer.
    registerComputerUseMethods(this.domains, async (profileId) => {
      const { orchestrator } = await profile(profileId)
      return { driver: orchestrator.computerUse(), setup: orchestrator.computerUseSetup() }
    })
    // Settings → Source control and New project's Clone: this computer's GitHub account, shared by every profile.
    let githubAccount: GitHubAccount | null = null
    registerSourceControlMethods(this.domains, () => (githubAccount ??= new GitHubAccount()))
    registerAutomationMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return {
        index: (viewer, signal) => viewer === 'window' ? services.automationIndexForWindow(signal) : viewer === 'computer' ? services.automationIndexForComputer() : services.automationIndex(),
        answerAsk: (askId, answer) => services.answerAgentJobAsk(askId, answer),
        keep: (jobId) => services.scheduled.keepJob(jobId),
        resend: (jobId, occurrenceId) => services.scheduled.resendWebhook(jobId, occurrenceId),
        keys: services.automationKeys,
        drafts: {
          turnOn: (draftId) => services.automationDrafts.turnOn(draftId),
          discard: (draftId) => services.automationDrafts.discard(draftId),
          blank: (projectId) => services.automationDrafts.blank(projectId),
          answered: (draftId) => services.automationDrafts.answered(draftId),
          setWho: (draftId, who) => services.automationDrafts.setWho(draftId, who),
          nextWho: (botId, who) => services.automationDrafts.nextWho(botId ? { botId } : {}, who)
        },
        managerThread: (projectId) => services.automationManagerThread(projectId),
        managerTurn: (runId) => services.automationManagerTurn(runId),
        inbox: {
          list: () => services.automationInbox(),
          counts: () => services.automationInboxCounts(),
          resolve: (runId) => services.automationRuns?.resolve(runId) ?? 0,
          undo: () => services.automationRuns?.undo(),
          calibrate: (runId, kind) => {
            if (!services.automationRuns) throw new Error('The automations inbox is not available in this profile.')
            return services.automationRuns.calibrate(runId, kind)
          },
          removeTuning: (noteId) => services.automationRuns?.removeTuning(noteId) ?? false
        }
      }
    })
    registerSecretMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return {
        requests: {
          list: (threadId) => services.secretRequests.list(threadId),
          answer: (threadId, requestId, value, keep) => services.secretRequests.answer(threadId, requestId, value, keep),
          useSaved: (threadId, requestId) => services.secretRequests.useSaved(threadId, requestId),
          decline: (threadId, requestId) => services.secretRequests.decline(threadId, requestId)
        },
        pasted: { vault: services.secretVault, homeFor: botId => {
          if (!services.personalBots) throw new Error('Bots are not available.')
          return services.personalBots.service.secretHome(botId)
        } },
        list: () => services.secretVault.list(),
        delete: (name) => services.secretVault.delete(name)
      }
    })
    registerBugReportMethods(this.domains, async (profileId) => (await profile(profileId)).bugReports)
    registerAgentDefinitionMethods(this.domains, async (profileId, request) =>
      (await profile(profileId)).platform.agentDomain(request.method, request.params))
    registerWorkflowDefinitionMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.workflowDefinitions)
    registerWorkflowRunMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.workflowRuns)
    this.browserDomains = registerBrowserMethods(this.domains, async (profileId) =>
      (await profile(profileId)).platform.browser)
    // A thread agent's browser without a window, as the person sees it from the thread (`browser.view.*`).
    registerBrowserViewMethods(this.domains, async (profileId) => (await profile(profileId)).platform.browser)
    this.integrationDomains = registerIntegrationMethods(this.domains, async (profileId) => {
      const services = await profile(profileId)
      return {
        profileId, catalog: services.platform.integrations,
        mcpManager: services.mcpManager, projects: services.projects, settings: services.settings
      }
    })
    const integrationDomains = this.integrationDomains
    this.domainCleanupSubscriptions.push(
      this.domains.onConnectionClosed((id) => integrationDomains.disconnect(id)),
      this.domains.onProfileDisposed((id) => integrationDomains.disposeProfile(id))
    )
  }

  private configureProfileBrowser(services: MmsProfileServices): void {
    this.browserProfiles.add(services)
    services.platform.onDispose(() => {
      if (services.platform.getManagedBrowserActiveCount() > 0) throw new Error('Managed browser work is still draining')
      this.browserProfiles.delete(services)
    })
    // A bot's browser installs the managed browser on its first use.
    services.botBrowsers.setSetup({ status: () => this.browserSetup.status(), install: () => this.browserSetup.install() })
    services.platform.configureBrowser({
      installationBrowserRoot: join(this.getHomeDir(), 'browser'),
      // The worker that drives managed Chromium ships in this build (`out/browser-worker`).
      workerModulePath: bundledBrowserWorkerModule(dirname(fileURLToPath(import.meta.url))),
      admitManagedLaunch: async () => {
        const admission = this.browserSetup.admitManagedLaunch()
        try {
          const status = await this.browserSetup.status()
          if (status.availability !== 'ready') throw new BrowserAutomationError({ code: 'setup_required', message: status.message })
          return admission
        } catch (error) {
          admission.release()
          throw error
        }
      }
    })
    services.platform.setBrowserCommandRouter(this.browserCommandRouter)
    const runtime: BrowserRuntimePort = {
      capabilities: (context) => {
        if (context.profileId !== services.profileId) return undefined
        const target = context.source === 'gui' ? services.platform.browser.targetFor(context) : { backend: 'managed-chromium' as const }
        return services.platform.browser.sessions.listThreadSessions({ profileId: context.profileId, threadId: context.threadId })
          .find((session) => session.backend === target?.backend && session.runId === context.runId && session.lifecycle !== 'closed' && session.lifecycle !== 'disconnected')?.capabilities
      },
      readScreenshot: async (context, sessionId, artifactId) => {
        if (!context.vision || context.execution.profileId !== services.profileId) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshot image delivery requires a vision-capable model in the owning profile' })
        const owner = services.platform.browser.sessions.trustedSessionScope({ profileId: services.profileId, threadId: context.execution.threadId, sessionId })
        if (owner.runId !== context.execution.runId) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshot belongs to another execution' })
        const artifact = await services.platform.browser.artifacts.read({ profileId: services.profileId, threadId: owner.threadId, runId: owner.runId, sessionId }, artifactId, Math.min(context.policy.maxArtifactBytes, 16 * 1024 * 1024))
        if (artifact.ref.mediaType !== 'image/png') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser screenshot must be PNG' })
        return { data: Buffer.from(artifact.bytes).toString('base64'), mimeType: 'image/png' }
      },
      requestAccess: (context, signal) => services.platform.browser.requestAccess(context, signal),
      resolveTarget: (context) => {
        if (context.profileId !== services.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
        if (context.source !== 'gui') return { backend: 'managed-chromium' }
        const selected = services.platform.browser.targetFor(context)
        if (!selected) throw new BrowserAutomationError({ code: 'setup_required', message: 'No available in-app browser tab is connected. Open a browser tab and retry.' })
        return selected
      },
      dispatch: async (context, name, args) => {
        const result = await services.platform.browser.dispatch(context, name, args)
        if (!result.ok) throw new BrowserAutomationError(result.error)
        return result.value
      }
    }
    services.platform.agentRuns.setBrowserRuntime(runtime)
    services.platform.workflowAgents.setBrowserRuntime(runtime)
    services.orchestrator.setBrowserRuntime(runtime)
    services.orchestrator.setMainAgentBrowserFactory((turn) => mainBrowserBinding(services, turn))
  }

  private requireHost(): ProfileHost {
    if (!this.profileHost) throw new Error('Profile host is not attached')
    return this.profileHost
  }
}

export function asProfileHost(services: MmsProfileServices): ProfileHost | null {
  return services.getInstallationHost()
}

export type { ProfileId }
