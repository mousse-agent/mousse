import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { NetError } from '../../shared/net/errors'
import type { BlobId, NodeCapability, NodeId, StoredRecord, StreamId } from '../../shared/net'
import type { BridgeNodePolicy } from '../../shared/net/local'
import { ENGINE_OWNER_METHODS } from '../../shared/netEngine/allowlist'
import type {
  NetEngineDevice,
  NetEngineJoinPreview,
  NetEngineReach,
  NetEngineStatus
} from '../../shared/netEngine/local'
import {
  ownerRoute,
  parseRoute,
  routeClass,
  routeText,
  ticketDestinations
} from '../../shared/netEngine/routes'
import type { BridgeProfileService } from '../bridge/BridgeProfileService'
import type { EngineDirectoryPort, PeerRow } from '../bridge/peers'
import { checkNodePolicy } from '../net/checkNodePolicy'
import type { EngineCaller, RpcMethod } from '../net/contracts'
import type { NetRuntime, NetService } from '../net/NetService'
import type { NodePolicy, NodePolicyChange } from '../net/store/nodePolicy'
import {
  engineControl,
  engineControlProblems,
  engineLimitProblems,
  engineLimits,
  packagedBuild
} from './limits'
import { EngineSessions } from './sessions'
import type { BridgeClient, EngineClient } from './session/client'
import type { EngineConnection } from './session/transport'
import { AppChannel, helperCode, type AppPipe } from './helper/appChannel'
import { EngineHelper } from './helper/connections'
import {
  findNetHelper,
  helperProfileId,
  initEndpoint,
  insecureFileKey,
  insecureFileKeyProblems,
  launchHelper,
  type LaunchedHelper
} from './helper/process'
import {
  HELPER_TEXT,
  HelperNotInBuild,
  HelperSupervisor,
  type HelperStatus
} from './helper/supervisor'
import { EnginePairing, fingerprintOf, type PairingStep } from './pairing'
import { routeSetupProbes } from './probes'
import { automatic, loopbackClass } from './routes'
import { EnginePeerStore, type EnginePeerRow } from './store'
import { readTicket } from './ticket'
import { SshAdd } from './ssh/add'
import { removeRequestsOf, type PrepareEngine } from './ssh/prepare'
import type { SshRequestStore } from './ssh/requests'

export const NON_KEEPER_MESSAGE =
  "This profile's network is managed by another computer. Turn its networking on, or Start over."

interface EngineSettings {
  enabled: boolean
  profile: string
}

interface Started {
  rt: NetRuntime
  peers: EnginePeerStore
  sessions: EngineSessions
  timer: ReturnType<typeof setInterval>
  /** Aborted at a pairing's revocation: its handlers stop, nothing else does. */
  revocations: Map<NodeId, AbortController>
  pairing: EnginePairing
  /** The host's owed rows being written from `grants.list`, while they are. */
  reconciling?: Promise<void>
}

const policyView = (policy: NodePolicy): BridgeNodePolicy => ({
  blocked: policy.blocked,
  maxPermissionMode: policy.maxPermissionMode,
  terminal: policy.terminal,
  editor: policy.editor,
  bots: policy.bots,
  agentReach: policy.agentReach,
  work: policy.work
})

/**
 * The engine side of one profile's networking (Phase 1a): its pairings, their sessions and the policy for their
 * calls. It runs on the profile's net runtime (`net.db`, the dispatcher, the stream store) without v1's transports,
 * so remote threads and terminals work with v1 networking off.
 */
export class NetEngineService implements EngineDirectoryPort {
  private started?: Started
  /** The window of this profile's own delegation, as its last renewal saw it. */
  private own?: { issuedAt: number; expiresAt: number }
  /** The helper this profile's connections run through, while one runs. */
  private helper?: EngineHelper
  /** Runs the helper process, once `startHelper` asked for it. */
  private supervisor?: HelperSupervisor
  /** Why this profile's networking could not start, or turned itself off, until it starts again. */
  private problem?: string
  /** Starts a helper; tests put a fake one here. By default, the binary of this build (design §1). */
  launcher?: () => Promise<LaunchedHelper>
  /** Tests stop this computer at a pairing step, as a crash would (until the engine starts again). */
  pairingCrash?: (step: PairingStep) => boolean
  private starting?: Promise<void>
  /** When each condition a device's row reports began (`<node> finishing|in|out`), while it holds. */
  private readonly since = new Map<string, number>()
  /** Wakes the windows when a condition is due to show (`rowStuckMs` after it began). */
  private stuckTimer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly options: {
      profileDir: string
      profileId: string
      net: NetService
      bridge(): BridgeProfileService | undefined
      /** The name this computer gives itself in `hello` and when it bootstraps an identity. */
      name?: () => string
      /** Something a window shows changed: the switch, the helper, a device's row or whether it is online. */
      onChanged?: () => void
    }
  ) {
    options.net.onSetAside((suffix) => this.setAside(suffix))
  }

  /** This profile's folder. */
  get profileDir(): string {
    return this.options.profileDir
  }
  private get directory(): string {
    return join(this.options.profileDir, 'net-engine')
  }
  private get settingsPath(): string {
    return join(this.directory, 'settings.json')
  }
  /** The helper's state folder: its endpoint (key reference, grants, peers, log). */
  private get endpointPath(): string {
    return join(this.directory, 'endpoint')
  }
  private selfName(): string {
    return this.displayName ?? this.options.name?.() ?? hostname()
  }
  /** The name this computer gives itself to its pairings, when set (tests name their computers). */
  displayName?: string
  /** The name this computer gives itself (what a joiner's question shows). */
  ownName(): string {
    return this.selfName()
  }
  /** The name the helper last heard, in its `hello` or a `config.set`. */
  private toldName?: string
  /**
   * Tells the helper this computer's name when it changed since the helper heard it: the OS's computer name can
   * answer after the helper started, and a join or an approval sends the helper's name to the other computer.
   */
  async tellName(): Promise<void> {
    const helper = this.helper,
      name = this.selfName()
    if (!helper || name === this.toldName) return
    try {
      await helper.request('config.set', { name })
      if (this.helper === helper) this.toldName = name
    } catch {
      // The name it heard last stands.
    }
  }

  /** Every pairing row, tombstones too (read-only; for diagnostics and tests). */
  peerRows(): EnginePeerRow[] {
    return this.started?.peers.all() ?? []
  }

  settings(): EngineSettings | undefined {
    try {
      const value = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<EngineSettings>
      return value && typeof value.enabled === 'boolean' && typeof value.profile === 'string'
        ? { enabled: value.enabled, profile: value.profile }
        : undefined
    } catch {
      return undefined
    }
  }

  /** Whether the engine is on and serving for this profile now. */
  on(): boolean {
    return !!this.started
  }
  /** The switch is off, or the engine has started (its pairings are known). */
  settled(): boolean {
    return !!this.started || !this.settings()?.enabled
  }

  /** Turns the switch on and starts the engine (its helper starts with `startHelper`; tests link sessions directly). */
  async enable(): Promise<void> {
    this.writeSettings(true)
    this.changed()
    await this.start()
  }

  /** The switch in Settings: on, and the helper runs. */
  async switchOn(): Promise<void> {
    await this.enable()
    await this.startHelper()
  }

  /** Turns the switch off: the helper gets `shutdown` and the engine stops. Pairings stay for the next time. */
  async disable(): Promise<void> {
    this.writeSettings(false)
    this.problem = undefined
    await this.stop()
    this.changed()
  }

  /** What Settings → Devices and the picker read: the switch, the helper and each paired computer. */
  status(): NetEngineStatus {
    const helper = this.helperStatus()
    const text = 'text' in helper ? helper.text : undefined
    return {
      enabled: !!this.settings()?.enabled,
      on: this.on(),
      helper: { state: helper.state, ...(text ? { text } : {}) },
      ...(this.helper?.paused ? { paused: this.helper.paused } : {}),
      ...(typeof this.helper?.info.identity === 'string'
        ? { identity: this.helper.info.identity }
        : {}),
      devices: this.devices(),
      approvals: this.started?.pairing.pendingApprovals() ?? [],
      ...(this.routes().length ? { routes: this.routes() } : {}),
      ...(this.sharedAccount() ? { sharedAccount: true } : {}),
      scanIntervalMs: engineLimits().scanIntervalMs,
      ...(this.reach() ? { reach: this.reach() } : {})
    }
  }

  // ---------------------------------------------------------------- this computer's routes (Phase 1b §1.5)

  /** This computer's own routes as its helper keeps them (`hello.routes_config`), when it speaks protocol 1.1. */
  reach(): NetEngineReach | undefined {
    const helper = this.helper
    if (!helper?.speaks(1)) return undefined
    return readReach(helper.info.routes_config, helper.info)
  }

  /**
   * Settings → Reach: saves this computer's routes (`routes.config`). A change that needs new listeners
   * (`restart_needed`: LAN, tailnet, port, the first or last port forward or tunnel) restarts this profile's
   * helper, about a second offline (§1.5's one rule); any other change shows in the next invitation.
   */
  async setReach(change: Partial<NetEngineReach>): Promise<{ restarted: boolean }> {
    this.require()
    const helper = this.helper
    if (!helper) throw new NetError('peer_offline', 'Turn networking on first.')
    if (!helper.speaks(1))
      throw new NetError('bad_request', 'Update Mousse to set this up.', {
        details: { reason: 'proto_1_0' }
      })
    const fields = reachRequest(change)
    routeSetupProbes()
    let answer: Record<string, unknown>
    try {
      answer = await helper.request('routes.config', fields)
    } catch (error) {
      throw reachError(error)
    }
    // The reply carries the saved config and what this computer advertises with it: a change that needs no restart
    // shows in the next invitation, and what this computer may share follows it now.
    const saved = answer.config && typeof answer.config === 'object' ? answer.config : undefined
    if (saved) helper.info.routes_config = saved
    if (Array.isArray(answer.routes)) helper.info.routes = strings(answer.routes)
    this.changed()
    if (answer.restart_needed !== true) return { restarted: false }
    await this.restartHelper()
    return { restarted: true }
  }

  /**
   * Test on one of this computer's routes (`routes.test`): the helper dials its own route, pinned to itself, and
   * closes after step 1. Saving never waits for it (§1.5).
   */
  async testRoute(route: string): Promise<{ ok: boolean; ms?: number; reason?: string }> {
    const helper = this.helper
    if (!helper?.speaks(1)) throw new NetError('peer_offline', 'Turn networking on first.')
    const typed = ownerRoute(route)
    const parsed = typed ? parseRoute(typed) : undefined
    if (!parsed || parsed.kind === 'ssh')
      throw new NetError('bad_request', "That isn't an address this computer listens on.", {
        details: { reason: 'bad_route' }
      })
    try {
      const answer = await helper.request(
        'routes.test',
        { route: typed },
        engineLimits().routeTestDeadlineMs
      )
      return answer.ok === true
        ? { ok: true, ...(typeof answer.ms === 'number' ? { ms: answer.ms } : {}) }
        : {
            ok: false,
            reason: typeof answer.reason === 'string' ? answer.reason : 'unreachable'
          }
    } catch (error) {
      return { ok: false, reason: helperCode(error) ?? 'unreachable' }
    }
  }

  /** This profile's helper stops and starts again (a routes change that needs new listeners). */
  async restartHelper(): Promise<void> {
    const supervisor = this.supervisor
    if (!supervisor) return
    await supervisor.stop()
    if (this.supervisor === supervisor && this.started) supervisor.start()
  }

  /**
   * This computer's routes a joiner may also share in pairback (§1.3): what it advertises outside the automatic
   * rule (tailnet and public addresses, tunnels). None is sent unless ticked.
   */
  shareable(): string[] {
    return this.routes().filter((route) => {
      const parsed = parseRoute(route)
      return !!parsed && (parsed.kind === 'tcp' || parsed.kind === 'wss') && !automatic(route)
    })
  }

  /**
   * Connect on a ticket (§1.3): its destinations are approved, and `share` (some of `shareable()`, ticked under
   * "Also share") goes in pairback beside this computer's LAN routes.
   */
  async join(ticket: string, share: readonly string[] = []): Promise<EnginePeerRow> {
    const started = this.require()
    const allowed = this.shareable()
    const unknown = share.find((route) => !allowed.includes(route))
    if (unknown !== undefined)
      throw new NetError('bad_request', "That isn't one of this computer's addresses.", {
        details: { reason: 'bad_share' }
      })
    await this.tellName()
    routeSetupProbes()
    return started.pairing.join(ticket, { share: [...share] })
  }

  // ---------------------------------------------------------------- Add over SSH (Phase 1b §3.4)

  /** Set by the daemon: B's SSH request journal and this profile's selector. */
  sshHost?: { requests: SshRequestStore; selector(): string }
  private sshFlow?: SshAdd

  /** A's side of Add over SSH. */
  sshAdd(): SshAdd {
    this.sshFlow ??= new SshAdd({
      peers: this.require().peers,
      helper: () => this.helper,
      identity: () => String(this.helper?.info.identity ?? ''),
      name: () => this.selfName(),
      limits: () => {
        const limits = engineLimits()
        return { deadlineMs: limits.sshRequestDeadlineMs, maxAgeSecs: limits.sshRequestMaxAgeSecs }
      },
      changed: () => this.changed(),
      now: () => Date.now() / 1000
    })
    return this.sshFlow
  }

  /**
   * Connect in Add over SSH (§3.4 step 3). A computer this one already pairs with only gets the SSH route: it holds
   * B's pin and is granted already (§3.4, "SSH connections per add").
   */
  async sshConnect(choice: Parameters<SshAdd['connect']>[0]): Promise<EnginePeerRow> {
    const started = this.require()
    const profile = choice.selector
      ? (await this.sshAdd().profiles(choice.routeId, choice.host, choice.user)).profiles.find(
          (item) => item.selector === choice.selector
        )
      : undefined
    const known = profile?.identity ? started.peers.serving(profile.identity as NodeId) : undefined
    const paired = profile?.identity ? started.peers.byEndpoint(profile.identity) : known
    if (paired && paired.state === 'connected' && paired.source !== 'ssh') {
      const ssh = {
        requestId: paired.receipt ?? '',
        routeId: choice.routeId,
        selector: choice.selector,
        target: choice.target,
        host: choice.host,
        user: choice.user,
        shell: choice.shell ?? 'sh'
      }
      started.peers.update(paired.localId, { ssh })
      await this.setAddresses({ ...paired, ssh }, paired.addresses ?? [])
      return started.peers.get(paired.localId)!
    }
    routeSetupProbes()
    return this.sshAdd().connect(choice)
  }

  /**
   * B's engine as `prepare` uses it (§3.4 step 4): its row for A, the row it writes, the grant it saves.
   */
  prepareEngine(): PrepareEngine {
    const started = this.require()
    const helper = () => {
      if (!this.helper) throw new NetError('peer_offline', 'Networking is starting.')
      return this.helper
    }
    return {
      identity: String(this.helper?.info.identity ?? ''),
      name: this.selfName(),
      rowFor: (joiner) => {
        // A row being removed counts too: the request waits for it (busy).
        const row = started.peers.all().find((item) => item.endpoint === joiner && item.state !== 'removed')
        if (!row) return undefined
        return {
          key: row.localId,
          state: row.state,
          ...(row.source === 'ssh' && row.ssh?.requestId ? { requestId: row.ssh.requestId } : {}),
          ...(row.grant ? { grant: row.grant } : {})
        }
      },
      writeOwnRow: (request) => {
        // Only the overwrite control reaches here with a row for A: it is lost, as an overwrite would lose it.
        const earlier = started.peers.byEndpoint(request.joiner)
        if (earlier) started.peers.prune(earlier.localId)
        const row = started.peers.add({
          endpoint: request.joiner,
          fingerprint: fingerprintOf(request.joiner),
          grant: '',
          name: request.joinerName,
          state: 'ssh_granting',
          source: 'ssh',
          receipt: request.requestId,
          ssh: { requestId: request.requestId, issuedAt: request.issuedAt },
          pairedAt: Date.now()
        })
        this.helper?.claim(request.joiner)
        this.changed()
        return row.localId
      },
      grantAdd: async (request) => {
        const answer = await helper().request('grant.add', {
          identity: request.joiner,
          name: request.joinerName,
          receipt: request.requestId
        })
        if (typeof answer.grant !== 'number' && typeof answer.grant !== 'string')
          throw new NetError('internal', 'The helper named no grant.')
        return String(answer.grant)
      },
      setRowGrant: (key, grant) => {
        started.peers.update(key as NodeId, { grant })
        this.changed()
      },
      granted: (key) => {
        started.peers.advance(key as NodeId, ['ssh_granting'], { state: 'ssh_granted' })
        this.changed()
      },
      grantLive: async (grantId) => {
        const listed = await helper().request('grants.list')
        return (Array.isArray(listed.grants) ? listed.grants : []).some(
          (grant: Record<string, unknown>) => String(grant.grant) === grantId
        )
      },
      rowGrant: (key) => {
        const row = started.peers.serving(key as NodeId)
        return row?.grant || undefined
      }
    }
  }

  /**
   * §3.4 step 3: networking on if it was off, with nothing advertised (loopback only, no LAN, no tailnet), and its
   * helper running, within `timeoutMs`.
   */
  async quietNetworking(timeoutMs: number): Promise<void> {
    const wasOn = !!this.settings()?.enabled
    if (!wasOn) await this.switchOn()
    const until = Date.now() + timeoutMs
    const running = async () => {
      while (!this.helper || this.helperStatus().state !== 'running') {
        if (Date.now() > until)
          throw new NetError('deadline_exceeded', 'Networking did not start in time.', {
            details: { reason: 'remote_failed' }
          })
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    await running()
    if (!wasOn && this.helper?.speaks(1)) {
      await this.setReach({ lan: false, tailnet: false, public: [], tunnels: [] })
      await running()
    }
  }

  /** After each hello: A repeats `prepare` for its unconfirmed SSH rows; B settles its `ssh_granting` rows. */
  private recoverSsh(): void {
    const started = this.started
    if (!started) return
    const now = Date.now() / 1000
    const maxAge = engineLimits().sshRequestMaxAgeSecs
    for (const row of started.peers.all()) {
      if (row.source !== 'ssh') continue
      // The control repeats `prepare` also for a row that was connected (after B removed this computer, say).
      const again = engineControl('retry-after-connected')
      if (
        (row.state === 'ssh_requested' || (again && row.state === 'connected')) &&
        row.ssh?.routeId &&
        !row.ssh.removed &&
        (!row.ssh.everConnected || again)
      )
        void this.sshAdd()
          .prepare(row)
          .catch(() => undefined)
      if (row.state !== 'ssh_granting' || !this.sshHost) continue
      const request = row.ssh?.requestId ? this.sshHost.requests.get(row.ssh.requestId) : undefined
      if (request?.grantId) {
        started.peers.update(row.localId, { grant: request.grantId })
        started.peers.advance(row.localId, ['ssh_granting'], { state: 'ssh_granted' })
      } else if (!request || now - request.issuedAt > maxAge) started.peers.prune(row.localId)
    }
    this.changed()
  }

  /** What a ticket would do before Connect (§1.3): its destinations by class, and what this computer may share. */
  joinPreview(ticket: string): NetEngineJoinPreview {
    const facts = readTicket(ticket)
    const loopback = !packagedBuild()
    return {
      ...(facts.name ? { name: facts.name } : {}),
      kind: facts.kind ?? 1,
      ...(facts.expiresAt !== undefined && facts.expiresAt * 1000 <= Date.now()
        ? { expired: true }
        : {}),
      // A loopback hint a check maps to another class reads as that class, and needs Connect as it would.
      destinations: ticketDestinations(facts.routes, loopback).map((item) => {
        const mapped = loopbackClass(item.route)
        return { ...item, ...(mapped ? { cls: mapped } : {}), automatic: automatic(item.route) }
      }),
      shareable: this.shareable().flatMap((route) => {
        const parsed = parseRoute(route)
        const cls = loopbackClass(route) ?? (parsed ? routeClass(parsed) : 'forbidden')
        return cls === 'forbidden' ? [] : [{ route, label: routeText(route), cls }]
      })
    }
  }

  /** Where this computer's helper listens, as it said in `hello`. */
  private routes(): string[] {
    const routes: unknown = this.helper?.info.routes
    return Array.isArray(routes)
      ? routes.filter((route): route is string => typeof route === 'string')
      : []
  }

  /**
   * Whether another profile of this installation (so of this OS account) has the switch on as well as this one:
   * profiles under one OS account can read each other's files and keys.
   */
  sharedAccount(): boolean {
    if (!this.settings()?.enabled) return false
    const home = resolve(this.options.profileDir)
    const nested = basename(dirname(home)) === 'profiles'
    const installation = nested ? dirname(dirname(home)) : home
    const homes = [installation]
    try {
      for (const name of readdirSync(join(installation, 'profiles')))
        homes.push(join(installation, 'profiles', name))
    } catch {
      // No other profiles.
    }
    return homes.some((other) => resolve(other) !== home && engineOn(other))
  }

  /**
   * Add address on a device's row: the other computer is dialled at `address` too, beside what the local network
   * finds. Every owner kind of §1.3 but `ssh` (Add over SSH sets that up): `host:port` or `tcp://` (LAN, tailnet,
   * internet or a name), a tunnel's `https://` or `wss://` URL, or a tunnel client's loopback `ws://`. The owner's
   * entry is its approval. A 1.0 helper takes private-range addresses only (1a §5.3).
   */
  async addAddress(node: NodeId, address: string): Promise<void> {
    const started = this.require()
    const row = started.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    const route = this.helper?.speaks(1) ? ownerRoute(address) : toRoute(address)
    if (!route)
      throw new NetError(
        'bad_request',
        /^ssh:|@/.test(address.trim())
          ? 'Use Add over SSH for an SSH address.'
          : 'Use an address and port, like 192.168.1.20:47100, or a tunnel URL.',
        { details: { reason: 'bad_address' } }
      )
    const addresses = [...(row.addresses ?? []).filter((known) => known !== route), route]
    await this.setAddresses(row, addresses)
  }

  /** Remove on one of a device's addresses: it is no longer dialled, and its approval goes (§1.3). */
  async removeAddress(node: NodeId, address: string): Promise<void> {
    const started = this.require()
    const row = started.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    if (!(row.addresses ?? []).includes(address)) return
    await this.setAddresses(
      row,
      (row.addresses ?? []).filter((known) => known !== address)
    )
  }

  /**
   * Use on "Addresses <B> offered" (§1.3): the routes the other computer offered in pairback become owner
   * addresses, approved by this tap, and are dialled from now on.
   */
  async useOffered(node: NodeId): Promise<void> {
    const started = this.require()
    const row = started.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    const offered = row.offered ?? []
    if (!offered.length) return
    const addresses = [...(row.addresses ?? [])]
    for (const route of offered) if (!addresses.includes(route)) addresses.push(route)
    await this.setAddresses(row, addresses)
    started.peers.update(node, { offered: null })
    this.changed()
    // A pairback waiting on this computer's dial back goes on now.
    if (!started.sessions.online(node))
      void this.helper?.dial(row.endpoint).catch(() => undefined)
  }

  /**
   * The owner's addresses for a pairing, whole (`peer.addresses.set`): the helper stores them, adds an `owner`
   * approval for each and drops the approvals of those no longer listed. A row added over SSH keeps its SSH route.
   */
  private async setAddresses(row: EnginePeerRow, addresses: string[]): Promise<void> {
    const started = this.require()
    if (addresses.length > engineLimits().maxManualAddresses)
      throw new NetError('bad_request', 'Remove an address first.', {
        details: { reason: 'too_many' }
      })
    const helper = this.helper
    if (!helper) throw new NetError('peer_offline', 'Turn networking on first.')
    try {
      await helper.request('peer.addresses.set', {
        identity: row.endpoint,
        routes: ownerRoutes(row, addresses)
      })
    } catch (error) {
      throw addressError(error, helper.speaks(1))
    }
    started.peers.setAddresses(row.localId, addresses)
    this.changed()
  }

  /** Ends an invitation if it is still open (the window that showed it went away); nothing if it ended. */
  async cancelInvite(invitation: string): Promise<void> {
    if (!this.started || !this.helper) return
    await this.started.pairing.cancelInvite(invitation).catch(() => undefined)
  }

  /** Pairing and removal for this run of the engine (§5). */
  pairing(): EnginePairing {
    return this.require().pairing
  }

  /** Retry on a device's row: its ceremony or removal goes on, and it is dialled. */
  async retry(node: NodeId): Promise<void> {
    const started = this.require()
    const row = started.peers.get(node)
    if (!row || row.state === 'removed') throw new NetError('bad_request', 'Unknown device.')
    if (row.state === 'removing') return started.pairing.remove(node)
    if (row.state !== 'connected' && row.state !== 'awaiting_pairback')
      await started.pairing.advance(node)
    if (!started.sessions.online(node) && this.helper && row.state !== 'consented')
      await this.helper.dial(row.endpoint).catch(() => undefined)
  }

  private devices(): NetEngineDevice[] {
    const started = this.started
    if (!started) return []
    const now = Date.now()
    const stuckMs = engineLimits().rowStuckMs
    const seen = new Set<string>()
    // How long a condition of a row has held, from when the status first saw it.
    const held = (key: string, holds: boolean): number => {
      if (!holds) return 0
      seen.add(key)
      let at = this.since.get(key)
      if (at === undefined) this.since.set(key, (at = now))
      return now - at
    }
    const devices = started.peers
      .all()
      .filter((row) => row.state !== 'removed')
      .map((row): NetEngineDevice => {
        const node = row.localId
        const online = started.sessions.online(node)
        const serving = started.sessions.serving(node)
        // A row added over SSH runs one way only (1b §3.6): A uses B, so A's direction is its client and B's is
        // A's client here.
        const direction = row.source === 'ssh' ? (row.ssh?.routeId ? 'out' : 'in') : undefined
        const up = direction === 'out' ? online : direction === 'in' ? serving : online && serving
        // Connected only with both directions up: this computer's client to it, and its client here.
        const state =
          row.state === 'removing'
            ? 'removing'
            : direction && row.state !== 'connected' && row.state !== 'removed'
              ? 'connecting'
              : row.state !== 'connected'
                ? 'finishing'
                : up
                  ? 'connected'
                  : online || serving
                    ? 'connecting'
                    : 'offline'
        const stuck = held(`${node} finishing`, state === 'finishing') >= stuckMs
        // One direction down for the bound while the other works.
        const paired = row.state === 'connected' && !direction
        const outDown = held(`${node} out`, paired && !online) >= stuckMs
        const inDown = held(`${node} in`, paired && !serving) >= stuckMs
        const unreachable = outDown && serving ? 'out' : inDown && online ? 'in' : undefined
        // The class of the route its connection came up on (§7 `conn.up.route`), this computer's dial first.
        const route = started.sessions.route(node)?.class
        return {
          node,
          name: row.name,
          shortId: row.endpoint.slice(0, 8),
          ...(started.pairing.accepted(node) && !row.ssh?.removed ? {} : { notAccepted: true }),
          ...(direction ? { direction } : {}),
          state,
          online,
          ...(stuck ? { stuck: true } : {}),
          ...(unreachable ? { unreachable } : {}),
          ...(started.pairing.certificateWindow(node) ? { certificateWindow: true } : {}),
          ...(row.addresses?.length ? { addresses: row.addresses } : {}),
          ...(route ? { route } : {}),
          ...(row.offered?.length ? { offered: row.offered } : {}),
          ...(row.source ? { source: row.source } : {})
        }
      })
    for (const key of [...this.since.keys()]) if (!seen.has(key)) this.since.delete(key)
    this.wakeWhenStuck(now, stuckMs)
    return devices
  }

  /** A condition that has not shown yet shows once it has held for the bound: the windows read again then. */
  private wakeWhenStuck(now: number, stuckMs: number): void {
    const due = [...this.since.values()].map((at) => at + stuckMs).filter((at) => at > now)
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = undefined
    if (!due.length || !this.started) return
    this.stuckTimer = setTimeout(
      () => {
        this.stuckTimer = undefined
        this.changed()
      },
      Math.min(...due) - now + 50
    )
    this.stuckTimer.unref?.()
  }

  /** Tells the windows to read the status again. */
  private changed(): void {
    try {
      // The rows' conditions are timed from the change that began them.
      if (this.started) this.devices()
    } catch {
      // Stopping: its database closed already.
    }
    try {
      this.options.onChanged?.()
    } catch {
      // A window that missed it reads again on focus.
    }
  }

  /**
   * Starts when the switch is on: builds the net runtime (no transport starts, `net.status` stays off),
   * bootstraps this profile's author if it has none, renews its delegation and activates Bridge.
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    this.starting ??= this.startNow().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async startNow(): Promise<void> {
    if (!this.settings()?.enabled) return
    // The limits are read once, here; a variable with a bad value keeps its default and is said so.
    for (const problem of [
      ...engineLimitProblems(),
      ...engineControlProblems(),
      ...insecureFileKeyProblems()
    ])
      console.warn(`network engine limit: ${problem}`)
    const { net } = this.options
    const rt = net.runtime()
    if (!rt.identity.self()) await rt.identity.bootstrapAuthority(this.selfName())
    if (rt.identity.isKeeper()) this.renewOwn(rt)
    // A profile that joined another computer's network cannot renew its own delegation: v1 renews it through
    // that computer, so the engine runs only while v1 is on.
    else if (!net.featureEnabled('netBridge'))
      throw new NetError('forbidden', NON_KEEPER_MESSAGE, { details: { reason: 'not_keeper' } })
    const peers = new EnginePeerStore(rt.db)
    // What aborted handlers wrote under a removed pairing's id goes, then its tombstone (§5.4 step 4).
    peers.sweep()
    const revocations = new Map<NodeId, AbortController>()
    const sessions: EngineSessions = new EngineSessions({
      name: () => this.selfName(),
      host: {
        rpc: rt.rpc,
        get store() {
          return bridge().threads.store
        },
        blobs: rt.blobs,
        now: () => Date.now(),
        caller: (connection) => this.callerOf(connection),
        revoked: (caller) => {
          let controller = revocations.get(caller.node)
          if (!controller) revocations.set(caller.node, (controller = new AbortController()))
          return controller.signal
        },
        assertReadable: (stream, caller) => this.assertReadable(stream, caller),
        canFetchBlob: (stream, blob, caller) => this.canFetchBlob(stream, blob, caller),
        artifacts: {
          acceptBlob: (...args) => bridge().artifacts.acceptBlob(...args),
          blobCommitted: (...args) => bridge().artifacts.blobCommitted(...args),
          append: (...args) => bridge().artifacts.append(...args)
        },
        name: () => this.selfName(),
        pairback: (caller, request) => pairing.pairback(caller, request)
      },
      client: {
        get store() {
          return bridge().threads.store
        },
        verify: (stream, _record, _snapshot, client) => this.verifyIngest(stream, client)
      },
      hooks: {
        onClientReady: (node) => {
          this.options.bridge()?.peerOnline(node)
          pairing.clientReady(node)
          // A: its first live connection to B confirms an SSH add (1b §3.4 step 6).
          // Stopping: the store is closed, and nothing is written.
          const row = this.started?.peers === peers ? peers.get(node) : undefined
          if (row?.source === 'ssh' && row.state === 'ssh_granted') this.sshAdd().connected(row)
          this.changed()
        },
        onClientClosed: (node) => {
          this.options.bridge()?.peerOffline(node)
          this.changed()
        },
        onServingChanged: (node) => {
          // B: A's first live inbound with the row's grant connects it ("Added over SSH from <A>").
          const row = this.started?.peers === peers ? peers.get(node) : undefined
          if (
            row?.source === 'ssh' &&
            row.state === 'ssh_granted' &&
            !row.ssh?.routeId &&
            sessions.serving(node)
          )
            peers.advance(node, ['ssh_granted'], { state: 'connected' })
          this.changed()
        },
        // The helper keeps a newer outbound path (renewed, or dialled while one was up) waiting until told.
        onPathInUse: (connection) => {
          const conn = Number(connection.id)
          if (!Number.isSafeInteger(conn) || !this.helper) return
          void this.helper.request('path.reopened', { conn }).catch(() => {
            // `not_renewed`: it was current already (the first path); `no_conn`: it is gone.
          })
        }
      }
    })
    const bridge = (): BridgeProfileService => {
      const service = this.options.bridge()
      if (!service) throw new NetError('disabled')
      return service
    }
    const pairing: EnginePairing = new EnginePairing({
      peers,
      sessions,
      helper: () => this.helper,
      teardown: (node) => this.teardown(node),
      changed: () => this.changed(),
      crashAt: (step) => !!this.pairingCrash?.(step),
      sshRequest: (receipt) => this.sshHost?.requests.get(receipt)?.state,
      removed: async (row) => {
        const host = this.sshHost
        const helper = this.helper
        if (!host || !helper || !row.endpoint) return
        await removeRequestsOf(host.requests, row.endpoint, host.selector(), {
          list: async () => {
            const listed = await helper.request('grants.list')
            return (Array.isArray(listed.grants) ? listed.grants : []).map(
              (grant: Record<string, unknown>) => ({
                grant: String(grant.grant),
                identity: String(grant.identity),
                ...(typeof grant.receipt === 'string' ? { receipt: grant.receipt } : {})
              })
            )
          },
          remove: async (grant) => {
            await helper.request('grant.remove', { grant: Number(grant) })
          }
        })
      }
    })
    const timer = setInterval(() => {
      try {
        this.renew()
      } catch {
        // Tried again on the next tick; the host keeps serving on its current delegation until it lapses.
      }
    }, engineLimits().renewIntervalMs)
    timer.unref?.()
    this.started = { rt, peers, sessions, timer, revocations, pairing }
    net.setEngineAuthorizer((method, caller, capability) =>
      this.authorizeEngine(method, caller, capability)
    )
    bridge().activateBridge()
    // What was read before the pairings were known (bot reach, the device lists) is read again.
    bridge().peers.changed()
  }

  /** Renews this profile's own delegation when it is due (what the hourly timer runs). */
  renew(): void {
    const rt = this.require().rt
    if (rt.identity.isKeeper()) this.renewOwn(rt)
  }
  private renewOwn(rt: NetRuntime): void {
    if (engineControl('no-renewal')) return
    const limits = engineLimits()
    const { issuedAt, expiresAt } = rt.identity.renewSelf(
      limits.renewDueWithinMs,
      limits.clockSkewMs
    )
    this.own = { issuedAt, expiresAt }
  }
  /**
   * Renews before serving or calling when the own delegation is due: the clock may have jumped (a computer that
   * slept for a week) since the hourly check, or gone back past the delegation's start. Reads only the window the
   * last renewal saw.
   */
  private renewIfDue(): void {
    const started = this.started
    if (!started || !started.rt.identity.isKeeper()) return
    const now = Date.now()
    const limits = engineLimits()
    if (
      this.own &&
      this.own.expiresAt - now > limits.renewDueWithinMs &&
      this.own.issuedAt <= now + limits.clockSkewMs
    )
      return
    try {
      this.renewOwn(started.rt)
    } catch {
      // Tried again on the next call or tick; what needs the delegation says so itself.
    }
  }

  /**
   * Starts the engine and then its helper process, which is started again whenever it exits until `stop`. A
   * failure marks only this profile: `helperStatus` says "Couldn't start".
   */
  async startHelper(): Promise<void> {
    try {
      await this.start()
    } catch (error) {
      this.problem = "Couldn't start"
      throw error
    }
    if (!this.started) return
    this.problem = undefined
    this.supervisor ??= new HelperSupervisor({
      launch: () => (this.launcher ?? (() => this.launchBuilt()))(),
      use: (pipe) => this.useHelper(pipe),
      mismatch: () => {
        this.writeSettings(false)
        this.problem = HELPER_TEXT.mismatch
        void this.stop()
      },
      wrongProfile: () => this.setEndpointAside('wrong-profile'),
      log: (message) => console.warn(message)
    })
    this.supervisor.onStatus(() => this.changed())
    this.supervisor.start()
  }

  /** Where this profile's helper is, and what the switch shows. */
  helperStatus(): HelperStatus | { state: 'failed'; text: string } {
    const status = this.supervisor?.status()
    if (this.problem && (!status || status.state === 'off'))
      return { state: 'failed', text: this.problem }
    return status ?? { state: 'off' }
  }

  /** The app's view of the helper running now. */
  currentHelper(): EngineHelper | undefined {
    return this.helper
  }

  /** Starts this build's helper: `init` first when there is no endpoint, then `serve --app` (on `port`, if given). */
  async launchBuilt(options: { port?: number } = {}): Promise<LaunchedHelper> {
    const binary = findNetHelper()
    if (!binary) throw new HelperNotInBuild()
    // A profile folder copied from another profile carries that profile's endpoint: it is set aside.
    const settings = this.settings()
    if (settings && settings.profile !== this.options.profileId) {
      this.setEndpointAside('copied')
      this.writeSettings(settings.enabled)
    }
    const insecure = insecureFileKey()
    if (!existsSync(join(this.endpointPath, 'identity.json'))) {
      mkdirSync(this.directory, { recursive: true })
      await initEndpoint(
        binary,
        this.endpointPath,
        helperProfileId(this.options.profileId),
        insecure
      )
    }
    return launchHelper(binary, this.endpointPath, insecure, options.port)
  }

  private writeSettings(enabled: boolean): void {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(
      this.settingsPath,
      JSON.stringify({ enabled, profile: this.options.profileId } satisfies EngineSettings)
    )
  }

  /** The endpoint goes aside; the next start makes a new one, and its pairings show "Pair again". */
  private setEndpointAside(why: string): void {
    if (existsSync(this.endpointPath))
      renameSync(this.endpointPath, `${this.endpointPath}.${why}-${Date.now()}`)
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const supervisor = this.supervisor
    this.supervisor = undefined
    await supervisor?.stop()
    const started = this.started
    if (!started) return
    this.started = undefined
    this.own = undefined
    started.pairing.stop()
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = undefined
    this.since.clear()
    this.helper?.close()
    this.helper = undefined
    clearInterval(started.timer)
    this.options.net.setEngineAuthorizer(undefined)
    started.sessions.closeAll('stopped')
  }

  /** Start over: the engine stops and its folder goes aside with `net/` (its rows are in that `net.db`). */
  private async setAside(suffix: string): Promise<void> {
    await this.stop()
    if (existsSync(this.directory)) renameSync(this.directory, `${this.directory}.${suffix}`)
  }

  /**
   * The engine branch of the dispatcher's authorization: a live `owner` grant, a method on the allowlist, then
   * the same per-device policy v1 callers are held to.
   */
  authorizeEngine(method: RpcMethod, caller: EngineCaller, _capability: NodeCapability): void {
    const started = this.started
    if (!started) throw new NetError('forbidden')
    this.renewIfDue()
    const row = started.peers.serving(caller.node)
    if (!row || row.grant !== caller.grant || caller.role !== 'owner')
      throw new NetError('forbidden')
    if (!ENGINE_OWNER_METHODS.has(method.method)) throw new NetError('forbidden')
    checkNodePolicy(method, caller.node, started.rt.policy, this.options.net.nodePolicyConfig())
  }

  /** `bridge.policy` for an engine pairing: what it may do here, kept in the same table as v1 devices'. */
  setPolicy(node: NodeId, change: NodePolicyChange): { policy: BridgeNodePolicy } {
    const started = this.require()
    if (!started.peers.serving(node)) throw new NetError('bad_request', 'Unknown device.')
    return { policy: policyView(started.rt.policy.set(node, change)) }
  }

  /** Saves a pairing (the end of the ceremony in later slices; tests pair directly). */
  pair(row: Omit<EnginePeerRow, 'localId' | 'pairedAt'> & { localId?: NodeId }): EnginePeerRow {
    const saved = this.require().peers.add({ ...row, pairedAt: Date.now() })
    // A connection the pairing brought up before it was recorded (a join's) attaches now.
    this.helper?.claim(saved.endpoint)
    return saved
  }

  /**
   * Runs this profile's connections through a helper over `pipe` (its stdio): every connection it reports up for a
   * pairing is attached, and every one closes when it exits. A helper started again replaces the last one.
   */
  async useHelper(pipe: AppPipe): Promise<EngineHelper> {
    const started = this.require()
    this.helper?.close()
    const helper = new EngineHelper(new AppChannel(pipe), {
      peers: {
        byIdentity: (identity) => {
          const row = started.peers.byEndpoint(identity)
          // A joiner's connection waits until `join` answered and `joined` is written (§5.1 step 4).
          if (!row || row.state === 'consented') return undefined
          return { node: row.localId, grant: row.grant, endpoint: row.endpoint }
        }
      },
      attach: (connection) => this.attach(connection),
      name: () => this.selfName(),
      profile: () => helperProfileId(this.options.profileId),
      // An inbound connection with a live grant and no row: the host may owe it one (§5.1 recovery).
      unclaimed: (_identity, inbound) => {
        if (!inbound || started.reconciling || this.started !== started) return
        started.reconciling = started.pairing
          .reconcileGrants()
          .catch(() => undefined)
          .finally(() => (started.reconciling = undefined))
      }
    })
    this.helper = helper
    helper.onEvent((event) => started.pairing.event(event))
    helper.onPaused(() => this.changed())
    helper.channel.onClose(() => {
      if (this.helper === helper) this.helper = undefined
    })
    const told = this.selfName()
    await helper.hello()
    this.toldName = told
    this.changed()
    // Removals finish, ceremonies resume, owed rows are written and every pairing is dialled again.
    if (this.helper === helper) {
      void started.pairing.recover().catch(() => undefined)
      this.recoverSsh()
    }
    return helper
  }

  /** Asks the helper to connect to a pairing; its client attaches when the connection comes up. */
  async dial(node: NodeId): Promise<void> {
    const row = this.require().peers.serving(node)
    if (!row || !this.helper) throw new NetError('peer_offline')
    await this.helper.dial(row.endpoint)
  }

  /** A connection the helper reports up for one of this profile's pairings. */
  attach(connection: EngineConnection): Promise<void> {
    const started = this.require()
    if (!started.peers.serving(connection.peer)) {
      connection.close('unknown_peer')
      return Promise.reject(new NetError('forbidden'))
    }
    return started.sessions.attach(connection)
  }

  /**
   * Revocation or removal: within one turn the pairing's handlers are aborted, its subscriptions, blob reads and
   * staged writes end, the terminals it attached end, and its connections close. Idempotent.
   */
  teardown(node: NodeId): void {
    const started = this.started
    if (!started) return
    // The removal check's control keeps a removed pairing's handlers and subscriptions running.
    if (engineControl('keep-engine-work')) return
    started.revocations.get(node)?.abort()
    started.revocations.delete(node)
    started.rt.rpc.abortCaller(node)
    started.sessions.teardown(node, 'grant_revoked')
    this.options.bridge()?.releaseNode(node)
  }

  // ---------------------------------------------------------------- the peer directory's engine half

  rows(): PeerRow[] {
    const started = this.started
    if (!started) return []
    return started.peers
      .all()
      .filter((row) => row.state !== 'removing' && row.state !== 'removed')
      .map((row) => ({
        node: row.localId,
        name: row.name,
        caps: ['read', 'chat', 'write', 'terminal', 'settings'],
        kind: 'computer',
        policy: policyView(started.rt.policy.get(row.localId)),
        self: false,
        keeper: false,
        connection: started.sessions.online(row.localId) ? 'connected' : 'disconnected',
        routeHeld: false,
        revoked: false,
        state: started.sessions.online(row.localId) ? 'open' : 'closed',
        source: 'engine'
      }))
  }
  isEngine(node: NodeId): boolean {
    return !!this.started?.peers.get(node)
  }
  serving(node: NodeId): boolean {
    return !!this.started?.peers.serving(node)
  }
  name(node: NodeId): string | undefined {
    return this.started?.peers.get(node)?.name
  }
  client(node: NodeId): BridgeClient {
    const started = this.started
    if (!started || !started.peers.serving(node)) throw new NetError('peer_offline')
    this.renewIfDue()
    return started.sessions.client(node)
  }
  online(node: NodeId): boolean {
    const started = this.started
    return !!started && !!started.peers.serving(node) && started.sessions.online(node)
  }
  /** Binds a stream this computer reads to the pairing it reads it from (in the caller's transaction). */
  bind(stream: StreamId, node: NodeId): void {
    this.require().peers.bind(stream, node)
  }
  /** A stream read from a pairing reads only while it is bound to one that is still serving (§3.4, on reopen). */
  verifyStream(stream: StreamId): void {
    const started = this.started
    const node = started?.peers.binding(stream)
    if (!started || !node || !started.peers.serving(node)) throw new NetError('forbidden')
  }
  publish(stream: StreamId, _record: StoredRecord): void {
    this.started?.sessions.notify(stream)
  }
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    this.started?.sessions.publishDelta(stream, data, key)
  }
  failStream(stream: StreamId, code: import('../../shared/net').NetErrorCode): void {
    this.started?.sessions.fail(stream, code)
  }
  isSubscribed(stream: StreamId, node?: NodeId): boolean {
    return !!this.started?.sessions.isSubscribed(stream, node)
  }
  endServing(node: NodeId, filter?: (stream: StreamId) => boolean): void {
    this.started?.sessions.endServing(node, filter)
  }

  // ---------------------------------------------------------------- checks

  private require(): Started {
    if (!this.started) throw new NetError('disabled')
    return this.started
  }

  private callerOf(connection: EngineConnection): EngineCaller {
    const started = this.require()
    const row = started.peers.serving(connection.peer)
    const self = started.rt.identity.self()
    if (!row || !self || connection.direction !== 'inbound' || row.grant !== connection.grant)
      throw new NetError('forbidden')
    return {
      source: 'engine',
      node: row.localId,
      user: self.user,
      role: 'owner',
      grant: row.grant,
      endpoint: row.endpoint
    }
  }

  /**
   * §4.4: an engine caller reads only a routed private stream bound to it (open, its reader, its bound reader,
   * and allowed by current policy for the stream's kind) or a request artifact of its own.
   */
  private assertReadable(stream: StreamId, caller: EngineCaller): void {
    const started = this.require()
    const bridge = this.options.bridge()
    if (!bridge) throw new NetError('forbidden')
    const descriptor = bridge.threads.store.getStream(stream)
    if (!descriptor) throw new NetError('forbidden')
    // The private-streams check's control serves any stream, bound to this caller or not.
    if (engineControl('second-reader')) return
    if (descriptor.kind === 'node.artifact') {
      if (!bridge.artifacts.canRead(stream, caller)) throw new NetError('forbidden')
      return
    }
    const access = bridge.threads.privateAccess(stream)
    if (!access || !access.open || access.reader !== caller.node) throw new NetError('forbidden')
    const bound = bridge.threads.boundReader(stream)
    if (bound !== undefined && bound !== caller.node) throw new NetError('forbidden')
    const policy = started.rt.policy.get(caller.node)
    if (policy.blocked)
      throw new NetError('forbidden', undefined, { details: { reason: 'blocked' } })
    if (this.options.net.nodePolicyConfig().workOnThreads === false)
      throw new NetError('forbidden', undefined, { details: { reason: 'setting_off' } })
    if (access.kind === 'terminal' && !policy.terminal)
      throw new NetError('forbidden', undefined, { details: { reason: 'terminal_off' } })
  }

  private canFetchBlob(stream: StreamId, blob: BlobId, caller: EngineCaller): boolean {
    const bridge = this.options.bridge()
    if (!bridge) return false
    try {
      this.assertReadable(stream, caller)
    } catch {
      return false
    }
    return this.started!.rt.blobs.isReferenced(blob, stream)
  }

  /** The engine `verify` callback: the stream is bound to this client's pairing, which is serving and live. */
  private verifyIngest(stream: StreamId, client: EngineClient): void {
    const started = this.require()
    if (
      started.peers.binding(stream) !== client.node ||
      !started.peers.serving(client.node) ||
      client.state() !== 'open'
    )
      throw new NetError('forbidden')
  }
}

/** Whether the profile at `home` has the new networking's switch on. */
function engineOn(home: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(home, 'net-engine', 'settings.json'), 'utf8')) as {
      enabled?: unknown
    }
    return value?.enabled === true
  } catch {
    return false
  }
}

/** `host:port` or `tcp://host:port` as a route, IPv6 hosts in brackets; anything else is not an address. */
export function toRoute(address: string): string | undefined {
  const text = address.trim()
  const bare = text.startsWith('tcp://') ? text.slice('tcp://'.length) : text
  const match = /^(\[[0-9A-Fa-f:.]+\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3}):([1-9][0-9]{0,4})$/.exec(bare)
  if (!match || Number(match[2]) > 65535) return undefined
  return `tcp://${match[1]!.toLowerCase()}:${match[2]}`
}

/** An SSH route entry as `peer.addresses.set` takes it (§3.4 step 5). */
export interface SshRouteEntry {
  route_id: string
  selector: string
  shell: string
}

/**
 * The owner's routes as `peer.addresses.set` takes them: the addresses as text, then the row's SSH route as
 * `{route_id, selector, shell}` when it was added over SSH.
 */
export function ownerRoutes(
  row: Pick<EnginePeerRow, 'ssh'>,
  addresses: readonly string[]
): Array<string | SshRouteEntry> {
  const ssh = row.ssh
  return [
    ...addresses,
    ...(ssh?.routeId && ssh.selector
      ? [{ route_id: ssh.routeId, selector: ssh.selector, shell: ssh.shell ?? 'sh' }]
      : [])
  ]
}

/** A helper's refusal of the owner's addresses, as the row's dialog says it. */
function addressError(error: unknown, speaks11: boolean): unknown {
  const code = helperCode(error)
  if (code === 'bad_route' || code === 'forbidden_address')
    return speaks11
      ? new NetError('bad_request', "That address can't be dialled.", {
          details: { reason: code }
        })
      : new NetError('bad_request', 'Only local network addresses can be added for now.', {
          details: { reason: 'not_private' }
        })
  return error
}

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []

/** `hello.routes_config` (or a `routes.config` reply's `routes`) as the status shows it. */
function readReach(value: unknown, info: Record<string, unknown>): NetEngineReach {
  const config = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const unbound = strings(info.unbound)
  const port =
    typeof config.port === 'number'
      ? config.port
      : typeof info.port === 'number'
        ? info.port
        : undefined
  return {
    lan: config.lan !== false,
    tailnet: config.tailnet === true,
    public: strings(config.public),
    ...(typeof config.forward_to === 'string' && config.forward_to
      ? { forwardTo: config.forward_to }
      : {}),
    tunnels: strings(config.tunnels),
    ...(port !== undefined ? { port } : {}),
    ...(typeof info.ws_port === 'number' ? { wsPort: info.ws_port } : {}),
    ...(unbound.length ? { unbound } : {})
  }
}

/** A Reach change as `routes.config` takes it: only the fields given, each checked first. */
export function reachRequest(change: Partial<NetEngineReach>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof change.lan === 'boolean') out.lan = change.lan
  if (typeof change.tailnet === 'boolean') out.tailnet = change.tailnet
  if (change.public !== undefined)
    out.public = change.public.map((entry) => {
      const route = ownerRoute(entry)
      const parsed = route ? parseRoute(route) : undefined
      const cls = parsed ? routeClass(parsed) : 'forbidden'
      if (!parsed || parsed.kind !== 'tcp' || cls === 'forbidden' || cls === 'lan')
        throw new NetError('bad_request', 'Use the public address and port, like 203.0.113.7:47100.', {
          details: { reason: 'bad_public' }
        })
      return parsed.canonical
    })
  if (change.forwardTo !== undefined) {
    const value = change.forwardTo.trim()
    if (value && !automatic(`tcp://${value}:1`))
      throw new NetError('bad_request', "Use this computer's LAN address, like 192.168.1.20.", {
        details: { reason: 'bad_forward_to' }
      })
    out.forward_to = value || null
  }
  if (change.tunnels !== undefined)
    out.tunnels = change.tunnels.map((entry) => {
      const route = ownerRoute(entry)
      if (!route || parseRoute(route)?.kind !== 'wss')
        throw new NetError('bad_request', "Use the tunnel's https:// address.", {
          details: { reason: 'bad_tunnel' }
        })
      return route
    })
  if (change.port !== undefined) {
    if (!Number.isSafeInteger(change.port) || change.port < 1 || change.port > 65535)
      throw new NetError('bad_request', 'Use a port from 1 to 65535.', {
        details: { reason: 'bad_port' }
      })
    out.port = change.port
  }
  return out
}

/** A refused `routes.config`, as Settings says it. */
function reachError(error: unknown): unknown {
  const code = helperCode(error)
  if (code === 'bad_forward_to' || code === 'not_local')
    return new NetError('bad_request', "That address isn't on this computer.", {
      details: { reason: code }
    })
  if (code === 'bad_route' || code === 'forbidden_address')
    return new NetError('bad_request', "That address can't be used.", { details: { reason: code } })
  if (code === 'port_in_use')
    return new NetError('conflict', 'Another app uses that port.', { details: { reason: code } })
  return error
}

