import { createHash } from 'node:crypto'
import type { RelayRendezvous } from './relay/protocol'
import { HostedProfileService } from './plus/HostedProfileService'
import type { PlusConfiguration } from './plus/contracts'
import { DEFAULT_NET_FEATURE_FLAGS, type NetFeatureFlags } from '../../shared/featureFlags'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type {
  NodeDelegation,
  NodeId,
  PresenceMessage,
  Roster,
  RoutesRecord,
  Signed,
  StoredRecord,
  SpaceId,
  StreamId,
  UserId
} from '../../shared/net'
import {
  NetError,
  NET_ERRORS,
  DIAL_TLS_DEADLINE_MS,
  NODE_CAPABILITIES,
  newId,
  isId
} from '../../shared/net'
import type { NetDoctor, NetInitInput, NetLocalMethod, NetStatus } from '../../shared/net/local'
import type {
  Clock,
  Mux,
  SecureChannel,
  SyncSession,
  StreamStore,
  StreamAuthority,
  PeerRef
} from './contracts'
import type { SpaceJoinAdmissionPort } from './enrollment/quarantine'
import { systemClock } from './clock'
import { NetDatabase } from './store/database'
import { SqliteStreamStore } from './store/streams'
import { SqliteExecutionLedger } from './store/executions'
import { SqliteBudgetLedger } from './store/budgets'
import { SqliteOutbox } from './store/outbox'
import { SqliteQuotaRateLedger } from './store/limits'
import { FileBlobStore } from './store/blobs'
import { FileKeyStore, NetIdentityService } from './identity'
import { ProfileTransports } from './transports/manager'
import type { TransportConfiguration } from './transports/registry'
import type { RelayIdentity } from './relay/protocol'
import { inviteRequiresProtection } from './enrollment/service'
import { RouteManagerImpl } from './link/routeManager'
import { openSecureChannel } from './link/secureChannel'
import { NetSyncSession, type SyncSessionOptions } from './sync/session'
import { NodeStreamAuthority } from './sync/nodeAuthority'
import { SyncSupervisor } from './sync/supervisor'
import { DurableRpcDispatcher } from './sync/rpcDispatcher'
import { canonicalJson, encodeMessage, parseProtocolJson } from './sync/codec'
import {
  EnrollmentService,
  EnrollmentGateway,
  EnrollmentQuarantine,
  AuthorityTransferDelivery,
  type AuthorityTransferStatus,
  type GatewayNormalContext
} from './enrollment'

interface NetConfiguration {
  v: 1
  enabled: boolean
  features?: NetFeatureFlags
  direct: { enabled: boolean; host: string; port: number }
  routesVersion: number
  transports?: TransportConfiguration[]
  preparedForJoin?: boolean
}
export interface NetRuntime {
  db: NetDatabase
  keys: FileKeyStore
  identity: NetIdentityService
  streams: SqliteStreamStore
  executions: SqliteExecutionLedger
  budgets: SqliteBudgetLedger
  outbox: SqliteOutbox
  limits: SqliteQuotaRateLedger
  blobs: FileBlobStore
  rpc: DurableRpcDispatcher
  enrollment: EnrollmentService
  transfer: AuthorityTransferDelivery
}
export interface NetDomainComposition {
  store?: StreamStore
  authority?: StreamAuthority
  session?: Pick<
    SyncSessionOptions,
    | 'canReceive'
    | 'verifyRecord'
    | 'retainRosterEvidence'
    | 'verifyPresence'
    | 'capabilities'
    | 'discovery'
    | 'spaceIdentity'
  >
  hostedSpacePeerAuthorized?(user: UserId, node: NodeId): boolean
  spaceJoin?: SpaceJoinAdmissionPort
  onSessionOpened?(session: SyncSession): void
  /** Starts bounded domain recovery after routes and unlocked identity are ready. */
  onActivated?(): void
  /** Synchronously fences admission and starts owned cancellation; does not close stores. */
  beginDisable?(): void
  close?(): void | Promise<void>
  activeCount?(): number
}
const defaults = (): NetConfiguration => ({
  v: 1,
  enabled: false,
  features: { ...DEFAULT_NET_FEATURE_FLAGS },
  direct: { enabled: false, host: '127.0.0.1', port: 0 },
  routesVersion: 0
})

/** One profile owns its keys, ledger, listeners and sessions. Local IPC never takes a profile path. */
export class NetService {
  private readonly clock: Clock
  private state?: NetRuntime
  private config = defaults()
  private transport?: ProfileTransports
  private routes?: RouteManagerImpl
  private localSignedRoutes?: Signed
  private readonly sessions = new Set<NetSyncSession>()
  private readonly drainingSessions = new Set<NetSyncSession>()
  private readonly archiveFences = new Map<SpaceId, Set<StreamId>>()
  private readonly supervisors = new Map<NodeId, SyncSupervisor>()
  private readonly gateways = new Set<EnrollmentGateway | EnrollmentQuarantine>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly shutdownSignal = new AbortController()
  private mutation = Promise.resolve()
  private stopped = false
  private disabled = false
  private disabling?: Promise<NetStatus>
  private lastError?: keyof typeof NET_ERRORS
  private renewal?: { cancel(): void }
  private rosterListener?: () => void
  private domain?: NetDomainComposition
  private domainClosing?: Promise<void>
  private domainClosed = false
  private shutdownInFlight?: Promise<void>
  private shutdownComplete = false
  constructor(
    private readonly options: {
      profileDir: string
      clock?: Clock
      onChanged?(status: NetStatus): void
      composeRuntime?(runtime: NetRuntime): NetDomainComposition | void
    }
  ) {
    this.clock = options.clock ?? systemClock
  }
  runtime(): NetRuntime {
    if (this.stopped) throw new NetError('cancelled')
    if (this.state) return this.state
    const db = new NetDatabase({ profileDir: this.options.profileDir, clock: this.clock })
    try {
      db.transaction(() =>
        db.database.exec(
          'CREATE TABLE IF NOT EXISTS net_service_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS net_peer_routes(node TEXT PRIMARY KEY,signed TEXT NOT NULL)'
        )
      )
      const row = db.database
        .prepare('SELECT value FROM net_service_config WHERE singleton=1')
        .get()
      if (row) {
        const cfg = parseProtocolJson(Buffer.from(String(row.value))) as NetConfiguration
        if (cfg.v !== 1) throw new NetError('downgrade_unsupported')
        if (
          typeof cfg.enabled !== 'boolean' ||
          typeof cfg.direct?.enabled !== 'boolean' ||
          typeof cfg.direct.host !== 'string' ||
          !Number.isInteger(cfg.direct.port) ||
          cfg.direct.port < 0 ||
          cfg.direct.port > 65535 ||
          !Number.isSafeInteger(cfg.routesVersion) ||
          cfg.routesVersion < 0
        )
          throw new NetError('storage_corrupt')
        if (cfg.preparedForJoin !== undefined && typeof cfg.preparedForJoin !== 'boolean')
          throw new NetError('storage_corrupt')
        if (cfg.transports !== undefined) {
          if (
            !Array.isArray(cfg.transports) ||
            cfg.transports.length > 8 ||
            new Set(cfg.transports.map((row) => row.id)).size !== cfg.transports.length
          )
            throw new NetError('storage_corrupt')
          try {
            const validator = this.createTransports()
            cfg.transports = cfg.transports.map((row) => validator.validate(row))
          } catch {
            throw new NetError('storage_corrupt')
          }
        }
        if (
          cfg.features !== undefined &&
          (!cfg.features ||
            typeof cfg.features.netBridge !== 'boolean' ||
            typeof cfg.features.netSpaces !== 'boolean' ||
            Object.keys(cfg.features).some((key) => !['netBridge', 'netSpaces'].includes(key)))
        ) {
          throw new NetError('storage_corrupt')
        }
        // Pre-rollout profiles require fresh explicit opt-in; never grandfather undefined flags.
        cfg.features ??= { ...DEFAULT_NET_FEATURE_FLAGS }
        if (!cfg.features.netBridge && !cfg.features.netSpaces) cfg.enabled = false
        this.config = cfg
      }
      const keys = new FileKeyStore(this.options.profileDir)
      const identity = new NetIdentityService({
        database: db.database,
        keys,
        clock: this.clock,
        coordinator: db
      })
      const streams = new SqliteStreamStore(db),
        executions = new SqliteExecutionLedger(db),
        blobs = new FileBlobStore(db)
      const enrollment = new EnrollmentService({
        db,
        identity,
        keys,
        clock: this.clock,
        routes: () => this.signedRoutes()
      })
      const rpc = new DurableRpcDispatcher({
          db,
          identity,
          executions,
          clock: this.clock,
          authorizeMethod: (method) => {
            this.assertEnabled()
            if (method.family === 'bridge') this.assertFeature('netBridge')
            else if (method.family === 'spaces') this.assertFeature('netSpaces')
          }
        }),
        transfer = new AuthorityTransferDelivery({ db, identity, keys })
      transfer.register(rpc)
      rpc.register({
        method: 'authority.transfer.ready',
        capability: 'read',
        mutating: false,
        validate: (params) => {
          if (
            !params ||
            typeof params !== 'object' ||
            Array.isArray(params) ||
            Object.keys(params).length
          )
            throw new NetError('bad_request')
          return params
        },
        handle: async () => {
          return {
            protected: keys.encryptedAtRest(),
            unlocked: keys.state() === 'unlocked',
            node: identity.self()?.node
          }
        }
      })
      this.state = {
        db,
        keys,
        identity,
        streams,
        executions,
        blobs,
        enrollment,
        transfer,
        budgets: new SqliteBudgetLedger(db),
        outbox: new SqliteOutbox(db),
        limits: new SqliteQuotaRateLedger(db),
        rpc
      }
      this.domain = this.options.composeRuntime?.(this.state) ?? undefined
      this.rosterListener = identity.onRosterChanged(() => {
        this.emit()
        if (this.routes) this.refreshPeers()
      })
      return this.state
    } catch (error) {
      this.domain?.close?.()
      this.domain = undefined
      this.state = undefined
      db.close()
      throw error
    }
  }
  private saveConfig(): void {
    const { db } = this.runtime(),
      bytes = canonicalJson(this.config)
    db.transaction(() => {
      db.charge(1, bytes.length)
      db.database
        .prepare(
          'INSERT INTO net_service_config VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value'
        )
        .run(Buffer.from(bytes).toString())
    })
  }
  async start(): Promise<void> {
    if (!existsSync(join(this.options.profileDir, 'net', 'net.db'))) return
    try {
      this.runtime()
      if (this.config.enabled) {
        if (
          this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled) &&
          this.state?.keys.state() === 'unlocked' &&
          this.state.keys.encryptedAtRest()
        )
          await this.recoverHostedLease()
        await this.activate()
        if (this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled))
          this.armPlusRenewal()
      }
    } catch (error) {
      this.lastError = error instanceof NetError ? error.code : 'internal'
      this.emit()
    }
  }
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown> {
    if (this.stopped) throw new NetError('cancelled')
    if (method === 'net.status') return this.status()
    if (method === 'net.plus.status')
      return !this.shutdownSignal.signal.aborted &&
        this.state &&
        this.state.identity.self() &&
        this.state.keys.state() === 'unlocked' &&
        this.state.keys.encryptedAtRest()
        ? this.hostedService().status()
        : { configured: false, connected: false }
    if (method === 'net.disable') return this.disable()
    if (this.disabled) throw new NetError('disabled')
    if (!['net.init', 'bridge.join'].includes(method)) this.assertEnabled()
    if (method.startsWith('bridge.') && method !== 'bridge.join') this.assertFeature('netBridge')
    if (method === 'net.doctor') return this.doctor()
    if (method === 'net.transport.list')
      return {
        manifests: this.createTransports().manifests(),
        transports: this.status().transports ?? []
      }
    if (method === 'bridge.nodes') return this.nodes()
    if (method === 'net.authority.status') {
      const journal = this.requireEnrolled().identity.authorityTransferState()
      return journal
        ? { phase: journal.phase, ...this.runtime().transfer.query() }
        : { phase: 'none' }
    }
    return this.serial(async () => {
      switch (method) {
        case 'net.plus.discover':
          return this.hostedService().discover(String(params.apiOrigin))
        case 'net.plus.login.begin':
          return this.hostedService().beginLogin(
            params.configuration as Omit<PlusConfiguration, 'accountId'>,
            String(params.deviceName),
            params.bindRoot === true
          )
        case 'net.plus.configure':
          return this.hostedService().configure(params.configuration as PlusConfiguration)
        case 'net.plus.login.finish': {
          this.assertPlusTransportCapacity()
          const status = await this.hostedService().finishLogin(String(params.id))
          const configuration = this.createTransports().validate({
            id: 'plus-relay',
            enabled: true,
            settings: { address: this.hostedService().configuration()!.audience }
          })
          this.config.transports = [
            ...(this.config.transports ?? []).filter((row) => row.id !== 'plus-relay'),
            configuration
          ]
          this.saveConfig()
          await this.transport?.teardown()
          this.transport = undefined
          await this.activate()
          this.armPlusRenewal()
          return status
        }
        case 'net.plus.renew': {
          await this.fenceUnauthorizedHostedSpaceRoutes()
          const status = await this.hostedService().renew()
          await this.reconcileHostedSpaceRoutes()
          await this.transport?.teardown()
          this.transport = undefined
          await this.activate()
          this.armPlusRenewal()
          return status
        }
        case 'net.plus.allow':
          await this.hostedService().allow(
            params.node as NodeId,
            Number(params.ttlMs),
            params.revoke === true
          )
          return { approved: params.revoke !== true }
        case 'net.plus.bind':
          return this.hostedService().bind(
            params.configuration as PlusConfiguration,
            String(params.accountToken)
          )
        case 'net.plus.connect': {
          this.assertPlusTransportCapacity()
          const status = await this.hostedService().connect(String(params.accountToken))
          const configuration = this.createTransports().validate({
            id: 'plus-relay',
            enabled: true,
            settings: { address: this.hostedService().configuration()!.audience }
          })
          this.config.transports = [
            ...(this.config.transports ?? []).filter((row) => row.id !== 'plus-relay'),
            configuration
          ]
          this.saveConfig()
          await this.transport?.teardown()
          this.transport = undefined
          await this.activate()
          this.armPlusRenewal()
          return status
        }
        case 'net.plus.disconnect': {
          this.config.transports = (this.config.transports ?? []).filter(
            (row) => row.id !== 'plus-relay'
          )
          this.saveConfig()
          await this.activate()
          if (this.plusRenewal) clearTimeout(this.plusRenewal)
          this.plusRenewal = undefined
          await this.hostedService().revoke()
          this.hostedService().clear()
          return { configured: false, connected: false }
        }
        case 'net.transport.configure': {
          const rt = this.requireEnrolled(),
            checked = this.createTransports().validate({
              id: params.id as string,
              enabled: params.enabled as boolean,
              settings: params.settings
            })
          const existing = this.transportConfigurations().filter((row) => row.id !== checked.id)
          if (existing.length >= 8) throw new NetError('too_large')
          this.config.transports = [...existing, checked]
          if (checked.id === 'direct')
            this.config.direct = {
              enabled: checked.enabled,
              host: (checked.settings as { host?: string }).host ?? '127.0.0.1',
              port: (checked.settings as { port?: number }).port ?? 0
            }
          this.saveConfig()
          if (this.config.enabled) {
            if (
              this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled) &&
              this.state?.keys.state() === 'unlocked' &&
              this.state.keys.encryptedAtRest()
            )
              await this.recoverHostedLease()
            await this.activate()
            if (this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled))
              this.armPlusRenewal()
          }
          this.emit()
          return { transports: this.status().transports ?? [], node: rt.identity.self()!.node }
        }
        case 'net.protect': {
          const rt = this.requireEnrolled()
          rt.keys.protect(params.passphrase as string | undefined)
          this.emit()
          return this.status()
        }
        case 'net.unlock': {
          const rt = this.runtime()
          await rt.keys.unlock(String(params.passphrase))
          if (this.config.enabled) {
            if (
              this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled) &&
              this.state?.keys.state() === 'unlocked' &&
              this.state.keys.encryptedAtRest()
            )
              await this.recoverHostedLease()
            await this.activate()
            if (this.config.transports?.some((row) => row.id === 'plus-relay' && row.enabled))
              this.armPlusRenewal()
          }
          this.emit()
          return this.status()
        }
        case 'net.authority.transfer':
          return this.transferAuthority(params.node as NodeId)
        case 'net.recovery.export':
          return {
            file: Buffer.from(
              await this.requireEnrolled().transfer.exportRecovery(String(params.passphrase))
            ).toString('base64url')
          }
        case 'net.recovery.import': {
          const rt = this.requireEnrolled()
          await rt.transfer.recoverSameIdentity(
            Buffer.from(String(params.file), 'base64url'),
            String(params.passphrase)
          )
          this.emit()
          return this.status()
        }
        case 'net.init':
          return this.init(params as NetInitInput)
        case 'bridge.invite': {
          const runtime = this.requireEnrolled()
          if (!this.routes) await this.activate()
          const invite = this.transport?.hasRelayListener()
            ? await runtime.enrollment.issueNodeInviteWithRendezvous(params, async (expiresAt) => {
                const value = await this.transport!.prepareEnrollmentRendezvous(expiresAt)
                if (!value) throw new NetError('route_unreachable')
                return value
              })
            : runtime.enrollment.issueNodeInvite(params)
          return { invite: invite.text, inviteId: invite.invite, expiresAt: invite.expiresAt }
        }
        case 'bridge.join':
          return this.join(
            String(params.invite),
            params.name as string | undefined,
            params.passphrase as string | undefined
          )
        case 'bridge.revoke': {
          const rt = this.requireEnrolled()
          rt.identity.revoke(params.node as NodeId)
          this.emit()
          return { ok: true }
        }
        case 'bridge.rename': {
          const rt = this.requireEnrolled()
          rt.identity.renameNode(params.node as NodeId, String(params.name))
          return { ok: true }
        }
        default:
          throw new NetError('bad_request')
      }
    })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(() => {
      this.assertInstanceOpen()
      return work()
    })
    this.mutation = result.then(
      () => {},
      () => {}
    )
    return this.track(result)
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation)
    void operation.then(
      () => this.tasks.delete(operation),
      () => this.tasks.delete(operation)
    )
    return operation
  }
  private requireEnrolled(): NetRuntime {
    const rt = this.runtime()
    if (!rt.identity.self()) throw new NetError('not_enrolled')
    if (rt.keys.state() !== 'unlocked')
      throw new NetError(rt.keys.state() === 'missing' ? 'keystore_missing' : 'keystore_locked')
    return rt
  }
  private async init(input: NetInitInput): Promise<NetStatus> {
    const rt = this.runtime()
    if (input.passphrase !== undefined) await rt.keys.unlock(input.passphrase)
    if (!rt.identity.self() && this.config.preparedForJoin) throw new NetError('conflict')
    if (!rt.identity.self()) await rt.identity.bootstrapAuthority(input.name ?? 'My device')
    this.assertInstanceOpen()
    this.config.enabled = true
    this.config.features = { netBridge: true, netSpaces: true }
    if (input.listen)
      this.config.direct = {
        enabled: true,
        host: input.host ?? this.config.direct.host,
        port: input.port ?? this.config.direct.port
      }
    if (input.listen && this.config.transports)
      this.config.transports = [
        ...this.config.transports.filter((row) => row.id !== 'direct'),
        {
          id: 'direct',
          enabled: true,
          settings: { host: this.config.direct.host, port: this.config.direct.port }
        }
      ]
    this.saveConfig()
    await this.activate()
    return this.status()
  }
  private transportConfigurations(): TransportConfiguration[] {
    return (
      this.config.transports ?? [
        {
          id: 'direct',
          enabled: this.config.direct.enabled,
          settings: { host: this.config.direct.host, port: this.config.direct.port }
        }
      ]
    )
  }
  private relayIdentity(node?: NodeId): RelayIdentity {
    const rt = this.runtime(),
      self = rt.identity.self()
    if (!self) {
      if (!node) throw new NetError('not_enrolled')
      return { node, signKey: rt.keys.nodeKeys().sign, sign: (bytes) => rt.keys.signAsNode(bytes) }
    }
    const hello = rt.enrollment.localHello()
    return {
      node: self.node,
      signKey: rt.keys.nodeKeys().sign,
      sign: (bytes) => rt.keys.signAsNode(bytes),
      delegation: hello.delegation,
      roster: hello.roster
    }
  }
  private assertPlusTransportCapacity(): void {
    if ((this.config.transports ?? []).filter((row) => row.id !== 'plus-relay').length >= 8)
      throw new NetError('too_large')
  }
  private async recoverHostedLease(): Promise<void> {
    try {
      await this.fenceUnauthorizedHostedSpaceRoutes()
      await this.hostedService().renew()
      await this.reconcileHostedSpaceRoutes()
    } catch (error) {
      this.lastError = error instanceof NetError ? error.code : 'internal'
      this.emit()
    }
  }
  private hostedConsentFenced = false
  private async fenceUnauthorizedHostedSpaceRoutes(): Promise<void> {
    if (
      this.hostedService()
        .managedSpaceRoutes()
        .some(
          (row) =>
            !this.featureEnabled('netSpaces') ||
            this.domain?.hostedSpacePeerAuthorized?.(row.user, row.node) !== true
        )
    ) {
      this.hostedConsentFenced = true
      await this.transport?.suspendHosted()
    }
  }
  private async reconcileHostedSpaceRoutes(): Promise<void> {
    const hosted = this.hostedService(),
      authorized = (user: UserId, node: NodeId) =>
        this.featureEnabled('netSpaces') &&
        this.domain?.hostedSpacePeerAuthorized?.(user, node) === true
    await this.fenceUnauthorizedHostedSpaceRoutes()
    await hosted.reconcileSpaceRoutes(authorized)
    if (this.hostedConsentFenced) {
      this.hostedConsentFenced = false
      if (this.transport) await this.activate()
    }
  }
  hostedSpaceMembershipChanged(): void {
    if (
      this.shutdownSignal.signal.aborted ||
      !this.config.enabled ||
      !this.state?.identity.self() ||
      this.state.keys.state() !== 'unlocked' ||
      !this.state.keys.encryptedAtRest()
    )
      return
    void this.serial(async () => {
      if (!this.hostedService().status().connected) return
      await this.reconcileHostedSpaceRoutes()
    }).catch((error) => {
      this.lastError = error instanceof NetError ? error.code : 'internal'
      this.armPlusRenewal()
      this.emit()
    })
  }
  private plusAbortBound = false
  private plusRenewal?: ReturnType<typeof setTimeout>
  private armPlusRenewal(): void {
    if (this.plusRenewal || this.shutdownSignal.signal.aborted) return
    const status = this.hostedService().status()
    if (!status.configured || !status.registrationId) return
    this.plusRenewal = setTimeout(
      () => {
        this.plusRenewal = undefined
        if (this.shutdownSignal.signal.aborted) return
        void this.serial(async () => {
          try {
            await this.fenceUnauthorizedHostedSpaceRoutes()
            await this.hostedService().renew()
            await this.reconcileHostedSpaceRoutes()
          } finally {
            this.armPlusRenewal()
          }
        }).catch((error) => {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        })
      },
      status.connected
        ? Math.min(20000, Math.max(1000, (status.expiresAt! - this.clock.now()) / 3))
        : 20000
    )
    this.plusRenewal.unref?.()
    if (!this.plusAbortBound) {
      this.plusAbortBound = true
      this.shutdownSignal.signal.addEventListener(
        'abort',
        () => {
          if (this.plusRenewal) clearTimeout(this.plusRenewal)
          this.plusRenewal = undefined
        },
        { once: true }
      )
    }
  }
  private hostedProfile?: HostedProfileService
  private hostedService(): HostedProfileService {
    const rt = this.requireEnrolled()
    return (this.hostedProfile ??= new HostedProfileService({
      keys: rt.keys,
      now: () => this.clock.now(),
      signal: this.shutdownSignal.signal,
      identity: () => {
        const self = rt.identity.self()!,
          hello = rt.enrollment.localHello()
        return {
          ...self,
          rootKey: rt.identity.pinnedRootKey(self.user)!,
          roster: hello.roster!,
          delegation: hello.delegation!
        }
      }
    }))
  }
  private createTransports(): ProfileTransports {
    return new ProfileTransports({
      clock: this.clock,
      profileDir: this.options.profileDir,
      hosted: () => this.hostedService(),
      identity: () => this.relayIdentity()
    })
  }
  private async activate(): Promise<void> {
    this.assertEnabled()
    const rt = this.requireEnrolled()
    // Reconfiguration interrupts the carrier, not its caller. Space supervisors
    // retry this connection error, including an in-flight join's first-open.
    for (const supervisor of this.supervisors.values()) supervisor.close('route_unreachable')
    this.supervisors.clear()
    for (const session of this.sessions) session.close('route_unreachable')
    this.routes = undefined
    const transport = (this.transport ??= new ProfileTransports({
      clock: this.clock,
      profileDir: this.options.profileDir,
      hosted: () => this.hostedService(),
      relayRendezvous:
        rt.enrollment.preparedNodeJoin()?.rendezvous?.transport === 'plus-relay' &&
        !this.hostedService().status().connected
          ? rt.enrollment.preparedNodeJoin()!.rendezvous
          : undefined,
      identity: () => this.relayIdentity(),
      onChanged: () => {
        if (this.stopped || this.disabled || !this.config.enabled || !this.routes) return
        try {
          this.localSignedRoutes = undefined
          this.signedRoutes()
          this.emit()
        } catch (error) {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        }
      }
    }))
    await transport.start(
      this.transportConfigurations().map((row) =>
        row.id === 'plus-relay' && this.hostedConsentFenced ? { ...row, enabled: false } : row
      ),
      (raw, _info, deadline) => {
        if (this.stopped || this.disabled || !this.config.enabled) {
          raw.destroy()
          return
        }
        this.track(this.accept(raw, deadline)).catch((error) => {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        })
      }
    )
    if (this.stopped || this.disabled || !this.config.enabled) {
      await transport.teardown()
      this.assertEnabled()
    }
    this.routes = new RouteManagerImpl({
      node: rt.identity.self()!.node,
      transports: transport.transports(),
      credentials: rt.keys.tlsCredentials(),
      clock: this.clock,
      routesVersion: this.config.routesVersion
    })
    // Persist the assigned direct port so an ordinary restart preserves reachability.
    const direct = transport.statuses().find((row) => row.id === 'direct')?.routes[0]
    if (direct) {
      this.config.direct.port = Number(new URL(direct.address).port)
      if (this.config.transports)
        this.config.transports = this.config.transports.map((row) =>
          row.id === 'direct'
            ? { ...row, settings: { ...(row.settings as object), port: this.config.direct.port } }
            : row
        )
    }
    this.localSignedRoutes = undefined
    this.signedRoutes()
    this.lastError = undefined
    this.refreshPeers()
    this.scheduleRenewal()
    this.emit()
    this.domain?.onActivated?.()
  }
  signedRoutes(): Signed {
    const rt = this.requireEnrolled()
    if (!this.routes) throw new NetError('route_unreachable')
    const record = this.routes.localRoutes()
    if (!this.localSignedRoutes || record.version !== this.config.routesVersion) {
      const signed = rt.identity.signAsNode(record)
      this.config.routesVersion = record.version
      this.saveConfig()
      this.localSignedRoutes = signed
    }
    return this.localSignedRoutes
  }
  private async accept(raw: Duplex, deadline: number): Promise<void> {
    try {
      this.assertEnabled()
      const rt = this.requireEnrolled()
      const remaining = () => {
        const ms = Math.floor(deadline - this.clock.monotonic())
        if (ms <= 0 || raw.destroyed) throw new NetError('deadline_exceeded')
        return ms
      }
      const channel = await openSecureChannel(raw, {
        role: 'server',
        credentials: rt.keys.tlsCredentials(),
        deadlineMs: Math.min(DIAL_TLS_DEADLINE_MS, remaining()),
        signal: this.shutdownSignal.signal
      })
      try {
        this.assertEnabled()
        const gateway = new EnrollmentGateway({
          channel,
          service: rt.enrollment,
          clock: this.clock,
          preauthDeadlineMs: remaining(),
          spaceJoin: this.domain?.spaceJoin
            ? {
                redeem: async (request, channel) => {
                  this.assertFeature('netSpaces')
                  const response = await this.domain!.spaceJoin!.redeem(request, channel)
                  if (this.transport?.hasPlusRelayListener())
                    await this.serial(async () => {
                      this.hostedService().rememberSpaceRoute(request.node, request.user)
                      await this.reconcileHostedSpaceRoutes()
                    })
                  return response
                }
              }
            : undefined,
          onEnrolled: () => this.transport?.markAuthenticated(raw),
          normalSession: (secure, mux, context) => this.makeSession(secure, mux, context, raw)
        })
        this.gateways.add(gateway)
        try {
          await gateway.completed
        } finally {
          this.gateways.delete(gateway)
        }
      } catch (error) {
        channel.close()
        throw error
      }
    } catch (error) {
      raw.destroy()
      this.transport?.admission.release(raw)
      throw error
    }
  }
  private makeSession(
    channel: SecureChannel,
    mux?: Mux,
    context?: GatewayNormalContext,
    raw?: Duplex
  ): NetSyncSession {
    this.assertEnabled()
    const rt = this.requireEnrolled()
    const store = this.domain?.store ?? rt.streams
    const baseAuthority: StreamAuthority =
      this.domain?.authority ?? new NodeStreamAuthority(rt.identity, store, rt.blobs, this.clock)
    const allowed = (stream: StreamId): boolean => {
      const feature = store.getStream(stream)?.kind.startsWith('space.') ? 'netSpaces' : 'netBridge'
      return this.featureEnabled(feature)
    }
    const check = (stream: StreamId): void => {
      if (!allowed(stream)) throw new NetError('disabled')
    }
    const session = new NetSyncSession({
      ...this.domain?.session,
      channel,
      mux,
      ...context,
      discovery: this.featureEnabled('netSpaces') ? this.domain?.session?.discovery : undefined,
      spaceIdentity: this.featureEnabled('netSpaces')
        ? this.domain?.session?.spaceIdentity
        : undefined,
      identity: rt.identity,
      store,
      blobs: rt.blobs,
      // rpc.v1 also carries shared Net authority transfer on Spaces-only sessions.
      // Method-family policy is enforced by the dispatcher on every entry point.
      rpc: rt.rpc,
      clock: this.clock,
      isStreamQuiesced: (stream) => this.streamQuiesced(stream),
      isSpaceQuiesced: (space) => this.archiveFences.has(space),
      authority: {
        canRead: (...args) => allowed(args[0]) && baseAuthority.canRead(...args),
        canFetchBlob: (...args) => allowed(args[0]) && baseAuthority.canFetchBlob(...args),
        append: (...args) => {
          check(args[0])
          return baseAuthority.append(...args)
        },
        acceptBlob: (...args) => {
          check(args[0])
          baseAuthority.acceptBlob(...args)
        },
        blobCommitted: (...args) => {
          check(args[0])
          baseAuthority.blobCommitted?.(...args)
        }
      },
      localRoutes: () => this.signedRoutes(),
      onPeerRoutes: (routes, peer) =>
        this.adoptRoutes(routes, peer.node, peer.user, peer.delegation),
      onAuthenticated: () => {
        if ([...this.sessions].filter((session) => session.state() === 'open').length > 64)
          throw new NetError('rate_limited')
        if (raw) this.transport?.markAuthenticated(raw)
        this.routes?.markSessionOpen(channel)
        this.emit()
      }
    })
    this.sessions.add(session)
    session.onClosed((error) => {
      this.sessions.delete(session)
      // Closing a carrier does not prove its async source/provider jobs settled.
      if (session.activeTasks().length) {
        this.drainingSessions.add(session)
        void Promise.allSettled(session.activeTasks()).then(() =>
          this.drainingSessions.delete(session)
        )
      }
      if (error instanceof NetError) this.lastError = error.code
      this.emit()
    })
    void session.opened
      .then(
        () => {
          this.lastError = undefined
          this.domain?.onSessionOpened?.(session)
          this.emit()
        },
        () => {}
      )
      .catch(() => {
        this.lastError = 'internal'
        this.emit()
      })
    return session
  }
  /** Root domain owners validate signed peer placement/routes before invoking this carrier dial. */
  async prepareSpaceRendezvous(
    expiresAt: number,
    uses: number
  ): Promise<RelayRendezvous | undefined> {
    this.assertFeature('netSpaces')
    if (!this.transport?.hasPlusRelayListener()) return
    if (uses !== 1)
      throw new NetError(
        'bad_request',
        'Hosted Space invitations admit one exact source device; create separate invitations for each participant.'
      )
    return this.serial(() =>
      this.hostedService().rendezvous(Math.min(expiresAt, Date.now() + 599000), 'space')
    )
  }
  async connectSpaceInvitation(
    peer: PeerRef,
    signal: AbortSignal,
    rendezvous?: RelayRendezvous
  ): Promise<SecureChannel> {
    if (!rendezvous) return this.connectChannel(peer, signal)
    this.assertFeature('netSpaces')
    if (!this.hostedService().status().connected || rendezvous.expiresAt <= Date.now())
      throw new NetError('forbidden', 'Sign in to Mousse ID before joining this hosted Space.')
    const transport = new ProfileTransports({
      clock: this.clock,
      profileDir: this.options.profileDir,
      hosted: () => this.hostedService(),
      identity: () => this.relayIdentity(),
      relayRendezvous: rendezvous
    })
    const hostedSignal = AbortSignal.any([signal, this.shutdownSignal.signal])
    try {
      const raw = await transport.dial(
        { transport: 'plus-relay', address: rendezvous.relay + '?node=' + peer.node, priority: 0 },
        hostedSignal
      )
      raw.once('close', () => {
        void transport.teardown().catch(() => {})
      })
      return await openSecureChannel(raw, {
        role: 'client',
        credentials: this.requireEnrolled().keys.tlsCredentials(),
        expectedPeerFingerprint: createHash('sha256')
          .update(Buffer.from(peer.transportKey, 'base64url'))
          .digest('base64url'),
        deadlineMs: DIAL_TLS_DEADLINE_MS,
        signal: hostedSignal
      })
    } catch (error) {
      await transport.teardown()
      throw error
    }
  }
  async connectChannel(peer: PeerRef, signal: AbortSignal): Promise<SecureChannel> {
    this.assertEnabled()
    this.requireEnrolled()
    if (!this.routes) await this.activate()
    return this.track(
      this.routes!.connect(peer, signal).then((result) => {
        try {
          this.assertEnabled()
          return result.channel
        } catch (error) {
          result.channel.close()
          throw error
        }
      })
    )
  }
  async connectDomainSession(peer: PeerRef, signal: AbortSignal): Promise<SyncSession> {
    const channel = await this.connectChannel(peer, signal),
      session = this.makeSession(channel)
    const abort = () => session.close()
    signal.addEventListener('abort', abort, { once: true })
    session.onClosed(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    await session.opened
    if (session.peer.node !== peer.node || session.peer.user !== peer.user) {
      session.close()
      throw new NetError('peer_key_mismatch')
    }
    return session
  }
  adoptRoutes(
    signed: Signed,
    node: NodeId,
    user?: UserId,
    authenticatedDelegation?: NodeDelegation
  ): void {
    const rt = this.requireEnrolled(),
      owner = user ?? rt.identity.self()!.user
    const root = rt.identity.pinnedRootKey(owner),
      evidence = rt.identity.roster(owner)
    if (!root || !evidence) throw new NetError('bad_delegation')
    const roster = rt.identity.verifySigned<Roster>(evidence, root)
    const delegation = roster.nodes
      .map((row) => rt.identity.verifySigned<NodeDelegation>(row, root))
      .filter((row) => row.subject === node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (
      !delegation ||
      delegation.owner !== owner ||
      delegation.issuedAt > this.clock.now() ||
      delegation.expiresAt <= this.clock.now() ||
      roster.revoked.some(
        (row) => row.subject === node && row.throughKeyEpoch >= delegation.keyEpoch
      )
    )
      throw new NetError('bad_delegation')
    if (
      authenticatedDelegation &&
      (authenticatedDelegation.owner !== owner ||
        authenticatedDelegation.subject !== node ||
        authenticatedDelegation.keyEpoch !== delegation.keyEpoch ||
        JSON.stringify(authenticatedDelegation.keys) !== JSON.stringify(delegation.keys))
    )
      throw new NetError('bad_delegation')
    const incoming = rt.identity.verifySigned<RoutesRecord>(signed, delegation.keys.sign)
    if (
      incoming.node !== node ||
      incoming.issuedAt > this.clock.now() ||
      incoming.routes.length > 32
    )
      throw new NetError('bad_signature')
    rt.db.transaction(() => {
      const row = rt.db.database
        .prepare('SELECT signed FROM net_peer_routes WHERE node=?')
        .get(node)
      if (row) {
        const prior = parseProtocolJson(Buffer.from(String(row.signed))) as Signed,
          document = parseProtocolJson(Buffer.from(prior.payload, 'base64url')) as RoutesRecord
        if (incoming.version < document.version) return
        if (incoming.version === document.version) {
          if (prior.payload !== signed.payload || prior.sig !== signed.sig)
            throw new NetError('conflict')
          return
        }
      }
      const bytes = canonicalJson(signed)
      rt.db.charge(1, bytes.length)
      rt.db.database
        .prepare(
          'INSERT INTO net_peer_routes VALUES(?,?) ON CONFLICT(node) DO UPDATE SET signed=excluded.signed'
        )
        .run(node, Buffer.from(bytes).toString())
    })
  }
  private refreshPeers(): void {
    if (this.stopped || this.disabled || !this.config.enabled || !this.routes || !this.state) return
    const rt = this.state,
      self = rt.identity.self()!
    const root = rt.identity.pinnedRootKey(self.user)!,
      signed = rt.identity.roster()
    if (!signed) return
    const roster = rt.identity.verifySigned<Roster>(signed, root)
    for (const row of rt.db.database.prepare('SELECT node,signed FROM net_peer_routes').all()) {
      const node = String(row.node) as NodeId
      if (node === self.node || this.supervisors.has(node)) continue
      const current = roster.nodes
        .map((value) => rt.identity.verifySigned<NodeDelegation>(value, root))
        .filter((value) => value.subject === node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
      if (
        !current ||
        roster.revoked.some(
          (value) => value.subject === node && value.throughKeyEpoch >= current.keyEpoch
        )
      )
        continue
      const record = parseProtocolJson(Buffer.from(String(row.signed))) as Signed
      let routes: RoutesRecord
      try {
        routes = rt.identity.verifySigned<RoutesRecord>(record, current.keys.sign)
      } catch {
        continue
      }
      if (!routes.routes.length) continue
      const supervisor = new SyncSupervisor({
        identity: rt.identity,
        clock: this.clock,
        connect: async (signal) => {
          this.assertEnabled()
          const latest = this.currentNode(node),
            manager = this.routes!
          const held = rt.db.database
            .prepare('SELECT signed FROM net_peer_routes WHERE node=?')
            .get(node)
          if (!held) throw new NetError('route_unreachable')
          const fresh = rt.identity.verifySigned<RoutesRecord>(
            parseProtocolJson(Buffer.from(String(held.signed))) as Signed,
            latest.keys.sign
          )
          const result = await manager.connect(
            { node, user: self.user, transportKey: latest.keys.transport, routes: fresh.routes },
            signal
          )
          const session = this.makeSession(result.channel)
          const abort = () => session.close()
          signal.addEventListener('abort', abort, { once: true })
          session.onClosed(() => signal.removeEventListener('abort', abort))
          await session.opened
          return session
        }
      })
      this.supervisors.set(node, supervisor)
      supervisor.onClosed(() => this.emit())
      void supervisor.opened.then(
        () => this.emit(),
        () => {}
      )
    }
  }
  private currentNode(node: NodeId): NodeDelegation {
    const rt = this.requireEnrolled(),
      roster = rt.identity.verifySigned<Roster>(
        rt.identity.roster()!,
        rt.keys.rootKey() ?? rt.identity.pinnedRootKey(rt.identity.self()!.user)!
      )
    const result = roster.nodes
      .map((row) => rt.identity.verifySigned<NodeDelegation>(row, roster.rootKey))
      .filter((row) => row.subject === node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!result) throw new NetError('bad_delegation')
    if (
      roster.revoked.some((row) => row.subject === node && row.throughKeyEpoch >= result.keyEpoch)
    )
      throw new NetError('revoked')
    return result
  }
  session(node: NodeId): SyncSession {
    this.assertEnabled()
    for (const session of this.sessions)
      if (session.state() === 'open' && session.peer.node === node) return session
    throw new NetError('peer_offline')
  }
  private streamQuiesced(stream: StreamId): boolean {
    const space = (this.domain?.store ?? this.state?.streams)?.getStream(stream)?.space
    return (
      !!(space && this.archiveFences.has(space)) ||
      [...this.archiveFences.values()].some((streams) => streams.has(stream))
    )
  }
  /** Trusted local deny-only fence, restored from the archive journal before listeners. */
  fenceSpaceArchive(space: SpaceId, streams: readonly StreamId[]): void {
    if (
      !isId('space', space) ||
      !Array.isArray(streams) ||
      !streams.length ||
      streams.length > 128 ||
      new Set(streams).size !== streams.length ||
      streams.some((stream) => !isId('stream', stream))
    )
      throw new NetError('bad_request')
    if (!this.archiveFences.has(space) && this.archiveFences.size >= 128)
      throw new NetError('too_large')
    const store = this.domain?.store ?? this.state?.streams
    // A hidden staged ID may only cancel work; it conveys no descriptor or ACL.
    for (const stream of streams) {
      const descriptor = store?.getStream(stream)
      if (descriptor && descriptor.space !== space) throw new NetError('forbidden')
    }
    const selected = new Set([...(this.archiveFences.get(space) ?? []), ...streams])
    if (selected.size > 128) throw new NetError('too_large')
    this.archiveFences.set(space, selected)
    for (const session of [...this.sessions, ...this.drainingSessions])
      session.fenceSpaceArchive(space, [...selected])
  }
  resumeSpaceStreams(space: SpaceId): void {
    if (!isId('space', space)) throw new NetError('bad_request')
    this.archiveFences.delete(space)
    for (const session of [...this.sessions, ...this.drainingSessions])
      session.resumeSpaceStreams(space)
  }
  async quiesceSpaceStreams(
    space: SpaceId,
    streams: readonly StreamId[],
    signal: AbortSignal
  ): Promise<void> {
    this.fenceSpaceArchive(space, streams)
    const selected = [...this.archiveFences.get(space)!],
      sessions = [...new Set([...this.sessions, ...this.drainingSessions])]
    // Domain RPC DTOs have no trusted Space scope. Never infer it from params.
    if (sessions.some((session) => session.hasUnscopedArchiveWork()))
      throw new NetError('outcome_uncertain')
    const uncertainMutation = sessions.some((session) =>
      session.hasPendingSpaceMutation(space, selected)
    )
    for (const session of sessions) session.cancelSpaceStreams(space, selected)
    await this.drainTasks(
      sessions.flatMap((session) => session.archiveTasks(space, selected)),
      signal
    )
    if (
      uncertainMutation ||
      [...this.sessions, ...this.drainingSessions].some(
        (session) =>
          session.hasUnscopedArchiveWork() || session.archiveTasks(space, selected).length
      )
    )
      throw new NetError('outcome_uncertain')
    // Local BlobUpload has no Space binding. A remaining durable upload cannot
    // safely be attributed to this archive, or cancelled on behalf of another.
    if (this.state?.db.database.prepare('SELECT 1 FROM net_uploads LIMIT 1').get())
      throw new NetError('outcome_uncertain')
  }
  private async drainTasks(
    tasks: readonly Promise<unknown>[],
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new NetError('outcome_uncertain')
    let rejectDrain!: (error: unknown) => void
    const interrupted = new Promise<never>((_, reject) => {
      rejectDrain = reject
    })
    const abort = (): void => rejectDrain(new NetError('outcome_uncertain'))
    const timer = this.clock.setTimeout(abort, 5000)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([Promise.allSettled(tasks), interrupted])
    } finally {
      timer.cancel()
      signal?.removeEventListener('abort', abort)
    }
  }
  async publish(stream: StreamId, record: StoredRecord): Promise<void> {
    this.assertEnabled()
    await Promise.all(
      [...this.sessions]
        .filter((session) => session.state() === 'open')
        .map((session) => session.publishRecord(stream, record))
    )
  }
  /** Trusted local composition only. Presence has no durable delivery receipt. */
  async publishPresence(message: PresenceMessage, exclude?: NodeId): Promise<void> {
    if (message.t !== 'presence') throw new NetError('bad_request')
    encodeMessage(message)
    if (this.stopped || this.disabled || !this.config.enabled) return
    for (const session of this.sessions) {
      if (session.state() !== 'open' || session.peer.node === exclude) continue
      try {
        session.sendEphemeral(message)
      } catch (error) {
        // Negotiated capability, current identity and stream ACL guards remain
        // the session's responsibility; one denied recipient stops no others.
        if (
          error instanceof NetError &&
          (NET_ERRORS[error.code].category === 'denied' ||
            [
              'peer_offline',
              'cancelled',
              'stream_unknown',
              'meta_stale',
              'roster_conflict'
            ].includes(error.code))
        )
          continue
        throw error
      }
    }
  }
  /** Trusted local source errors never expose payloads or affect unrelated streams. */
  async failStream(stream: StreamId, code: import('../../shared/net').NetErrorCode): Promise<void> {
    await Promise.all(
      [...this.sessions]
        .filter((session) => session.state() === 'open')
        .map((session) => session.failServingStream(stream, code))
    )
  }
  private async join(invite: string, name?: string, passphrase?: string): Promise<unknown> {
    const needsProtection = inviteRequiresProtection(invite),
      rt = this.runtime()
    if (passphrase !== undefined) {
      if (rt.identity.self() && !rt.enrollment.preparedNodeJoin()) throw new NetError('conflict')
      if (
        typeof passphrase !== 'string' ||
        !passphrase.length ||
        Buffer.byteLength(passphrase) > 4096
      )
        throw new NetError('bad_request')
      if (rt.keys.state() === 'missing') {
        await rt.keys.initialize({ asAuthority: false })
        this.config.preparedForJoin = true
        this.saveConfig()
      }
      if (rt.keys.state() !== 'unlocked') throw new NetError('keystore_locked')
      rt.keys.protect(passphrase)
    }
    if (needsProtection && !rt.keys.encryptedAtRest()) throw new NetError('keystore_locked')
    const prepared = await rt.enrollment.prepareNodeJoin(invite, name)
    if (prepared.state !== 'enrolled') {
      const transport = new ProfileTransports({
        clock: this.clock,
        profileDir: this.options.profileDir,
        identity: () => this.relayIdentity(prepared.node),
        relayRendezvous: prepared.rendezvous
      })
      await transport.start([], (raw) => raw.destroy())
      const manager = new RouteManagerImpl({
        node: prepared.node,
        transports: transport.transports(),
        credentials: rt.keys.tlsCredentials(),
        clock: this.clock
      })
      const routes = parseProtocolJson(
        Buffer.from(prepared.routes.payload, 'base64url')
      ) as RoutesRecord
      try {
        const result = await manager.connect(
          {
            node: prepared.authority,
            user: prepared.user,
            transportKey: prepared.authorityTransportKey,
            routes: routes.routes
          },
          this.shutdownSignal.signal
        )
        const quarantine = new EnrollmentQuarantine({
          channel: result.channel,
          service: rt.enrollment,
          role: 'joiner',
          clock: this.clock
        })
        this.gateways.add(quarantine)
        try {
          await quarantine.completed
        } finally {
          this.gateways.delete(quarantine)
          quarantine.close()
        }
      } finally {
        await transport.teardown()
      }
    }
    this.assertInstanceOpen()
    this.config.enabled = true
    this.config.features = { netBridge: true, netSpaces: true }
    this.config.preparedForJoin = false
    this.saveConfig()
    await this.activate()
    this.adoptRoutes(prepared.routes, prepared.authority)
    this.refreshPeers()
    const authority = this.supervisors.get(prepared.authority)
    if (authority) await authority.opened
    return { user: prepared.user, node: prepared.node, authority: prepared.authority }
  }
  private async transferAuthority(node: NodeId): Promise<unknown> {
    const rt = this.requireEnrolled()
    let journal = rt.identity.authorityTransferState()
    if (journal) {
      const offer = parseProtocolJson(Buffer.from(journal.offer.payload, 'base64url')) as {
        to: NodeId
      }
      if (offer.to !== node) throw new NetError('conflict')
    } else {
      const ready = (await this.session(node).rpc(
        'authority.transfer.ready',
        {},
        { id: newId('rpc'), deadlineMs: 10000 }
      )) as { protected?: boolean; unlocked?: boolean; node?: NodeId }
      if (ready.node !== node || ready.protected !== true || ready.unlocked !== true)
        throw new NetError('keystore_locked')
      await rt.transfer.prepare(node)
      journal = rt.identity.authorityTransferState()!
    }
    const query = rt.transfer.query()
    const readStatus = async (): Promise<AuthorityTransferStatus> => {
      try {
        return (await this.session(node).rpc('authority.transfer.ack', query, {
          id: newId('rpc'),
          deadlineMs: 10000
        })) as AuthorityTransferStatus
      } catch (cause) {
        throw new NetError('outcome_uncertain', undefined, { cause })
      }
    }
    if (journal.phase !== 'finalized') {
      let ack: Signed | undefined
      try {
        // Resolve a usable pinned session before durably claiming the once-only send.
        const session = this.session(node),
          request = await rt.transfer.takeImportRequest()
        ack = (await session.rpc(request.method, request.params, {
          id: request.id,
          idem: request.idem,
          deadlineMs: 30000
        })) as Signed
      } catch (error) {
        if (
          !(error instanceof NetError) ||
          ![
            'outcome_uncertain',
            'route_unreachable',
            'peer_offline',
            'deadline_exceeded',
            'cancelled'
          ].includes(error.code)
        )
          throw error
        ack = (await readStatus()).ack
      }
      if (!ack) throw new NetError('outcome_uncertain')
      rt.transfer.retire(ack)
    }
    let activated: AuthorityTransferStatus
    try {
      const session = this.session(node),
        request = rt.transfer.takeActivationRequest()
      activated = (await session.rpc(request.method, request.params, {
        id: request.id,
        idem: request.idem,
        deadlineMs: 30000
      })) as AuthorityTransferStatus
    } catch (error) {
      if (
        !(error instanceof NetError) ||
        ![
          'outcome_uncertain',
          'route_unreachable',
          'peer_offline',
          'deadline_exceeded',
          'cancelled'
        ].includes(error.code)
      )
        throw error
      activated = await readStatus()
    }
    if (activated.phase !== 'activated') throw new NetError('outcome_uncertain')
    this.emit()
    return { ...query, phase: 'activated', authority: node }
  }
  private scheduleRenewal(): void {
    this.renewal?.cancel()
    this.renewal = this.clock.setTimeout(
      () => {
        if (this.stopped || this.disabled || !this.config.enabled) return
        try {
          this.state?.identity.renewExpiring(this.clock.now())
        } catch (error) {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        }
        this.scheduleRenewal()
      },
      60 * 60 * 1000
    )
  }
  status(): NetStatus {
    if (!this.state) {
      return {
        enabled: false,
        features: { ...DEFAULT_NET_FEATURE_FLAGS },
        ...(this.disabled ? { restartRequired: true } : {}),
        keystore: existsSync(join(this.options.profileDir, 'net', 'net.db'))
          ? 'unavailable'
          : 'missing',
        routes: [],
        peers: [],
        ...(this.lastError ? { error: this.lastError } : {})
      }
    }
    try {
      const rt = this.state,
        self = rt.identity.self()
      const peers = new Map<NodeId, NetStatus['peers'][number]>()
      for (const [node, supervisor] of this.supervisors)
        peers.set(node, {
          node,
          state:
            supervisor.state() === 'open'
              ? 'open'
              : supervisor.state() === 'connecting'
                ? 'connecting'
                : 'closed'
        })
      for (const session of this.sessions)
        if (session.state() === 'open')
          peers.set(session.peer.node, { node: session.peer.node, state: 'open' })
      return {
        enabled: this.config.enabled,
        features: { ...this.config.features! },
        ...(this.disabled ? { restartRequired: true } : {}),
        keystore: rt.keys.state(),
        protected: rt.keys.encryptedAtRest(),
        ...(self ? { self, rosterState: rt.identity.rosterState(self.user) } : {}),
        routes: this.transport?.routes() ?? [],
        transports: this.transport?.statuses() ?? [],
        peers: [...peers.values()],
        ...(this.lastError ? { error: this.lastError } : {})
      }
    } catch (error) {
      return {
        enabled: false,
        keystore: 'unavailable',
        routes: [],
        peers: [],
        error: error instanceof NetError ? error.code : 'internal'
      }
    }
  }
  private assertInstanceOpen(): void {
    if (this.stopped) throw new NetError('cancelled')
    if (this.disabled) throw new NetError('disabled')
  }
  private assertEnabled(): void {
    this.assertInstanceOpen()
    if (
      !this.config.enabled ||
      (!this.config.features?.netBridge && !this.config.features?.netSpaces)
    ) {
      throw new NetError('disabled')
    }
  }
  featureEnabled(feature: keyof NetFeatureFlags): boolean {
    return (
      !this.stopped &&
      !this.disabled &&
      this.config.enabled &&
      this.config.features?.[feature] === true
    )
  }
  assertFeature(feature: keyof NetFeatureFlags): void {
    this.assertEnabled()
    if (!this.featureEnabled(feature)) throw new NetError('disabled')
  }
  private disable(): Promise<NetStatus> {
    if (this.disabling) return this.disabling
    if (this.disabled) {
      return this.lastError === 'outcome_uncertain'
        ? Promise.reject(new NetError('outcome_uncertain'))
        : Promise.resolve(this.status())
    }
    this.assertEnabled()
    this.config = { ...this.config, enabled: false, features: { ...DEFAULT_NET_FEATURE_FLAGS } }
    this.saveConfig()
    this.disabled = true
    this.shutdownSignal.abort()
    this.transport?.admission.close()
    this.renewal?.cancel()
    this.domain?.beginDisable?.()
    for (const gateway of this.gateways) gateway.close()
    for (const supervisor of this.supervisors.values()) supervisor.close()
    for (const session of this.sessions) session.close()
    this.supervisors.clear()
    this.routes = undefined
    this.localSignedRoutes = undefined
    const teardown = this.track(Promise.resolve().then(() => this.transport?.teardown()))
    const domainDrain = this.closeDomain()
    const complete = Promise.all([teardown, domainDrain]).then(async () => {
      await Promise.allSettled(
        [...this.tasks].filter((task) => task !== domainDrain && task !== teardown)
      )
      await this.drainTasks(
        [...this.sessions, ...this.drainingSessions].flatMap((session) => session.activeTasks())
      )
      if (this.state?.db.database.prepare('SELECT 1 FROM net_uploads LIMIT 1').get())
        throw new NetError('outcome_uncertain')
    })
    // Neither this result nor its timeout is tracked by the work it awaits.
    const result = this.drainTasks([complete])
      .then(async () => {
        await complete
        this.lastError = undefined
        this.emit()
        return this.status()
      })
      .catch(() => {
        this.lastError = 'outcome_uncertain'
        this.emit()
        throw new NetError('outcome_uncertain')
      })
    void complete.catch(() => {})
    this.disabling = result
    this.emit()
    return result
  }
  private nodes(): unknown {
    const rt = this.requireEnrolled(),
      roster = rt.identity.verifySigned<Roster>(
        rt.identity.roster()!,
        rt.identity.pinnedRootKey(rt.identity.self()!.user)!
      )
    const current = new Map<NodeId, NodeDelegation>()
    for (const signed of roster.nodes) {
      const node = rt.identity.verifySigned<NodeDelegation>(signed, roster.rootKey),
        old = current.get(node.subject)
      if (
        !old ||
        node.keyEpoch > old.keyEpoch ||
        (node.keyEpoch === old.keyEpoch && node.issuedAt > old.issuedAt)
      )
        current.set(node.subject, node)
    }
    return {
      nodes: [...current.values()].map((node) => ({
        node: node.subject,
        name: node.name,
        caps: node.caps.filter((cap) => NODE_CAPABILITIES.includes(cap)),
        keyEpoch: node.keyEpoch,
        expiresAt: node.expiresAt,
        self: node.subject === rt.identity.self()!.node,
        revoked: roster.revoked.some(
          (row) => row.subject === node.subject && row.throughKeyEpoch >= node.keyEpoch
        ),
        state: this.status().peers.find((peer) => peer.node === node.subject)?.state ?? 'closed'
      }))
    }
  }
  private doctor(): NetDoctor {
    const status = this.status()
    const checks: NetDoctor['checks'] = [
      {
        name: 'identity',
        ok: !!status.self,
        ...(status.self ? {} : { code: 'not_enrolled' as const }),
        message: status.self ? 'Network identity is initialized.' : NET_ERRORS.not_enrolled.message
      },
      {
        name: 'keys',
        ok: status.keystore === 'unlocked',
        ...(status.keystore === 'unlocked' ? {} : { code: 'keystore_locked' as const }),
        message:
          status.keystore === 'unlocked'
            ? 'The key store is unlocked.'
            : NET_ERRORS.keystore_locked.message
      },
      {
        name: 'roster',
        ok: status.rosterState === 'ok',
        ...(status.rosterState === 'conflict' ? { code: 'roster_conflict' as const } : {}),
        message:
          status.rosterState === 'ok'
            ? 'The adopted roster is consistent.'
            : 'No usable roster is adopted.'
      },
      {
        name: 'direct',
        ok:
          !this.config.direct.enabled ||
          !!status.transports?.find((row) => row.id === 'direct')?.routes.length,
        message: this.config.direct.enabled
          ? status.transports?.find((row) => row.id === 'direct')?.routes.length
            ? 'The direct listener has an advertised route.'
            : 'The direct listener has no route.'
          : 'The direct listener is disabled.'
      }
    ]
    for (const transport of status.transports ?? [])
      if (transport.id !== 'direct')
        checks.push({
          name: `transport:${transport.id}`,
          ok: !transport.enabled || transport.state === 'ready',
          ...(transport.error ? { code: transport.error } : {}),
          message: !transport.enabled
            ? 'The transport is disabled.'
            : transport.error
              ? NET_ERRORS[transport.error].message
              : transport.state === 'ready'
                ? 'The transport listener is ready.'
                : 'The transport listener is unavailable.'
        })
    if (status.error)
      checks.push({
        name: 'service',
        ok: false,
        code: status.error,
        message: NET_ERRORS[status.error].message
      })
    return { ok: checks.every((check) => check.ok), checks }
  }
  private emit(): void {
    this.options.onChanged?.(this.status())
  }
  getActiveCount(): number {
    return (
      this.tasks.size +
      [...this.sessions, ...this.drainingSessions].reduce(
        (count, session) => count + session.activeTasks().length,
        0
      ) +
      (this.domain?.activeCount?.() ?? 0)
    )
  }
  beginShutdown(): void {
    if (this.stopped) return
    this.stopped = true
    this.shutdownSignal.abort()
    this.transport?.admission.close()
    this.renewal?.cancel()
    this.rosterListener?.()
    for (const gateway of this.gateways) gateway.close()
    for (const supervisor of this.supervisors.values()) supervisor.close()
    for (const session of this.sessions) session.close()
    void this.closeDomain().catch(() => {})
  }
  private closeDomain(): Promise<void> {
    if (this.domainClosed) return Promise.resolve()
    if (this.domainClosing) return this.domainClosing
    this.domainClosing = this.track(
      Promise.resolve()
        .then(() => this.domain?.close?.())
        .then(
          () => {
            this.domainClosed = true
          },
          (error) => {
            this.lastError = error instanceof NetError ? error.code : 'internal'
            throw error
          }
        )
    )
    return this.domainClosing
  }
  shutdown(): Promise<void> {
    if (this.shutdownComplete) return Promise.resolve()
    if (this.shutdownInFlight) return this.shutdownInFlight
    this.beginShutdown()
    const closing = this.closeDomain()
    const drain = (async () => {
      // A rejected domain drain can still own provider effects and use its
      // ledger. Keep every store open until a later retry proves it drained.
      await Promise.all([this.transport?.teardown(), closing])
      await Promise.allSettled([...this.tasks])
      await this.drainTasks(
        [...this.sessions, ...this.drainingSessions].flatMap((session) => session.activeTasks())
      )
      this.state?.streams.close()
      this.state?.blobs.close()
      this.state?.db.close()
      this.sessions.clear()
      this.drainingSessions.clear()
      this.supervisors.clear()
      this.gateways.clear()
      this.domain = undefined
      this.shutdownComplete = true
    })()
    this.shutdownInFlight = drain
    void drain.then(
      () => {
        this.shutdownInFlight = undefined
      },
      () => {
        this.shutdownInFlight = undefined
        if (this.domainClosing === closing && !this.domainClosed) this.domainClosing = undefined
      }
    )
    return drain
  }
}
