import { createHash, randomBytes } from 'node:crypto'
import type { RelayRendezvous } from './relay/protocol'
import { HOSTED_RELAY_TRANSPORT } from './relay/hostedAudience'
import {
  hostedNotConfigured,
  hostedUnavailable,
  type HostedNet,
  type HostedNetHost,
  type HostedNetModule
} from './hosted'
import type { NodeInviteInput } from './enrollment/service'
import { DEFAULT_NET_FEATURE_FLAGS, type NetFeatureFlags } from '../../shared/featureFlags'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type {
  InviteId,
  NodeCapability,
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
  COMPUTER_NODE_CAPABILITIES,
  NODE_CAPABILITIES,
  newId,
  isId
} from '../../shared/net'
import type {
  NetAddonActionResult,
  NetAddonRecords,
  NetDoctor,
  BridgeNodePolicy,
  EditorProbeResult,
  NetInitInput,
  NetLocalMethod,
  NetStatus
} from '../../shared/net/local'
import type { PermissionMode } from '../../shared/permissionMode'
import { routedVersions } from '../../shared/bridge/routed'
import type { NodePolicy } from './store/nodePolicy'
import type {
  AddonRecordStore,
  Clock,
  Mux,
  SecureChannel,
  SyncSession,
  StreamStore,
  StreamAuthority,
  PeerRef,
  TunnelLink
} from './contracts'
import type { SpaceJoinAdmissionPort } from './enrollment/quarantine'
import { systemClock } from './clock'
import { NetDatabase } from './store/database'
import { SqliteStreamStore } from './store/streams'
import { SqliteExecutionLedger } from './store/executions'
import { SqliteBudgetLedger } from './store/budgets'
import { SqliteOutbox } from './store/outbox'
import { SqliteQuotaRateLedger } from './store/limits'
import { SqliteNodePolicy } from './store/nodePolicy'
import { SqliteBridgeAudit } from './store/audit'
import { SqliteRemoteLists } from './store/remoteLists'
import { FileBlobStore } from './store/blobs'
import { FileKeyStore, NetIdentityService } from './identity'
import { ProfileTransports } from './transports/manager'
import { DirectTransport } from './transports/direct'
import { inboundPrincipal } from './transports/admission'
import { parseSshRoute, readSshApproval } from './transports/ssh'
import { SshBootstrap, type SshBootstrapOptions } from './ssh/bootstrap'
import {
  EditorSshConfig,
  EditorSshError,
  unavailableEditorSsh,
  type EditorSshOptions,
  type LiveComputer
} from './editor/sshConfig'
import {
  EditorTunnels,
  TunnelError,
  type ClientTunnel,
  type EditorTunnelOptions
} from './editor/tunnel'
import { LocalEditorTunnels, type LocalConnection } from './editor/localTunnels'
import { EditorEndpoint } from './editor/endpoint/endpoint'
import type { ProcessHost } from './editor/endpoint/host'
import type { EditorEndpointPort } from './editor/endpoint/port'
import { systemProcessHost } from './editor/endpoint/systemHost'
import { findSshdHelper } from './editor/endpoint/windowsHost'
import type { EditorTunnelInfo, TunnelReason } from '../../shared/net/tunnel'
import {
  EDITOR_TUNNEL_HANDLE,
  EDITOR_TUNNEL_LOCAL_CHUNK_BYTES,
  EDITOR_TUNNEL_LOCAL_READ_WAIT_MS,
  proxyComputerName,
  type EditorTunnelLocalMethod
} from '../../shared/net/editorProxy'
import { isJoinVia } from '../../shared/net/via'
import { isListedComputer } from '../../shared/net/listedComputer'
import {
  PHONE_ENDPOINTS_METHOD,
  PHONE_WEBRTC_OFFER_METHOD,
  PHONE_WEBRTC_TRANSPORT,
  PhoneWebRtcAcceptor,
  classifyAddress,
  nodeDataChannelFactory,
  normalizeAddress,
  type AcceptedWebRtc,
  type PeerConnectionFactory
} from './transports/phoneWebRtc'
import { lookup } from 'node:dns/promises'
import { NET_PROTO_MINOR, WEBRTC_SDP_MAX_BYTES } from '../../shared/net/limits'
import { isOlderVersion } from '../../shared/net/version'
import { mousseVersion } from '../appVersion'
import { PEER_PRESENCE_SCHEMA, PeerPresence, parsePeerInfo, type PeerLink } from './presence'
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

const policyView = (policy: NodePolicy): BridgeNodePolicy => ({
  blocked: policy.blocked,
  maxPermissionMode: policy.maxPermissionMode,
  terminal: policy.terminal,
  editor: policy.editor
})

interface NetConfiguration {
  v: 1
  enabled: boolean
  features?: NetFeatureFlags
  direct: { enabled: boolean; host: string; port: number }
  routesVersion: number
  transports?: TransportConfiguration[]
  /**
   * "Let my other computers work on this computer's threads": routed calls from other computers
   * that hold "Works on threads" are answered unless this is turned off (on when absent). It is read on
   * every call, so turning it off is also a kill switch.
   */
  workOnThreads?: boolean
  /**
   * "Use this computer's SSH server" for editor connections from other computers: the owner's choice for this
   * computer. Off when absent: Mousse's own SSH endpoint answers. It is written only while it is on, so a profile
   * that never used it stays readable by an earlier version.
   */
  editorSystemSsh?: boolean
  /**
   * Devices that keep the system's SSH server for editor connections: those whose "Editor connections" switch was on
   * when the endpoint arrived, so an upgrade changes nothing for them. A device leaves the list when its switch is
   * turned off. Its presence (even empty) says the upgrade has been looked at.
   */
  editorSystemSshNodes?: NodeId[]
  /** What an add-on action changed outside Mousse, kept so it can be undone. Keyed by add-on. */
  addonRecords?: Record<string, { action: string; appliedAt: number; record: unknown }>
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
  /** What this computer lets each other device do here (`net_node_policy`). */
  policy: SqliteNodePolicy
  /** What other computers did on this one, and how much they read (`bridge_audit`). */
  audit: SqliteBridgeAudit
  /** What this computer remembers of its other computers' threads: row positions, openings, last lists. */
  remoteLists: SqliteRemoteLists
  rpc: DurableRpcDispatcher
  enrollment: EnrollmentService
  transfer: AuthorityTransferDelivery
}
/**
 * Display streams that one computer of the user reads and no other (see `bridge/remote/privateStreams.ts`).
 * The network layer asks which stream is one, and ends them when their reader may no longer have them.
 */
export interface PrivateStreamsControl {
  access(
    stream: StreamId
  ):
    { reader: NodeId; kind: 'thread' | 'lists' | 'channel' | 'terminal'; open: boolean } | undefined
  /** Stops serving private streams (of one reader, of one kind, or all); returns the ones that were open. */
  close(filter?: {
    reader?: NodeId
    kind?: 'thread' | 'lists' | 'channel' | 'terminal'
  }): StreamId[]
  /**
   * Lets go of everything held for computers that may no longer work on threads here: their private
   * streams, the results waiting to be fetched in pages and the values they staged. `granted` says
   * which computers may; with none, every computer is let go of (the owner switch is off).
   */
  release(granted?: (node: NodeId) => boolean): StreamId[]
}

export interface NetDomainComposition {
  store?: StreamStore
  authority?: StreamAuthority
  privateStreams?: PrivateStreamsControl
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
  /** A session ended (it may never have opened); the peer's other sessions, if any, are still in `session()`. */
  onSessionClosed?(session: SyncSession): void
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
  /** The WebRTC direct path for signed-in phones; created on the first offer. */
  private webrtc?: PhoneWebRtcAcceptor
  /** The relay's and STUN servers' addresses, which a phone candidate may never name. */
  private webrtcBlocked: ReadonlySet<string> = new Set()
  private webrtcBlockedFor = ''
  private stopped = false
  private disabled = false
  private disabling?: Promise<NetStatus>
  private lastError?: keyof typeof NET_ERRORS
  private renewal?: { cancel(): void }
  private rosterListener?: () => void
  private policyListener?: () => void
  private domain?: NetDomainComposition
  private presenceStore?: PeerPresence
  private presenceTimer?: { cancel(): void }
  /** How each session was carried, for the device list; only own-device sessions are recorded. */
  private readonly sessionLinks = new WeakMap<object, PeerLink>()
  private domainClosing?: Promise<void>
  private domainClosed = false
  private shutdownInFlight?: Promise<void>
  private shutdownComplete = false
  private sshBootstrap?: SshBootstrap
  private editorSshConfig?: EditorSshConfig
  /** The editor tunnels this computer carries for its other computers, and those it opened to them. */
  private tunnels?: EditorTunnels
  /** The tunnels `mousse-cli net ssh-proxy` holds on this computer's local connections. */
  private localTunnelStore?: LocalEditorTunnels
  private readonly editorFirstOpen = new Set<(node: NodeId) => void>()
  /** Loopback listeners that exist only while a remote machine joins; never persisted. */
  private readonly enrollmentListeners = new Set<DirectTransport>()
  /** The optional Mousse ID module; absent in builds and tests that leave it out. */
  private readonly hosted?: HostedNet
  constructor(
    private readonly options: {
      profileDir: string
      clock?: Clock
      onChanged?(status: NetStatus): void
      composeRuntime?(runtime: NetRuntime): NetDomainComposition | void
      hosted?: HostedNetModule
      /** Tests replace the `ssh` executable, the user's known_hosts file and the setup's inputs. */
      ssh?: { binary?: string; userKnownHosts?: string } & Partial<
        Omit<SshBootstrapOptions, 'binary' | 'userKnownHosts'>
      >
      /**
       * Where Mousse keeps the ssh settings it writes for editors, and the user's home directory for
       * the one line it adds to `~/.ssh/config`. Without it the feature is unavailable, so a service
       * built in a test never reaches the real home directory.
       */
      editorSsh?: EditorSshOptions
      /**
       * Tests point the far end of an editor tunnel at an echo server on loopback (it is this computer's own
       * SSH server otherwise), the host keys at a folder they made, and the limits at small numbers.
       */
      editorTunnel?: Pick<
        EditorTunnelOptions,
        'farEnd' | 'hostKeyDirectories' | 'hostTrust' | 'perNode' | 'total' | 'opensPerMinute'
      > & {
        /**
         * Tests give the SSH endpoint a host of their own (a throwaway home folder and account) in place of this
         * system's; `null` leaves it with none, as on a system the endpoint cannot run on.
         */
        endpointHost?: ProcessHost | null
        /** False: sessions do not offer `tunnel.v1`, like a build from before it (tests). */
        offer?: boolean
      }
      /** Tests replace the native WebRTC stack and this computer's addresses. */
      phoneWebRtc?: {
        factory?: PeerConnectionFactory
        hostAddresses?: () => ReadonlySet<string>
        ownAddresses?: () => ReadonlySet<string>
        gatherMs?: number
        ticketTtlMs?: number
      }
    }
  ) {
    this.clock = options.clock ?? systemClock
    this.hosted = options.hosted?.create(this.hostedHost())
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
      db.transaction(() => db.database.exec(PEER_PRESENCE_SCHEMA))
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
        if (cfg.workOnThreads !== undefined && typeof cfg.workOnThreads !== 'boolean')
          throw new NetError('storage_corrupt')
        if (cfg.editorSystemSsh !== undefined && typeof cfg.editorSystemSsh !== 'boolean')
          throw new NetError('storage_corrupt')
        if (
          cfg.editorSystemSshNodes !== undefined &&
          (!Array.isArray(cfg.editorSystemSshNodes) ||
            cfg.editorSystemSshNodes.length > 1024 ||
            cfg.editorSystemSshNodes.some((node) => !isId('node', node)))
        )
          throw new NetError('storage_corrupt')
        if (
          cfg.addonRecords !== undefined &&
          (!cfg.addonRecords ||
            typeof cfg.addonRecords !== 'object' ||
            Array.isArray(cfg.addonRecords) ||
            Object.entries(cfg.addonRecords).length > 8 ||
            Object.values(cfg.addonRecords).some(
              (row) =>
                !row ||
                typeof row.action !== 'string' ||
                !Number.isSafeInteger(row.appliedAt) ||
                row.appliedAt < 0
            ))
        )
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
            // Without Mousse ID a stored hosted relay row is kept as is and never started.
            cfg.transports = cfg.transports.map((row) =>
              row.id === HOSTED_RELAY_TRANSPORT && !this.hosted ? row : validator.validate(row)
            )
          } catch {
            throw new NetError('storage_corrupt')
          }
        }
        if (
          cfg.features !== undefined &&
          (!cfg.features ||
            typeof cfg.features.netBridge !== 'boolean' ||
            typeof cfg.features.netSpaces !== 'boolean' ||
            (cfg.features.netBridgeThreads !== undefined &&
              typeof cfg.features.netBridgeThreads !== 'boolean') ||
            Object.keys(cfg.features).some(
              (key) => !['netBridge', 'netSpaces', 'netBridgeThreads'].includes(key)
            ))
        ) {
          throw new NetError('storage_corrupt')
        }
        // Pre-rollout profiles require fresh explicit opt-in; never grandfather undefined flags.
        cfg.features ??= { ...DEFAULT_NET_FEATURE_FLAGS }
        // The flag is stored only while it is off (see `saveConfig`), so a profile without it has the default: on.
        cfg.features.netBridgeThreads ??= DEFAULT_NET_FEATURE_FLAGS.netBridgeThreads
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
      const policy = new SqliteNodePolicy(db, this.clock)
      const rpc = new DurableRpcDispatcher({
          db,
          identity,
          executions,
          clock: this.clock,
          authorizeMethod: (method, peer) => {
            this.assertEnabled()
            if (method.family === 'bridge' || method.family === 'routed')
              this.assertFeature('netBridge')
            else if (method.family === 'spaces') this.assertFeature('netSpaces')
            // Read on every call, so a block takes effect on the device's next request, and
            // on the lookup of a result it asked for earlier.
            if (
              (method.family === 'bridge' || method.family === 'routed') &&
              policy.isBlocked(peer.node)
            )
              throw new NetError(
                'forbidden',
                undefined,
                method.family === 'routed' ? { details: { reason: 'blocked' } } : undefined
              )
            if (method.family === 'routed') {
              // The owner's switch is read on every call, so turning it off is also a kill switch.
              if (this.config.workOnThreads === false)
                throw new NetError('forbidden', undefined, { details: { reason: 'setting_off' } })
              if (method.needsTerminal && !policy.get(peer.node).terminal)
                throw new NetError('forbidden', undefined, { details: { reason: 'terminal_off' } })
            }
          }
        }),
        transfer = new AuthorityTransferDelivery({ db, identity, keys })
      transfer.register(rpc)
      rpc.register({
        method: PHONE_ENDPOINTS_METHOD,
        capability: 'read',
        mutating: false,
        ephemeral: true,
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
        // These carry no family, so the block is checked here: a blocked phone gets no endpoints.
        authorize: (_params, context) => {
          if (policy.isBlocked(context.caller.node)) throw new NetError('forbidden')
        },
        handle: async (_params, context) => this.phoneEndpoints(context.carrier)
      })
      rpc.register({
        method: PHONE_WEBRTC_OFFER_METHOD,
        capability: 'read',
        // Never persisted: every offer is a fresh PeerConnection, and a stored answer would keep
        // addresses and ICE credentials on disk and replay them on retry.
        mutating: false,
        ephemeral: true,
        validate: (params) => {
          const value = params as { sdp?: unknown; v?: unknown }
          if (
            !params ||
            typeof params !== 'object' ||
            Array.isArray(params) ||
            Object.keys(params).length !== 2 ||
            value.v !== 1 ||
            typeof value.sdp !== 'string' ||
            value.sdp.length > WEBRTC_SDP_MAX_BYTES
          )
            throw new NetError('bad_request')
          return { sdp: value.sdp, v: 1 }
        },
        authorize: (_params, context) => {
          if (policy.isBlocked(context.caller.node)) throw new NetError('forbidden')
        },
        handle: async (params, context) =>
          this.phoneWebRtcOffer((params as { sdp: string }).sdp, context.carrier, context.caller)
      })
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
            protected: keys.protectedAtRest(),
            unlocked: keys.state() === 'unlocked',
            node: identity.self()?.node
          }
        }
      })
      // What this device tells its peers about itself; read-only, never journaled. A device
      // from before this existed answers `forbidden`, which the device list reads as "older".
      rpc.register({
        method: 'net.info',
        capability: 'read',
        mutating: false,
        ephemeral: true,
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
        handle: async () => ({
          v: 1,
          version: mousseVersion(),
          platform: process.platform,
          arch: process.arch,
          protoMinor: NET_PROTO_MINOR,
          // The version of each routed method this computer accepts, so a caller sends only keys it knows
          // and says "update Mousse" for the one action that needs more. Absent: an older computer.
          routed: routedVersions()
        })
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
        policy,
        audit: new SqliteBridgeAudit(db, this.clock),
        remoteLists: new SqliteRemoteLists(db, this.clock),
        rpc
      }
      // Before the endpoint, an editor connection ended at the system's SSH server. A device that already has the switch
      // on keeps that server, so the upgrade changes neither what it reaches nor how it signs in; every other device
      // gets the endpoint. (Looked at once: the list is stored.)
      if (this.config.editorSystemSshNodes === undefined) {
        this.config = {
          ...this.config,
          editorSystemSshNodes: policy
            .list()
            .filter((row) => row.editor)
            .map((row) => row.node)
        }
        this.saveConfig()
      }
      const { offer: _offer, endpointHost, ...tunnelOptions } = this.options.editorTunnel ?? {}
      // Mousse answers editor connections itself, unless a test gave the tunnels an SSH server of their own to end at.
      const endpoint: EditorEndpointPort | undefined =
        (tunnelOptions.farEnd || tunnelOptions.hostKeyDirectories) && endpointHost === undefined
          ? undefined
          : new EditorEndpoint({
              keys,
              host:
                endpointHost === undefined
                  ? systemProcessHost(
                      process.platform,
                      findSshdHelper,
                      join(this.options.profileDir, 'editor-ssh')
                    )
                  : (endpointHost ?? undefined),
              onEvent: (event) => this.tunnels?.recordEndpointEvent(event)
            })
      this.tunnels = new EditorTunnels({
        clock: this.clock,
        audit: this.state.audit,
        refusal: (link) => this.tunnelRefusal(link),
        allowedDevices: () => this.allowedEditorDevices(),
        useSystemSsh: (node) =>
          this.config.editorSystemSsh === true ||
          this.config.editorSystemSshNodes?.includes(node) === true,
        ...(endpoint ? { endpoint } : {}),
        transportOf: (link) => this.sessionLinks.get(link)?.transport,
        onFirstOpen: (node) => {
          for (const listener of this.editorFirstOpen) {
            try {
              listener(node)
            } catch {
              // A notice that cannot be shown never stops a tunnel.
            }
          }
        },
        ...tunnelOptions
      })
      // A block ends what the device is doing here now, not only what it asks for next.
      this.policyListener = policy.onChange((event) => {
        // An editor tunnel is shell access: a block, or its switch going off, ends the device's tunnels now. This
        // comes first, and cannot throw, so nothing below it that fails can leave a tunnel standing.
        this.tunnels?.reconcile()
        // A device that turns its switch off and on again is given a new grant, and the new grant is the endpoint's.
        if (
          event.before.editor &&
          !event.after.editor &&
          this.config.editorSystemSshNodes?.includes(event.node)
        ) {
          this.config = {
            ...this.config,
            editorSystemSshNodes: this.config.editorSystemSshNodes.filter(
              (node) => node !== event.node
            )
          }
          this.saveConfig()
        }
        if (event.after.blocked && !event.before.blocked) this.endBlockedNode(event.node)
        // Terminal output is for a device whose terminal switch is on; switching it off ends the stream at once.
        else if (event.before.terminal && !event.after.terminal)
          this.endPrivateServing(
            this.domain?.privateStreams?.close({ reader: event.node, kind: 'terminal' }) ?? []
          )
      })
      this.domain = this.options.composeRuntime?.(this.state) ?? undefined
      this.rosterListener = identity.onRosterChanged((user) => {
        // A computer that lost "Works on threads" (or was revoked) keeps no editor tunnel either.
        this.tunnels?.reconcile()
        // A computer that lost "Works on threads" (or was revoked) keeps nothing open for it, as a block does.
        this.endPrivateServing(
          this.domain?.privateStreams?.release((node) => {
            try {
              return this.currentNode(node).caps.includes('settings')
            } catch {
              return false
            }
          }) ?? []
        )
        this.emit()
        if (this.routes) this.refreshPeers()
        this.closeRevokedWebRtc()
        // Mousse ID admits relay connections against the roster it last received.
        if (user === identity.self()?.user) this.hosted?.rosterChanged()
      })
      // Once when Net starts: whatever an earlier run of the daemon left running for a device that has no right now.
      void this.tunnels.sweepStrays()
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
    const { db } = this.runtime()
    // An earlier version rejects any other key in `features` as corrupt storage and then fails to load Net
    // at all. The routing flag is on by default, so it is written only while it is off: a profile that
    // never turned it off can go back to an earlier build.
    const { features, ...rest } = this.config
    const stored: NetConfiguration = features
      ? {
          ...rest,
          features: features.netBridgeThreads
            ? ({ netBridge: features.netBridge, netSpaces: features.netSpaces } as NetFeatureFlags)
            : features
        }
      : rest
    const bytes = canonicalJson(stored)
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
    await this.bootstrap()
      .start()
      .catch(() => {})
    try {
      this.runtime()
      if (this.config.enabled) await this.activateWithHosted()
    } catch (error) {
      this.lastError = error instanceof NetError ? error.code : 'internal'
      this.emit()
    }
    // Written again at every start, so a launcher that moved with an update is found.
    this.syncEditorSsh()
  }
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown> {
    if (this.stopped) throw new NetError('cancelled')
    if (method === 'net.status') return this.status()
    if (method === 'net.plus.status') return this.hosted?.status() ?? hostedNotConfigured()
    if (method === 'net.disable') return this.disable()
    // What an add-on changed outside Mousse can always be seen and undone, also while networking is off.
    if (method === 'net.transport.action.undo') return this.undoAddon(params)
    // The line in ~/.ssh/config can be seen and removed in the same way.
    if (method.startsWith('net.editor.ssh.') || method === 'net.editor.alias')
      return this.track(this.editorSshRequest(method))
    if (method === 'net.transport.list' && (this.disabled || !this.config.enabled))
      return this.transportList()
    if (this.disabled) throw new NetError('disabled')
    if (!['net.init', 'bridge.join'].includes(method)) this.assertEnabled()
    if (method.startsWith('bridge.') && method !== 'bridge.join') this.assertFeature('netBridge')
    if (method === 'net.doctor') return this.doctor()
    if (method === 'net.transport.list') return this.transportList()
    if (method === 'net.transport.action.describe') {
      this.requireEnrolled()
      const { id, action, settings, context } = this.addonAction(params)
      return this.addonResult(() =>
        this.exclusiveAddon(id, async () => ({
          ok: true,
          changes: (await action.describe(settings, context)).changes
        }))
      )
    }
    // Outside the serial queue: the external change can take a while, and it touches no other
    // network setting. One change per add-on at a time instead.
    if (method === 'net.transport.action.apply') {
      this.requireEnrolled()
      const { id, name, action, settings, context } = this.addonAction(params)
      return this.addonResult(() =>
        this.exclusiveAddon(id, async () => {
          const { record } = await action.apply(settings, context)
          this.config.addonRecords = {
            ...this.config.addonRecords,
            [id]: { action: name, appliedAt: this.clock.now(), record }
          }
          this.saveConfig()
          await this.refreshAddon(id)
          this.emit()
          return { ok: true }
        })
      )
    }
    if (method === 'bridge.nodes') return this.nodesView()
    if (method === 'net.editor.probe') return this.track(this.editorProbe(params.node as NodeId))
    if (method.startsWith('net.ssh.')) return this.track(this.sshRequest(method, params))
    if (method.startsWith('net.plus.') && !this.hosted) throw hostedUnavailable()
    if (method === 'net.plus.login.cancel') return this.hosted!.cancelLogin()
    if (method === 'net.plus.enrollment.requests') return this.hosted!.enrollmentRequests()
    if (method === 'net.authority.status') {
      const journal = this.requireEnrolled().identity.authorityTransferState()
      return journal
        ? { phase: journal.phase, ...this.runtime().transfer.query() }
        : { phase: 'none' }
    }
    return this.serial(async () => {
      if (method.startsWith('net.plus.')) return this.hosted!.request(method, params)
      switch (method) {
        case 'net.transport.configure': {
          const rt = this.requireEnrolled()
          // Switching off without settings keeps the saved ones (endpoint, port, binary), so an
          // add-on that failed to start can be turned off from a screen that has no form state.
          const saved = this.transportConfigurations().find((row) => row.id === params.id)
          if (params.settings === undefined && (params.enabled !== false || !saved))
            throw new NetError('bad_request')
          const checked = this.createTransports().validate({
            id: params.id as string,
            enabled: params.enabled as boolean,
            settings: params.settings === undefined ? saved!.settings : params.settings
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
          if (this.config.enabled) await this.activateWithHosted()
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
          if (this.config.enabled) await this.activateWithHosted()
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
          // The device kind is recorded only when a Mousse ID request is approved, never on request.
          const { kind: _kind, ...rest } = params
          // An invite made here is for another computer, and is recorded as one; a phone joins
          // through Mousse ID, where its kind is known, and never gets `settings`.
          const input = {
            ...rest,
            kind: 'computer' as const,
            caps: (rest.caps as NodeCapability[] | undefined) ?? [...COMPUTER_NODE_CAPABILITIES]
          }
          const invite = this.transport?.hasRelayListener()
            ? await this.issueRendezvousInvite(input)
            : runtime.enrollment.issueNodeInvite(input)
          return { invite: invite.text, inviteId: invite.invite, expiresAt: invite.expiresAt }
        }
        case 'net.routes': {
          this.requireEnrolled()
          if (!this.routes) await this.activate()
          const signed = this.signedRoutes()
          return {
            signed,
            routes: (parseProtocolJson(Buffer.from(signed.payload, 'base64url')) as RoutesRecord)
              .routes
          }
        }
        case 'bridge.join':
          return this.join(
            String(params.invite),
            params.name as string | undefined,
            params.passphrase as string | undefined,
            params.via as string | undefined
          )
        case 'bridge.revoke': {
          const rt = this.requireEnrolled(),
            node = params.node as NodeId
          // Open sessions with the node send it the new roster and then close themselves;
          // the roster change also sends the roster to Mousse ID.
          rt.identity.revoke(node)
          this.closeHandshakingSessions(node)
          this.emit()
          return { ok: true }
        }
        case 'bridge.rename': {
          const rt = this.requireEnrolled()
          rt.identity.renameNode(params.node as NodeId, String(params.name))
          return { ok: true }
        }
        case 'bridge.setCaps': {
          const rt = this.requireEnrolled(),
            node = params.node as NodeId,
            caps = params.caps as NodeCapability[]
          // The thread grant goes to a device this authority knows is a computer, and to nothing
          // else: a phone, and a device whose kind was never recorded, are refused.
          if (
            caps.includes('settings') &&
            node !== rt.identity.self()!.node &&
            rt.enrollment.nodeKind(node) !== 'computer'
          )
            throw new NetError(
              'forbidden',
              'Only a device known to be a computer can work on threads.'
            )
          rt.identity.setNodeCaps(node, caps)
          this.emit()
          return { ok: true }
        }
        case 'bridge.setKind': {
          const rt = this.requireEnrolled(),
            node = params.node as NodeId,
            kind = params.kind as 'computer' | 'phone'
          if (!rt.identity.self()!.isAuthority) throw new NetError('forbidden')
          if (node === rt.identity.self()!.node) throw new NetError('bad_request')
          try {
            this.currentNode(node)
          } catch {
            throw new NetError('bad_request', 'Unknown device.')
          }
          rt.enrollment.recordNodeKind(node, kind)
          // A device said to be a phone keeps no thread grant it may have been given.
          if (kind === 'phone') {
            const held = this.nodes() as { nodes: Array<{ node: NodeId; caps: NodeCapability[] }> }
            const caps = held.nodes.find((row) => row.node === node)?.caps ?? []
            if (caps.includes('settings'))
              rt.identity.setNodeCaps(
                node,
                caps.filter((cap) => cap !== 'settings')
              )
          }
          this.emit()
          return { ok: true }
        }
        case 'bridge.policy': {
          const rt = this.requireEnrolled(),
            node = params.node as NodeId
          if (node === rt.identity.self()!.node) throw new NetError('bad_request')
          // Only a device on the roster; a revoked or unknown id has nothing to limit.
          try {
            this.currentNode(node)
          } catch {
            throw new NetError('bad_request', 'Unknown device.')
          }
          const policy = rt.policy.set(node, {
            ...(params.blocked === undefined ? {} : { blocked: params.blocked as boolean }),
            ...(params.maxPermissionMode === undefined
              ? {}
              : { maxPermissionMode: params.maxPermissionMode as PermissionMode }),
            ...(params.terminal === undefined ? {} : { terminal: params.terminal as boolean }),
            ...(params.editor === undefined ? {} : { editor: params.editor as boolean })
          })
          this.emit()
          return { policy: policyView(policy) }
        }
        case 'bridge.workOnThreads': {
          // "Let my other computers work on this computer's threads". Any computer sets it for itself; it
          // takes effect on the next routed call, so turning it off is also the kill switch.
          this.requireEnrolled()
          if (params.enabled !== undefined) {
            const was = this.config.workOnThreads !== false
            this.config = { ...this.config, workOnThreads: params.enabled === true }
            this.saveConfig()
            // Off ends the private streams that are open, not only the next call.
            if (was && params.enabled !== true) {
              this.endPrivateServing(this.domain?.privateStreams?.release() ?? [])
              // ...and the editor tunnels, which are shell access on this computer.
              this.tunnels?.reconcile()
            }
            this.emit()
          }
          return { enabled: this.config.workOnThreads !== false }
        }
        case 'bridge.editorServer': {
          // "Use this computer's SSH server" for editor connections from other computers. Any computer sets it
          // for itself. It applies to the next tunnel: one that is open keeps the server it was opened to.
          this.requireEnrolled()
          if (params.system !== undefined) {
            const { editorSystemSsh: _was, ...rest } = this.config
            // Written only while it is on, so an earlier version of Mousse still reads the profile.
            this.config = params.system === true ? { ...rest, editorSystemSsh: true } : rest
            this.saveConfig()
            this.emit()
          }
          return this.editorServerView()
        }
        default:
          throw new NetError('bad_request')
      }
    })
  }
  /** Which SSH server answers editor connections from other computers, and whether Mousse's own can. */
  private editorServerView(): { system: boolean; available: boolean } {
    return {
      system: this.config.editorSystemSsh === true,
      available: this.tunnels?.endpointAvailable() === true
    }
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
    // With no keys yet, the passphrase protects the new ones; otherwise it unlocks the existing ones.
    const creating = rt.keys.state() === 'missing'
    if (input.passphrase !== undefined && !creating) await rt.keys.unlock(input.passphrase)
    if (!rt.identity.self() && this.config.preparedForJoin) throw new NetError('conflict')
    if (!rt.identity.self())
      await rt.identity.bootstrapAuthority(input.name ?? 'My device', creating ? input.passphrase : undefined)
    this.assertInstanceOpen()
    this.config.enabled = true
    this.config.features = {
      netBridge: true,
      netSpaces: true,
      netBridgeThreads: this.config.features?.netBridgeThreads !== false
    }
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
  /**
   * Loopback ports this profile's net transports listen on or are set to forward to (the direct listener and the
   * add-on transports), once the saved configuration has been loaded. Another listener must not take one: a
   * forward set up for the net service would reach it.
   */
  localPorts(): number[] {
    if (!this.state) return []
    return this.transportConfigurations()
      .map((row) => (row.settings as { port?: unknown } | undefined)?.port)
      .filter(
        (port): port is number => typeof port === 'number' && Number.isInteger(port) && port > 0
      )
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
  /** Starts the transports, with the Mousse ID lease renewed first and kept current after. */
  private async activateWithHosted(): Promise<void> {
    await this.hosted?.recoverLease()
    await this.activate()
    this.hosted?.resumeRenewal()
  }
  hostedSpaceMembershipChanged(): void {
    this.hosted?.membershipChanged()
  }
  /** What the Mousse ID module may use. Each entry keeps NetService's own gates and queue. */
  private hostedHost(): HostedNetHost {
    return {
      clock: this.clock,
      signal: this.shutdownSignal.signal,
      loadedRuntime: () => this.state,
      requireEnrolled: () => this.requireEnrolled(),
      closed: () => this.stopped || this.disabled,
      enabled: () => this.config.enabled,
      featureEnabled: (feature) => this.featureEnabled(feature),
      hostedSpacePeerAuthorized: (user, node) =>
        this.domain?.hostedSpacePeerAuthorized?.(user, node) === true,
      serial: (work) => this.serial(work),
      emit: () => this.emit(),
      fail: (error) => {
        this.lastError = error instanceof NetError ? error.code : 'internal'
      },
      transportRows: () => this.config.transports ?? [],
      validateTransport: (row) => this.createTransports().validate(row),
      saveHostedTransport: (row) => {
        this.config.transports = [
          ...(this.config.transports ?? []).filter((item) => item.id !== HOSTED_RELAY_TRANSPORT),
          ...(row ? [row] : [])
        ]
        this.saveConfig()
      },
      activate: () => this.activate(),
      restartTransports: async () => {
        await this.transport?.teardown()
        this.transport = undefined
        this.syncPhoneWebRtc()
        await this.activate()
      },
      reactivateIfRunning: async () => {
        if (this.transport) await this.activate()
      },
      suspendHostedTransport: async () => {
        await this.transport?.suspendHosted()
      },
      hostedListening: () => this.transport?.hasPlusRelayListener() === true,
      directPathChanged: () => this.syncPhoneWebRtc(),
      relayIdentity: () => this.relayIdentity(),
      issueRendezvousInvite: (input) => this.issueRendezvousInvite(input),
      revokeUnsentInvite: (invite, error) => this.revokeUnsentInvite(invite, error)
    }
  }
  /** Invites that a phone redeems over a relay rendezvous; the only route a phone can dial. */
  private async issueRendezvousInvite(
    input: NodeInviteInput
  ): Promise<{ text: string; invite: InviteId; expiresAt: number }> {
    const runtime = this.requireEnrolled()
    if (!this.routes) await this.activate()
    if (!this.transport?.hasRelayListener()) throw new NetError('route_unreachable')
    return runtime.enrollment.issueNodeInviteWithRendezvous(input, async (expiresAt) => {
      const value = await this.transport!.prepareEnrollmentRendezvous(expiresAt)
      if (!value) throw new NetError('route_unreachable')
      return value
    })
  }
  /** An invite whose sealed copy never reached Mousse ID cannot be redeemed by anyone; drop it. */
  private revokeUnsentInvite(invite: InviteId, error: unknown): void {
    if (error instanceof NetError && error.code === 'outcome_uncertain') return
    try {
      this.requireEnrolled().enrollment.revokeInvite(invite)
    } catch {
      // The invite still expires on its own.
    }
  }
  private createTransports(): ProfileTransports {
    return new ProfileTransports({
      clock: this.clock,
      profileDir: this.options.profileDir,
      hosted: this.hosted?.transports,
      identity: () => this.relayIdentity(),
      addonRecords: this.addonRecords()
    })
  }
  private addonRecords(): AddonRecordStore {
    return {
      get: (id) => this.config.addonRecords?.[id]?.record,
      remember: (id, record) => this.rememberAddon(id, record),
      forget: (id) => this.forgetAddon(id)
    }
  }
  /** Saves the record of an add-on that already has one (an action adds the first one itself). */
  private rememberAddon(id: string, record: unknown, action?: string): void {
    const row = this.config.addonRecords?.[id]
    const name = action ?? row?.action
    if (!name) return
    this.config.addonRecords = {
      ...this.config.addonRecords,
      [id]: { action: name, appliedAt: row?.appliedAt ?? this.clock.now(), record }
    }
    this.saveConfig()
  }
  private forgetAddon(id: string): void {
    if (!this.config.addonRecords?.[id]) return
    const { [id]: _removed, ...rest } = this.config.addonRecords
    if (Object.keys(rest).length) this.config.addonRecords = rest
    else delete this.config.addonRecords
    this.saveConfig()
  }
  private transportList() {
    return {
      manifests: this.createTransports().manifests(),
      transports: this.status().transports ?? [],
      // The saved add-on rows, so a setup can record what it replaced and undo can restore it.
      saved: this.transportConfigurations().filter((row) => row.id !== HOSTED_RELAY_TRANSPORT),
      records: structuredClone(this.config.addonRecords ?? {}) satisfies NetAddonRecords,
      settings: Object.fromEntries(
        this.transportConfigurations().map((row) => [row.id, row.settings])
      )
    }
  }
  private readonly addonBusy = new Set<string>()
  /** One change to an add-on at a time. */
  private async exclusiveAddon<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.addonBusy.has(id))
      throw new NetError('conflict', 'Another change to this add-on is still running.')
    this.addonBusy.add(id)
    try {
      return await work()
    } finally {
      this.addonBusy.delete(id)
    }
  }
  private async refreshAddon(id: string): Promise<void> {
    try {
      await this.transport?.refresh(id)
    } catch {
      // The status keeps showing what the add-on last knew.
    }
  }
  private undoAddon(params: Record<string, unknown>): Promise<NetAddonActionResult> {
    const { id, name, action, settings, context } = this.addonAction(params)
    return this.addonResult(() =>
      this.exclusiveAddon(id, async () => {
        const recorded = this.config.addonRecords?.[id]
        // Nothing recorded means nothing of Mousse's to undo.
        if (recorded?.action !== name)
          return {
            ok: true,
            outcome: 'already-removed',
            message: 'Nothing was recorded, so there was nothing to undo.'
          }
        // A refusal or an unreadable answer throws, and the record stays.
        const result = await action.undo(recorded.record, settings, context)
        this.forgetAddon(id)
        await this.refreshAddon(id)
        this.emit()
        return { ok: true, ...result }
      })
    )
  }
  /** Looks up an add-on action and the settings it works with (the stored ones when none are given). */
  private addonAction(params: Record<string, unknown>) {
    const id = params.id as string,
      name = params.action as string,
      transports = this.createTransports(),
      action = transports.action(id, name)
    if (!action) throw new NetError('bad_request', 'Unknown add-on action.')
    const settings =
      params.settings ?? this.transportConfigurations().find((row) => row.id === id)?.settings ?? {}
    transports.validate({ id, enabled: true, settings })
    return {
      id,
      name,
      action,
      settings,
      context: {
        clock: this.clock,
        profileDir: this.options.profileDir,
        record: () => this.config.addonRecords?.[id]?.record,
        remember: (record: unknown) => this.rememberAddon(id, record, name),
        forget: () => this.forgetAddon(id),
        listening: (port: number) => this.transport?.holdsLoopback(id, port) ?? false
      }
    }
  }
  /** A refusal from the add-on is a result the dialog can show; anything else is a real failure. */
  private async addonResult(
    work: () => Promise<NetAddonActionResult>
  ): Promise<NetAddonActionResult> {
    try {
      return await work()
    } catch (error) {
      if (!(error instanceof NetError)) throw error
      const remedy = (error.details as { remedy?: unknown } | undefined)?.remedy
      return {
        ok: false,
        code: error.code,
        message: error.message,
        ...(typeof remedy === 'string' ? { remedy } : {})
      }
    }
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
      hosted: this.hosted?.transports,
      ssh: this.options.ssh,
      relayRendezvous:
        rt.enrollment.preparedNodeJoin()?.rendezvous?.transport === HOSTED_RELAY_TRANSPORT &&
        !this.hosted?.connected()
          ? rt.enrollment.preparedNodeJoin()!.rendezvous
          : undefined,
      identity: () => this.relayIdentity(),
      addonRecords: this.addonRecords(),
      onChanged: () => {
        if (this.stopped || this.disabled || !this.config.enabled || !this.routes) return
        try {
          this.localSignedRoutes = undefined
          this.signedRoutes()
          this.syncPhoneWebRtc()
          this.emit()
        } catch (error) {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        }
      }
    }))
    await transport.start(
      this.transportConfigurations().flatMap((row) =>
        row.id !== HOSTED_RELAY_TRANSPORT
          ? [row]
          : !this.hosted
            ? []
            : this.hosted.consentFenced()
              ? [{ ...row, enabled: false }]
              : [row]
      ),
      (raw, info, deadline) => {
        if (this.stopped || this.disabled || !this.config.enabled) {
          raw.destroy()
          return
        }
        this.track(this.accept(raw, deadline, info.transport)).catch((error) => {
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
    this.syncPhoneWebRtc()
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
  /**
   * The WebRTC direct path is offered exactly while this computer is signed in to Mousse ID and
   * holds a relay lease (the hosted relay listener is up), unless Mousse ID configuration turns
   * it off. Nothing in settings shows or controls it.
   */
  private webrtcWanted(): boolean {
    try {
      return (
        !!this.hosted &&
        !this.stopped &&
        !this.disabled &&
        this.config.enabled &&
        this.featureEnabled('netBridge') &&
        this.state?.keys.state() === 'unlocked' &&
        this.transport?.hasPlusRelayListener() === true &&
        this.hosted.directPath?.().webrtc !== false
      )
    } catch {
      return false
    }
  }
  /** Closes every WebRTC ticket and connection when the path is no longer wanted. */
  private syncPhoneWebRtc(): void {
    if (!this.webrtcWanted()) {
      this.webrtc?.closeAll()
      return
    }
    this.refreshWebRtcBlocked()
  }
  /** Resolves the relay and STUN host names, best effort, when they change. */
  private refreshWebRtcBlocked(): void {
    const hosts = new Set<string>()
    for (const server of this.hosted?.directPath?.().stun ?? []) {
      const host = server
        .replace(/^stuns?:/, '')
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
      if (host) hosts.add(host)
    }
    for (const route of this.transport?.statuses().find((row) => row.id === HOSTED_RELAY_TRANSPORT)
      ?.routes ?? [])
      try {
        hosts.add(new URL(route.address).hostname.replace(/^\[|\]$/g, ''))
      } catch {
        // Not a URL; nothing to resolve.
      }
    const key = [...hosts].sort().join(' ')
    if (key === this.webrtcBlockedFor) return
    this.webrtcBlockedFor = key
    void Promise.all(
      [...hosts].map((host) =>
        classifyAddress(host) || host.includes(':') || /^[\d.]+$/.test(host)
          ? Promise.resolve([host])
          : lookup(host, { all: true }).then(
              (rows) => rows.map((row) => row.address),
              () => []
            )
      )
    ).then((lists) => {
      if (this.webrtcBlockedFor === key)
        this.webrtcBlocked = new Set(lists.flat().map((address) => normalizeAddress(address)))
    })
  }
  /** Open WebRTC tickets: pending ones and those with an authenticated session. */
  phoneWebRtcCounts(): { pending: number; live: number } {
    return this.webrtc?.counts() ?? { pending: 0, live: 0 }
  }
  /**
   * What a phone learns about direct paths, only over a session that came through Mousse ID
   * (the hosted relay, or the WebRTC path itself). Everyone else learns nothing.
   */
  private phoneEndpoints(carrier: string | undefined): {
    endpoints: []
    webrtc?: { v: 1 }
  } {
    if (carrier !== HOSTED_RELAY_TRANSPORT && carrier !== PHONE_WEBRTC_TRANSPORT)
      return { endpoints: [] }
    return this.webrtcWanted() ? { endpoints: [], webrtc: { v: 1 } } : { endpoints: [] }
  }
  private async phoneWebRtcOffer(
    sdp: string,
    carrier: string | undefined,
    caller: SyncSession['peer']
  ): Promise<{ sdp: string }> {
    if (carrier !== HOSTED_RELAY_TRANSPORT && carrier !== PHONE_WEBRTC_TRANSPORT)
      throw new NetError('forbidden')
    if (!this.webrtcWanted()) throw new NetError('disabled')
    const self = this.requireEnrolled().identity.self()!
    if (caller.user !== self.user || caller.node === self.node) throw new NetError('forbidden')
    return this.phoneWebRtc().offer({ node: caller.node, user: caller.user }, sdp)
  }
  private phoneWebRtc(): PhoneWebRtcAcceptor {
    const options = this.options.phoneWebRtc
    return (this.webrtc ??= new PhoneWebRtcAcceptor({
      clock: this.clock,
      factory: options?.factory ?? nodeDataChannelFactory(),
      iceServers: () => this.hosted?.directPath?.().stun ?? [],
      blockedAddresses: () => this.webrtcBlocked,
      ...(options?.hostAddresses ? { hostAddresses: options.hostAddresses } : {}),
      ...(options?.ownAddresses ? { ownAddresses: options.ownAddresses } : {}),
      ...(options?.gatherMs !== undefined ? { gatherMs: options.gatherMs } : {}),
      ...(options?.ticketTtlMs !== undefined ? { ticketTtlMs: options.ticketTtlMs } : {}),
      onChannel: (accepted) => {
        if (!this.webrtcWanted() || !this.transport) {
          accepted.raw.destroy()
          return
        }
        // The preauth deadline starts when the DataChannel opens, not at offer time.
        const deadline = this.transport.admission.reserve(
          accepted.raw,
          `webrtc:${accepted.ticket.node}`
        )
        if (deadline === undefined) {
          accepted.raw.destroy()
          return
        }
        this.track(this.acceptPhone(accepted, deadline)).catch(() => {})
      }
    }))
  }
  /** Closes the WebRTC tickets and connections of nodes the roster no longer admits. */
  private closeRevokedWebRtc(): void {
    const webrtc = this.webrtc
    if (!webrtc) return
    for (const node of webrtc.nodes()) if (!this.nodeAdmitted(node)) webrtc.closeNode(node)
  }
  /** The node holds a current, unrevoked delegation in this user's roster. */
  private nodeAdmitted(node: NodeId): boolean {
    try {
      const rt = this.state,
        self = rt?.identity.self()
      if (!rt || !self) return false
      const signed = rt.identity.roster(),
        root = rt.identity.pinnedRootKey(self.user)
      if (!signed || !root) return false
      const roster = rt.identity.verifySigned<Roster>(signed, root)
      let epoch = -1
      for (const row of roster.nodes) {
        const delegation = rt.identity.verifySigned<NodeDelegation>(row, roster.rootKey)
        if (delegation.subject === node) epoch = Math.max(epoch, delegation.keyEpoch)
      }
      return (
        epoch >= 0 &&
        !roster.revoked.some((row) => row.subject === node && row.throughKeyEpoch >= epoch)
      )
    } catch {
      return false
    }
  }
  /**
   * A DataChannel that opened for a WebRTC ticket: the same pinned TLS and session checks as
   * the relay (roster, delegation, revocation), only for the user's own nodes, and only for the
   * node the ticket was issued to. It never enrolls or joins Spaces.
   */
  private async acceptPhone(accepted: AcceptedWebRtc, deadline: number): Promise<void> {
    const raw = accepted.raw
    try {
      this.assertEnabled()
      const rt = this.requireEnrolled()
      const remaining = Math.floor(deadline - this.clock.monotonic())
      if (remaining <= 0 || raw.destroyed) throw new NetError('deadline_exceeded')
      const channel = await openSecureChannel(raw, {
        role: 'server',
        credentials: rt.keys.tlsCredentials(),
        deadlineMs: Math.min(DIAL_TLS_DEADLINE_MS, remaining),
        signal: this.shutdownSignal.signal
      })
      raw.secured()
      try {
        const session = this.makeSession(channel, undefined, undefined, raw, {
          carrier: PHONE_WEBRTC_TRANSPORT,
          sameUserOnly: true,
          node: accepted.ticket.node,
          onAuthenticated: () => accepted.authenticated()
        })
        session.onClosed(() => raw.destroy())
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
  private async accept(raw: Duplex, deadline: number, carrier?: string): Promise<void> {
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
                  await this.hosted?.spaceJoined(request.node, request.user)
                  return response
                }
              }
            : undefined,
          onEnrolled: () => this.markAuthenticated(raw),
          normalSession: (secure, mux, context) =>
            this.makeSession(secure, mux, context, raw, { carrier })
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
    raw?: Duplex,
    inbound?: {
      carrier?: string
      sameUserOnly?: boolean
      /** The only node this connection may authenticate as (a WebRTC ticket's node). */
      node?: NodeId
      onAuthenticated?: () => void
    }
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
    // A device this computer blocked reads, fetches and writes none of its Bridge streams.
    const blockedFor = (stream: StreamId, peer: { node: NodeId }): boolean =>
      !store.getStream(stream)?.kind.startsWith('space.') && rt.policy.isBlocked(peer.node)
    // A private stream is read by its computer only, while the owner's switch for other computers is on
    // (read on every record, so turning it off is also a kill switch) and, for a terminal, the device's
    // terminal switch is on. The authority checks the reader and "Works on threads".
    const privateReadable = (stream: StreamId, peer: { node: NodeId }): boolean => {
      const access = this.domain?.privateStreams?.access(stream)
      if (!access) return true
      if (this.config.workOnThreads === false) return false
      return access.kind !== 'terminal' || rt.policy.get(peer.node).terminal
    }
    // Sessions offer editor tunnels, unless a test stands in for a build from before them.
    const offered = this.options.editorTunnel?.offer !== false
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
      // Editor tunnels (`tunnel.v1`). A domain that lists its capabilities gets this one added to the list.
      ...(offered ? { tunnels: this.tunnels } : {}),
      ...(offered && this.domain?.session?.capabilities
        ? {
            capabilities: [...new Set([...this.domain.session.capabilities, 'tunnel.v1' as const])]
          }
        : {}),
      clock: this.clock,
      isStreamQuiesced: (stream) => this.streamQuiesced(stream),
      isSpaceQuiesced: (space) => this.archiveFences.has(space),
      // A request for a stream the device may not have is answered on that stream with `forbidden` and the
      // connection stays up: the same connection carries everything else the device does here.
      isStreamBlocked: (stream, peer) =>
        blockedFor(stream, peer) ||
        (this.domain?.privateStreams?.access(stream) !== undefined &&
          !(privateReadable(stream, peer) && baseAuthority.canRead(stream, peer))),
      authority: {
        canRead: (...args) =>
          allowed(args[0]) &&
          !blockedFor(args[0], args[1]) &&
          privateReadable(args[0], args[1]) &&
          baseAuthority.canRead(...args),
        canFetchBlob: (...args) =>
          allowed(args[0]) &&
          !blockedFor(args[0], args[2]) &&
          privateReadable(args[0], args[2]) &&
          baseAuthority.canFetchBlob(...args),
        append: (...args) => {
          check(args[0])
          if (blockedFor(args[0], args[4])) throw new NetError('forbidden')
          return baseAuthority.append(...args)
        },
        acceptBlob: (...args) => {
          check(args[0])
          if (blockedFor(args[0], args[4])) throw new NetError('forbidden')
          baseAuthority.acceptBlob(...args)
        },
        blobCommitted: (...args) => {
          check(args[0])
          if (blockedFor(args[0], args[4])) throw new NetError('forbidden')
          baseAuthority.blobCommitted?.(...args)
        }
      },
      localRoutes: () => this.signedRoutes(),
      onPeerRoutes: (routes, peer) =>
        this.adoptRoutes(routes, peer.node, peer.user, peer.delegation),
      ...(inbound?.carrier ? { carrier: inbound.carrier } : {}),
      onAuthenticated: () => {
        if (inbound?.sameUserOnly && session.peer.user !== rt.identity.self()?.user)
          throw new NetError('forbidden')
        if (inbound?.node && session.peer.node !== inbound.node) throw new NetError('forbidden')
        if ([...this.sessions].filter((session) => session.state() === 'open').length > 64)
          throw new NetError('rate_limited')
        if (raw) this.markAuthenticated(raw)
        inbound?.onAuthenticated?.()
        this.routes?.markSessionOpen(channel)
        this.emit()
      }
    })
    this.sessions.add(session)
    if (inbound) this.sessionLinks.set(session, { direction: 'in', transport: inbound.carrier })
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
      try {
        this.domain?.onSessionClosed?.(session)
      } catch {
        // A domain observer cannot change how a session ends.
      }
      this.emit()
    })
    void session.opened
      .then(
        () => {
          this.lastError = undefined
          this.domain?.onSessionOpened?.(session)
          this.observePeer(session)
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
    return this.hosted?.prepareSpaceRendezvous(expiresAt, uses)
  }
  async connectSpaceInvitation(
    peer: PeerRef,
    signal: AbortSignal,
    rendezvous?: RelayRendezvous
  ): Promise<SecureChannel> {
    if (!rendezvous) return this.connectChannel(peer, signal)
    this.assertFeature('netSpaces')
    if (!this.hosted?.connected() || rendezvous.expiresAt <= Date.now())
      throw new NetError('forbidden', 'Sign in to Mousse ID before joining this hosted Space.')
    const transport = new ProfileTransports({
      clock: this.clock,
      profileDir: this.options.profileDir,
      hosted: this.hosted.transports,
      identity: () => this.relayIdentity(),
      relayRendezvous: rendezvous
    })
    const hostedSignal = AbortSignal.any([signal, this.shutdownSignal.signal])
    try {
      const raw = await transport.dial(
        {
          transport: HOSTED_RELAY_TRANSPORT,
          address: rendezvous.relay + '?node=' + peer.node,
          priority: 0
        },
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
    this.prunePresence(rt, roster)
    this.syncEditorSsh()
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
          this.sessionLinks.set(session, {
            direction: 'out',
            transport: result.route.transport,
            address: result.route.address
          })
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
    // The live roster drops revoked delegations but keeps their revocation evidence.
    if (!result)
      throw new NetError(
        roster.revoked.some((row) => row.subject === node) ? 'revoked' : 'bad_delegation'
      )
    if (
      roster.revoked.some((row) => row.subject === node && row.throughKeyEpoch >= result.keyEpoch)
    )
      throw new NetError('revoked')
    return result
  }
  /**
   * A device was just blocked: its subscriptions end and its running requests are asked to stop.
   * Its next call is refused by the policy check itself; this is for what is already under way.
   */
  private endBlockedNode(node: NodeId): void {
    this.state?.rpc.abortCaller(node)
    for (const session of this.sessions) {
      try {
        if (session.state() === 'open' && session.peer.node === node)
          void session.endServing('forbidden').catch(() => {})
      } catch {
        // Not authenticated yet: its first read is checked against the policy.
      }
    }
    // Its private streams are closed as well, not only unserved: nothing is kept open for a device that is blocked.
    this.domain?.privateStreams?.close({ reader: node })
  }
  /** Tells every session that serves one of these private streams that it is over. */
  private endPrivateServing(streams: readonly StreamId[]): void {
    if (!streams.length) return
    for (const session of this.sessions)
      for (const stream of streams) {
        try {
          if (session.state() === 'open' && session.serves(stream))
            void session.failServingStream(stream, 'forbidden').catch(() => {})
        } catch {
          // A session that is closing has nothing left to end.
        }
      }
  }
  /** Sessions that authenticated `node` but are not open yet do not see roster changes. */
  private closeHandshakingSessions(node: NodeId): void {
    for (const session of this.sessions) {
      if (session.state() !== 'connecting') continue
      try {
        if (session.peer.node === node) session.close('revoked')
      } catch {
        // Not authenticated yet: its hello is checked against the new roster.
      }
    }
  }
  /**
   * Why `link`'s device may not have an editor tunnel on this computer right now, or undefined. An editor
   * tunnel is shell access (an SSH login on this computer's own SSH server), so it needs everything a
   * terminal needs and a switch of its own. Read from the live policy and roster on every open and on every
   * change, so a tunnel never outlives its permission.
   */
  private tunnelRefusal(link: TunnelLink): TunnelReason | undefined {
    let node: NodeId
    try {
      node = link.peer.node
    } catch {
      return this.state && this.featureEnabled('netBridge') ? 'capability' : 'net_off'
    }
    return this.deviceRefusal(node)
  }
  /**
   * The devices of the roster that may have an editor connection now, for the sweep of what the endpoint started
   * (`EditorTunnels.sweepStrays`). Undefined when the roster cannot be read (a locked key store): the sweep then
   * stops nothing, since it could not tell a device that has the right from one that has not.
   */
  private allowedEditorDevices(): NodeId[] | undefined {
    const rt = this.state
    if (!rt) return undefined
    const self = rt.identity.self()
    // A computer that is not enrolled has no device with a right.
    if (!self) return []
    let subjects: NodeId[]
    try {
      const roster = rt.identity.verifySigned<Roster>(
        rt.identity.roster()!,
        rt.keys.rootKey() ?? rt.identity.pinnedRootKey(self.user)!
      )
      subjects = roster.nodes.map(
        (row) => rt.identity.verifySigned<NodeDelegation>(row, roster.rootKey).subject
      )
    } catch {
      return undefined
    }
    return [...new Set(subjects)].filter((node) => this.deviceRefusal(node) === undefined)
  }
  /** The same checks for a device named by id, which has no session now (what it started may still be running). */
  private deviceRefusal(node: NodeId): TunnelReason | undefined {
    const rt = this.state
    if (!rt || !this.featureEnabled('netBridge')) return 'net_off'
    if (rt.policy.isBlocked(node)) return 'blocked'
    let caps: readonly NodeCapability[]
    try {
      // From the roster, not from what the session last saw: a grant taken away counts at once.
      caps = this.currentNode(node).caps
    } catch {
      return 'capability'
    }
    if (!caps.includes('settings')) return 'capability'
    if (this.config.workOnThreads === false) return 'setting_off'
    if (!rt.policy.get(node).editor) return 'editor_off'
    return undefined
  }
  /** The first editor tunnel a device ever opens on this computer (a desktop notification for the owner). */
  onEditorFirstOpen(listener: (node: NodeId) => void): () => void {
    this.editorFirstOpen.add(listener)
    return () => this.editorFirstOpen.delete(listener)
  }
  /** The editor tunnels that are open, carried here or opened from here. */
  editorTunnelList(node?: NodeId): ReturnType<EditorTunnels['list']> {
    return this.tunnels?.list(node) ?? []
  }
  /**
   * Opens an editor tunnel to the SSH server of another of this user's computers. The caller names only the
   * computer: that computer decides what its far end is. The computer's public SSH host keys come back over
   * Net and are pinned in Mousse's own `known_hosts` before the stream is handed over, so the editor's `ssh`
   * never asks anyone to trust a key. Rejects with a `TunnelError` whose `reason` is one of the fixed words
   * (`editor_off`, `blocked`, `no_ssh_server`...), or with the error of the editor settings when the key
   * cannot be pinned (the tunnel is closed then).
   */
  async openEditorTunnel(
    node: NodeId,
    signal?: AbortSignal
  ): Promise<{ tunnel: ClientTunnel; info: EditorTunnelInfo }> {
    const { tunnels, editor, link } = await this.editorLink(node)
    return this.track(
      (async () => {
        const tunnel = await tunnels.open(link, signal)
        let hostKey: EditorTunnelInfo['hostKey'] = 'unpinned'
        if (editor) {
          try {
            hostKey = await editor.pinHostKeys(node, tunnel.hostKeys)
          } catch (error) {
            // Strict host-key checking would refuse the key anyway; nothing is left open.
            tunnel.close()
            throw error
          }
        }
        return {
          tunnel,
          info: {
            path: tunnel.path,
            ...(tunnel.transport ? { transport: tunnel.transport } : {}),
            hostKey
          }
        }
      })()
    )
  }
  /**
   * What an editor connection to `node` would meet, without opening one (`ssh.check`): the other computer answers
   * as it would an open and keeps nothing, so its audit has a check and not an open, no first-open notice is
   * raised, and the open limits are not used. The host keys it vouches for are pinned, as an open does.
   */
  private async editorProbe(node: NodeId): Promise<EditorProbeResult> {
    try {
      const { tunnels, editor, link } = await this.editorLink(node)
      const answer = await this.track(tunnels.check(link))
      if (editor) await editor.pinHostKeys(node, answer.hostKeys)
      return {
        ok: true,
        path: answer.path,
        ...(answer.transport ? { transport: answer.transport } : {})
      }
    } catch (error) {
      if (error instanceof TunnelError)
        return { ok: false, reason: error.reason, message: error.message }
      if (error instanceof EditorSshError)
        return { ok: false, reason: 'ssh_settings', code: error.code, message: error.message }
      throw error
    }
  }
  /** What opening or checking an editor connection to `node` needs: the service, this computer's editor settings, a session. */
  private async editorLink(node: NodeId): Promise<{
    tunnels: EditorTunnels
    editor: EditorSshConfig | undefined
    link: NetSyncSession
  }> {
    this.assertFeature('netBridge')
    const rt = this.requireEnrolled(),
      tunnels = this.tunnels
    if (!tunnels || node === rt.identity.self()?.node) throw new NetError('bad_request')
    // A computer of this user's roster only (a device of another user has no session that can carry a tunnel).
    try {
      this.currentNode(node)
    } catch {
      throw new NetError('bad_request', 'Unknown computer.')
    }
    // With editor settings here, the computer needs its alias before anything is opened: the host key is pinned
    // under it, and a tunnel that would only be closed again must not touch the other computer's SSH server,
    // write its audit row or raise its notice.
    const editor = this.editorSsh()
    if (editor && !(await editor.aliasOf(node)))
      throw new EditorSshError(
        'unknown_computer',
        'This computer has no editor alias for that computer yet.'
      )
    let link: NetSyncSession | undefined
    for (const session of this.sessions) {
      try {
        if (session.state() !== 'open' || session.peer.node !== node) continue
        link = session
        if (session.supportsTunnels()) break
      } catch {
        // Not authenticated yet.
      }
    }
    if (!link) throw new TunnelError('offline')
    return { tunnels, editor, link }
  }
  private localTunnels(): LocalEditorTunnels {
    return (this.localTunnelStore ??= new LocalEditorTunnels({
      open: (node, signal) => this.openEditorTunnel(node, signal),
      computerName: (node) => {
        try {
          return proxyComputerName(this.currentNode(node).name)
        } catch {
          return undefined
        }
      }
    }))
  }
  /**
   * The local methods of `mousse-cli net ssh-proxy`: open a tunnel to another computer's SSH server and move its
   * bytes in pieces. A tunnel belongs to the local connection that opened it and ends with it. Local owner IPC
   * only, like the other `net.*` methods: another computer cannot reach them through Bridge.
   */
  async editorTunnelRequest(
    method: EditorTunnelLocalMethod,
    params: Record<string, unknown>,
    connection: LocalConnection
  ): Promise<unknown> {
    if (this.stopped) throw new NetError('cancelled')
    const tunnels = this.localTunnels()
    if (method === 'net.editor.tunnel.open') {
      if (!isId('node', params.node)) throw new NetError('bad_request')
      return this.track(tunnels.open(connection, params.node))
    }
    const handle = params.tunnel
    if (typeof handle !== 'string' || !EDITOR_TUNNEL_HANDLE.test(handle))
      throw new NetError('bad_request')
    switch (method) {
      case 'net.editor.tunnel.read': {
        const wait =
          params.waitMs === undefined ? EDITOR_TUNNEL_LOCAL_READ_WAIT_MS : Number(params.waitMs)
        if (!Number.isFinite(wait) || wait < 0) throw new NetError('bad_request')
        return tunnels.read(connection.id, handle, wait)
      }
      case 'net.editor.tunnel.write': {
        const text = params.data
        if (
          typeof text !== 'string' ||
          text.length > Math.ceil(EDITOR_TUNNEL_LOCAL_CHUNK_BYTES / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)
        )
          throw new NetError('bad_request')
        return this.track(tunnels.write(connection.id, handle, Buffer.from(text, 'base64')))
      }
      case 'net.editor.tunnel.end':
        return this.track(tunnels.end(connection.id, handle))
      case 'net.editor.tunnel.close':
        tunnels.close(connection.id, handle)
        return { ok: true }
      default:
        throw new NetError('bad_request')
    }
  }
  /** A local connection closed: its editor tunnels end. */
  editorTunnelConnectionClosed(connection: string): void {
    this.localTunnelStore?.closeConnection(connection)
  }
  session(node: NodeId): SyncSession {
    this.assertEnabled()
    for (const session of this.sessions)
      if (session.state() === 'open' && session.peer.node === node) return session
    throw new NetError('peer_offline')
  }
  /** True while an open session (of `node`, when given) is being served the stream. */
  streamSubscribed(stream: StreamId, node?: NodeId): boolean {
    for (const session of this.sessions)
      if (
        session.state() === 'open' &&
        (node === undefined || session.peer.node === node) &&
        session.serves(stream)
      )
        return true
    return false
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
  /** Display-only thread deltas to sessions live-serving the stream; never stored or replayed. */
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    if (this.stopped || this.disabled || !this.config.enabled) return
    for (const session of this.sessions) {
      if (session.state() !== 'open') continue
      try {
        session.publishDelta(stream, data, key)
      } catch (error) {
        if (
          error instanceof NetError &&
          (NET_ERRORS[error.code].category === 'denied' ||
            [
              'peer_offline',
              'cancelled',
              'stream_unknown',
              'meta_stale',
              'roster_conflict',
              'outcome_uncertain'
            ].includes(error.code))
        )
          continue
        throw error
      }
    }
  }
  /** Drops unsent deltas a durable record supersedes; best effort like `publishDelta`. */
  discardDeltas(stream: StreamId, matches: (key: string) => boolean): void {
    for (const session of this.sessions) {
      try {
        session.discardDeltas(stream, matches)
      } catch {
        // A closing session has nothing left to send.
      }
    }
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
  private async join(
    invite: string,
    name?: string,
    passphrase?: string,
    via?: string
  ): Promise<unknown> {
    if (via !== undefined && !isJoinVia(via)) throw new NetError('bad_request')
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
        await rt.keys.initialize({ asAuthority: false, passphrase })
        this.config.preparedForJoin = true
        this.saveConfig()
      } else {
        if (rt.keys.state() !== 'unlocked') throw new NetError('keystore_locked')
        rt.keys.protect(passphrase)
      }
    }
    if (needsProtection && !rt.keys.protectedAtRest()) throw new NetError('keystore_locked')
    const prepared = await rt.enrollment.prepareNodeJoin(invite, name)
    if (prepared.state !== 'enrolled') {
      const transport = new ProfileTransports({
        clock: this.clock,
        profileDir: this.options.profileDir,
        hosted: this.hosted?.transports,
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
            // A remote machine set up over SSH reaches this computer through its own tunnel first.
            routes: [
              ...(via ? [{ transport: 'direct', address: via, priority: 0 }] : []),
              ...routes.routes
            ]
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
    this.config.features = {
      netBridge: true,
      netSpaces: true,
      netBridgeThreads: this.config.features?.netBridgeThreads !== false
    }
    this.config.preparedForJoin = false
    this.saveConfig()
    await this.activate()
    this.adoptRoutes(prepared.routes, prepared.authority)
    this.refreshPeers()
    const authority = this.supervisors.get(prepared.authority)
    // With `via` the joiner may have no route back to the inviter: the inviter dials it over SSH
    // once it approves that route, so the join does not wait for its own connection to open.
    if (authority && !via) await authority.opened
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
  /** An authority from before the thread grant existed gets it on its own delegation. */
  private grantAuthoritySettings(): void {
    try {
      this.state?.identity.grantAuthoritySettings()
    } catch {
      // A roster conflict leaves it for the next renewal; it must not fail activation.
    }
  }
  private scheduleRenewal(): void {
    this.renewal?.cancel()
    this.grantAuthoritySettings()
    this.renewal = this.clock.setTimeout(
      () => {
        if (this.stopped || this.disabled || !this.config.enabled) return
        try {
          this.state?.identity.renewExpiring()
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
        workOnThreads: this.config.workOnThreads !== false,
        editorServer: this.editorServerView(),
        ...(this.disabled ? { restartRequired: true } : {}),
        keystore: rt.keys.state(),
        protected: rt.keys.protectedAtRest(),
        ...(rt.keys.vaultUnavailable?.() ? { vaultUnavailable: true } : {}),
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
    // Every editor tunnel ends now, with its end written to the audit, before the sessions are closed.
    this.tunnels?.endAll('net_off')
    this.localTunnelStore?.closeAll()
    this.shutdownSignal.abort()
    void this.sshBootstrap?.close()
    // A closed bootstrap refuses everything; enabling again needs a fresh one.
    this.sshBootstrap = undefined
    this.webrtc?.stop()
    this.transport?.admission.close()
    this.renewal?.cancel()
    this.presenceTimer?.cancel()
    this.presenceTimer = undefined
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
  private markAuthenticated(raw: Duplex): void {
    this.transport?.markAuthenticated(raw)
    for (const direct of this.enrollmentListeners) direct.markAuthenticated(raw)
  }
  /**
   * A loopback listener for one remote machine's join. Its sockets enter the normal inbound path
   * (the profile's pre-authentication budget, then the enrollment gateway). It is not part of the
   * configuration and is closed when the join ends, so there is nothing to restore on undo.
   */
  private async openEnrollmentListener(): Promise<{ port: number; close(): Promise<void> }> {
    this.assertEnabled()
    this.requireEnrolled()
    if (!this.routes) await this.activate()
    const transport = this.transport
    if (!transport) throw new NetError('route_unreachable')
    const direct = new DirectTransport({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      clock: this.clock
    })
    await direct.provision()
    this.enrollmentListeners.add(direct)
    try {
      await direct.listen((raw, info) => {
        if (this.stopped || this.disabled || !this.config.enabled) {
          raw.destroy()
          return
        }
        const deadline = transport.admission.reserve(raw, inboundPrincipal(info))
        if (deadline === undefined) {
          raw.destroy()
          return
        }
        this.track(this.accept(raw, deadline, 'direct')).catch((error) => {
          this.lastError = error instanceof NetError ? error.code : 'internal'
          this.emit()
        })
      })
    } catch (error) {
      this.enrollmentListeners.delete(direct)
      await direct.teardown()
      throw error
    }
    const address = direct.status().routes[0]?.address
    if (!address) {
      this.enrollmentListeners.delete(direct)
      await direct.teardown()
      throw new NetError('route_unreachable')
    }
    return {
      port: Number(new URL(address).port),
      close: async () => {
        this.enrollmentListeners.delete(direct)
        await direct.teardown()
      }
    }
  }
  private bootstrap(): SshBootstrap {
    return (this.sshBootstrap ??= new SshBootstrap(
      {
        profileDir: this.options.profileDir,
        inviteNode: async (name) => {
          const issued = (await this.request('bridge.invite', {
            name,
            // A machine set up over SSH is a computer that works on threads.
            caps: [...COMPUTER_NODE_CAPABILITIES],
            ttlMs: 15 * 60_000
          })) as { invite: string; inviteId: InviteId }
          return { invite: issued.invite, inviteId: issued.inviteId }
        },
        inviteOutcome: (invite) => this.requireEnrolled().enrollment.inviteOutcome(invite),
        revokeInvite: (invite) => this.requireEnrolled().enrollment.revokeInvite(invite),
        revokeNode: async (node) => {
          await this.request('bridge.revoke', { node })
        },
        openEnrollmentListener: () => this.openEnrollmentListener(),
        adoptRoutes: (signed, node) => {
          this.adoptRoutes(signed, node)
          this.refreshPeers()
        },
        peerOpen: (node) =>
          this.status().peers.some((peer) => peer.node === node && peer.state === 'open'),
        knownNode: (node) => {
          const rt = this.requireEnrolled()
          return node !== rt.identity.self()!.node && rt.identity.isKnownNode(node)
        }
      },
      {
        ...this.options.ssh,
        binary: () =>
          this.options.ssh?.binary ??
          (
            this.transportConfigurations().find((row) => row.id === 'ssh')?.settings as
              { binary?: string } | undefined
          )?.binary,
        userKnownHosts: this.options.ssh?.userKnownHosts
      }
    ))
  }
  /** Owner-only methods for adding a remote machine over SSH; a peer can never reach them. */
  private async sshRequest(
    method: NetLocalMethod,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const ssh = this.bootstrap()
    switch (method) {
      case 'net.ssh.check':
        return ssh.check(String(params.host))
      case 'net.ssh.trust':
        return ssh.trust({
          host: String(params.host),
          fingerprint: String(params.fingerprint),
          acknowledgeChanged: params.acknowledgeChanged === true
        })
      case 'net.ssh.plan':
        return ssh.plan({
          host: String(params.host),
          name: String(params.name),
          port: params.port as number | undefined
        })
      case 'net.ssh.list':
        return ssh.list()
      case 'net.ssh.target': {
        // The endpoint this computer approved for the device, the one its own SSH logins use. Read-only.
        const approval = await readSshApproval(this.options.profileDir, params.node as NodeId)
        return approval ? { endpoint: approval.endpoint } : {}
      }
      case 'net.ssh.setup.status':
        return ssh.status(String(params.id))
    }
    this.requireEnrolled()
    switch (method) {
      case 'net.ssh.setup.begin':
        return ssh.begin({
          host: String(params.host),
          name: String(params.name),
          port: params.port as number | undefined
        })
      case 'net.ssh.setup.cancel':
        return ssh.cancel(String(params.id))
      case 'net.ssh.setup.retry':
        return ssh.retry(String(params.id))
      case 'net.ssh.undo':
        return ssh.undo(String(params.id))
      case 'net.ssh.update':
        return ssh.update(String(params.id))
      case 'net.ssh.rename':
        return ssh.rename(String(params.id), String(params.endpoint))
      case 'net.ssh.approve':
        return ssh.approve(params.node as NodeId, String(params.endpoint))
      default:
        throw new NetError('bad_request')
    }
  }
  private editorSsh(): EditorSshConfig | undefined {
    if (!this.options.editorSsh) return undefined
    return (this.editorSshConfig ??= new EditorSshConfig(this.options.editorSsh))
  }
  /** The other computers of this user, for the aliases an editor opens. Phones have no folders to open. */
  private liveComputers(): LiveComputer[] {
    const view = this.nodes() as {
      nodes: Array<{
        node: NodeId
        name: string
        kind: string
        caps: string[]
        self: boolean
        revoked: boolean
      }>
    }
    // The same rule as the lists of threads. Only the authority records which devices are computers, so on any
    // other computer the rest are of unknown kind, and a computer is told by the grant only computers hold.
    return view.nodes
      .filter(
        (entry) =>
          !entry.self &&
          !entry.revoked &&
          isListedComputer(
            entry.kind === 'computer' || entry.kind === 'phone' ? entry.kind : undefined,
            entry.caps
          )
      )
      .map((entry) => ({ node: entry.node, name: entry.name }))
  }
  /**
   * Mousse's ssh settings for editors. Reading, undoing and acknowledging the notice work while
   * networking is off; setting up needs an enrolled device, because the aliases are its computers.
   */
  private async editorSshRequest(method: NetLocalMethod): Promise<unknown> {
    const setup =
      method === 'net.editor.ssh.prepare' ||
      method === 'net.editor.ssh.enable' ||
      method === 'net.editor.alias'
    if (setup) {
      if (this.disabled) throw new NetError('disabled')
      this.assertEnabled()
    }
    const editor = this.editorSsh()
    if (!editor) {
      const status = unavailableEditorSsh()
      if (method === 'net.editor.ssh.status' || method === 'net.editor.ssh.ack') return status
      return { ok: false, code: 'unavailable', message: status.problem!.message, status }
    }
    if (setup) this.requireEnrolled()
    switch (method) {
      case 'net.editor.ssh.status':
        return editor.status()
      case 'net.editor.ssh.disable':
        return editor.disable()
      case 'net.editor.ssh.ack':
        return editor.acknowledgeNotice()
      case 'net.editor.ssh.prepare':
        return editor.prepare(this.liveComputers())
      case 'net.editor.alias':
        return editor.prepareAliases(this.liveComputers())
      case 'net.editor.ssh.enable':
        return editor.enable(this.liveComputers())
      default:
        throw new NetError('bad_request')
    }
  }
  /** At start, and when a device was added, renamed or revoked: keep the aliases in step. Never touches the user's file. */
  private syncEditorSsh(): void {
    const editor = this.editorSsh()
    if (!editor) return
    this.track(editor.syncIfPrepared(() => this.liveComputers())).catch(() => {
      // The aliases are rewritten on the next roster change or the next time the person opens a folder.
    })
  }
  /** `bridge.nodes`, plus the ssh route a peer offers that this computer has not approved. */
  private async nodesView(): Promise<unknown> {
    const rt = this.requireEnrolled()
    const view = this.nodes() as { nodes: Array<{ node: NodeId; self: boolean }> }
    const offers = await Promise.all(
      view.nodes.map(async (entry) => {
        if (entry.self) return undefined
        const row = rt.db.database
          .prepare('SELECT signed FROM net_peer_routes WHERE node=?')
          .get(entry.node)
        if (!row) return undefined
        try {
          const signed = parseProtocolJson(Buffer.from(String(row.signed))) as Signed
          const record = parseProtocolJson(Buffer.from(signed.payload, 'base64url')) as RoutesRecord
          const route = record.routes.find(
            (item) => item.transport === 'ssh' && parseSshRoute(item.address)
          )
          const endpoint = route && /^ssh:\/\/([^/]+)\//u.exec(route.address)?.[1]
          if (!endpoint || (await readSshApproval(this.options.profileDir, entry.node)))
            return undefined
          return { endpoint }
        } catch {
          return undefined
        }
      })
    )
    return {
      nodes: view.nodes.map((entry, index) =>
        offers[index] ? { ...entry, sshOffer: offers[index] } : entry
      )
    }
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
        // Only the authority records kinds. A device with none recorded is unknown, never assumed
        // to be a computer: it cannot be given the thread grant until the owner says what it is.
        kind:
          node.subject === rt.identity.self()!.node
            ? 'computer'
            : (rt.enrollment.nodeKind(node.subject) ?? 'unknown'),
        // What this computer lets the device do here; the device's own limits are on that device.
        policy: policyView(rt.policy.get(node.subject)),
        self: node.subject === rt.identity.self()!.node,
        revoked: roster.revoked.some(
          (row) => row.subject === node.subject && row.throughKeyEpoch >= node.keyEpoch
        ),
        state: this.status().peers.find((peer) => peer.node === node.subject)?.state ?? 'closed',
        ...this.presenceView(node.subject)
      }))
    }
  }
  /** A revoked or replaced device keeps no presence row; every current device keeps its own. */
  private prunePresence(rt: NetRuntime, roster: Roster): void {
    try {
      const live = new Set<NodeId>()
      for (const signed of roster.nodes) {
        const delegation = rt.identity.verifySigned<NodeDelegation>(signed, roster.rootKey)
        if (
          !roster.revoked.some(
            (row) =>
              row.subject === delegation.subject && row.throughKeyEpoch >= delegation.keyEpoch
          )
        )
          live.add(delegation.subject)
      }
      this.presences().prune(live)
    } catch {
      // Presence is a convenience; pruning runs again on the next roster change.
    }
  }
  /** Whether this device may call a read method on its peers; without it `net.info` is refused. */
  private canRead(): boolean {
    try {
      return this.currentNode(this.requireEnrolled().identity.self()!.node).caps.includes('read')
    } catch {
      return false
    }
  }
  private presences(): PeerPresence {
    const db = this.runtime().db
    if (this.presenceStore?.db !== db) this.presenceStore = new PeerPresence(db, this.clock)
    return this.presenceStore
  }
  /**
   * What this computer knows about a device beyond its roster entry: version, how it is connected
   * now, every route tried and when it was last seen. Every field is optional because a device
   * from before `net.info` reports nothing (its row says so through `olderThanThis`).
   */
  private presenceView(node: NodeId): Record<string, unknown> {
    const rt = this.requireEnrolled(),
      current = mousseVersion()
    if (node === rt.identity.self()?.node)
      return {
        version: current,
        platform: process.platform,
        arch: process.arch,
        olderThanThis: false,
        routes: []
      }
    let row: ReturnType<PeerPresence['get']>
    try {
      row = this.presences().get(node)
    } catch {
      // Presence is a convenience; the device list still works without it.
    }
    let open: NetSyncSession | undefined
    for (const session of this.sessions) {
      try {
        if (session.state() === 'open' && session.peer.node === node) open = session
      } catch {
        // Not authenticated yet.
      }
    }
    const link = open ? (this.sessionLinks.get(open) ?? row?.link) : undefined,
      error = open ? undefined : this.supervisors.get(node)?.lastError(),
      lastSeenAt = open ? this.clock.now() : row?.lastSeenAt
    return {
      ...(row?.version ? { version: row.version } : {}),
      ...(row?.platform ? { platform: row.platform } : {}),
      ...(row?.arch ? { arch: row.arch } : {}),
      ...(link
        ? {
            route: {
              direction: link.direction,
              ...(link.transport ? { transport: link.transport } : {}),
              ...(link.address ? { address: link.address } : {})
            }
          }
        : {}),
      routes: this.routes?.health(node) ?? [],
      ...(error ? { error } : {}),
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      // A build with no version has nothing to compare with, so it never calls a peer old. A
      // "too old to answer" verdict only counts for a device this one is allowed to ask.
      olderThanThis:
        current !== '0.0.0' &&
        !!row &&
        ((row.legacy && this.canRead()) || isOlderVersion(row.version, current))
    }
  }
  /** Notes an open session with one of the user's own devices and asks it for its version. */
  private observePeer(session: NetSyncSession): void {
    const link = this.sessionLinks.get(session)
    if (!link) return
    try {
      const rt = this.runtime(),
        peer = session.peer
      if (peer.user !== rt.identity.self()?.user) return
      this.presences().opened(peer.node, link)
      this.startPresenceTimer()
      session.onClosed(() => {
        try {
          this.presences().seen(peer.node)
        } catch {
          // The service is shutting down.
        }
      })
      // A refused `read` also answers `forbidden`, which would look like an older daemon.
      if (!this.canRead()) {
        this.presences().clearLegacy(peer.node)
        return
      }
      // A phone is a browser client with no daemon behind it.
      if (link.transport === PHONE_WEBRTC_TRANSPORT) return
      void this.track(this.readPeerInfo(session, peer.node))
    } catch {
      // Presence never affects a session.
    }
  }
  /** True once the device has sent a signed routes record: computers always do, phones never. */
  private publishesRoutes(node: NodeId): boolean {
    try {
      return !!this.runtime()
        .db.database.prepare('SELECT 1 FROM net_peer_routes WHERE node=?')
        .get(node)
    } catch {
      return false
    }
  }
  private async readPeerInfo(session: NetSyncSession, node: NodeId): Promise<void> {
    try {
      const info = parsePeerInfo(
        await session.rpc('net.info', {}, { id: newId('rpc'), deadlineMs: 10_000 })
      )
      if (info) this.presences().info(node, info)
    } catch (error) {
      // Unknown method: an older daemon. Any other failure (a closed session, a timeout) leaves
      // what was known before. A phone reached over the relay answers the same way, but it
      // never publishes routes, so only a device that does can be an older daemon.
      if (error instanceof NetError && error.code === 'forbidden' && this.publishesRoutes(node)) {
        try {
          this.presences().legacy(node)
        } catch {
          // The service is shutting down.
        }
      }
    }
  }
  /** One timer for every session: keeps "last seen" within a minute while a device is connected. */
  private startPresenceTimer(): void {
    if (this.presenceTimer || this.stopped || this.disabled) return
    this.presenceTimer = this.clock.setTimeout(() => {
      this.presenceTimer = undefined
      if (this.stopped || this.disabled) return
      let connected = false
      for (const session of this.sessions) {
        if (session.state() !== 'open' || !this.sessionLinks.has(session)) continue
        connected = true
        try {
          this.presences().seen(session.peer.node)
        } catch {
          // Try again on the next tick.
        }
      }
      if (connected) this.startPresenceTimer()
    }, 60_000)
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
    // The tunnels end first, while the audit can still be written. As an ordinary disconnect and not a forced end: a
    // quit, an update or a restart of the daemon must not kill what an editor started (as restarting an SSH server
    // does not); whatever has no right by the time Net starts again is stopped by the sweep at that start.
    this.tunnels?.endAll('net_off', false)
    this.localTunnelStore?.closeAll()
    this.shutdownSignal.abort()
    void this.sshBootstrap?.close()
    this.webrtc?.stop()
    this.transport?.admission.close()
    this.renewal?.cancel()
    this.presenceTimer?.cancel()
    this.rosterListener?.()
    this.policyListener?.()
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
