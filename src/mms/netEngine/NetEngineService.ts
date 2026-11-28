import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { NetError } from '../../shared/net/errors'
import { newId, type BlobId, type NodeCapability, type NodeId, type StoredRecord, type StreamId } from '../../shared/net'
import type { BridgeNodePolicy } from '../../shared/net/local'
import { ENGINE_OWNER_METHODS } from '../../shared/netEngine/allowlist'
import { isBotStreamKind } from '../../shared/bridge/routed'
import {
  isNetEngineWay,
  type EngineFeature,
  type NetEngineDevice,
  type NetEngineJoinCheck,
  type NetEngineJoinHint,
  type NetEngineJoinPreview,
  type NetEngineJoinProbe,
  type NetEngineReach,
  type NetEngineStatus,
  type NetEngineWayReadiness
} from '../../shared/netEngine/local'
import { accessPreset, type AccessPresetFields } from '../../shared/net/accessPresets'
import {
  ownerRoute,
  parseRelayDestination,
  parseRoute,
  relayText,
  routeClass,
  routeText,
  ticketDestinations,
  type RouteClass
} from '../../shared/netEngine/routes'
import type { BridgeProfileService } from '../bridge/BridgeProfileService'
import type { EngineDirectoryPort, PeerRow } from '../bridge/peers'
import { checkNodePolicy } from '../net/checkNodePolicy'
import type { EngineCaller, RpcMethod } from '../net/contracts'
import type { NetRuntime, NetService } from '../net/NetService'
import {
  ENGINE_PRESENCE_TABLE,
  ensurePresenceTable,
  parsePeerInfo,
  PeerPresence,
  versionStanding
} from '../net/presence'
import { mousseVersion } from '../appVersion'
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
import { askUpdate, type UpdateThereParams } from '../updates/askUpdate'
import type { EngineConnection, EngineStream } from './session/transport'
import { AppChannel, helperCode, type AppPipe } from './helper/appChannel'
import { EngineHelper } from './helper/connections'
import {
  findNetHelper,
  helperProfileId,
  initEndpoint,
  insecureFileKey,
  insecureFileKeyProblems,
  launchHelper,
  packagedHelperCommit,
  type LaunchedHelper
} from './helper/process'
import {
  HELPER_TEXT,
  HelperNotInBuild,
  HelperSupervisor,
  type HelperStatus
} from './helper/supervisor'
import { ManagedCloudflare } from './cloudflare/service'
import { EnginePlus } from './plus'
import type { LoginStartQuestion } from './loginStart'
import { EnginePairing, fingerprintOf, type PairingStep } from './pairing'
import { EngineAccess } from './access'
import { DEFAULT_LEVEL, EngineRoles, levelAfter, roleForLevel, ROLES_UNSUPPORTED } from './roles'
import { EngineEditor, engineEditorRefusal, type EngineEditorRights, type EngineEditorTestOptions } from './editor'
import { TunnelError } from '../net/editor/tunnel'
import { routeSetupProbes } from './probes'
import {
  deviceRelay,
  dismissKey,
  nextStale,
  offeredBy,
  readGrantRelays,
  readPeerRelays,
  readRelayInfo,
  readRelayList,
  relayError,
  relayLink,
  relaysStatus,
  type RelayView
} from './relays'
import { needsUpdate, readVersionRefusals, refusalMayChange, sameRefusals, type VersionRefusal } from './versionRefusals'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { automatic, handedRoutes, loopbackClass, privateRoute } from './routes'
import { EnginePeerStore, type EnginePeerRow } from './store'
import { readTicket } from './ticket'
import { SshAdd } from './ssh/add'
import { removeRequestsOf, type PrepareEngine } from './ssh/prepare'
import type { SshRequestStore } from './ssh/requests'

export const NON_KEEPER_MESSAGE =
  "This profile's network is managed by another computer. Turn its networking on, or Start over."

/** The relay lists the app reads from its helper (Phase 3): own relays, pairings' relay info, callers' entries. */
type RelayList = 'relays' | 'peers' | 'grants'
const RELAY_LISTS: readonly RelayList[] = ['relays', 'peers', 'grants']

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
  /** The other direction of one-way pairings: requests, answers and what each side grants. */
  access: EngineAccess
  /** Each grant's role, following its device's level. */
  roles: EngineRoles
  /** The host's owed rows being written from `grants.list`, while they are. */
  reconciling?: Promise<void>
  /** The engine's own editor tunnels and SSH endpoint (Phase 1b §9.2). */
  editor: EngineEditor
  /** What reads a right for the editor refusal, live. */
  rights: EngineEditorRights
  /** Listeners to let go of at stop. */
  release: Array<() => void>
  /** Set when `stop` begins: the store may close (the profile's Net shuts down alongside) before the helper has. */
  ending?: boolean
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
  /** The engine commit an installed app's helper must be built from, read at its launch. */
  private packagedCommit?: string
  /** Starts a helper; tests put a fake one here. By default, the binary of this build (design §1). */
  launcher?: () => Promise<LaunchedHelper>
  /** Tests stop this computer at a pairing step, as a crash would (until the engine starts again). */
  pairingCrash?: (step: PairingStep) => boolean
  /** Tests give the engine's editor tunnels an echo far end, a folder of host keys or an endpoint host of their own. */
  editorTest?: EngineEditorTestOptions
  /** The pairings the editor aliases were last told of. */
  private aliasedComputers?: string
  /** The pairings an editor can open a folder on: every serving one, by its name. */
  private editorComputers(): Array<{ node: NodeId; name: string }> {
    return (this.started?.peers.all() ?? [])
      .filter((row) => row.state !== 'removing' && row.state !== 'removed')
      .map((row) => ({ node: row.localId, name: row.name }))
  }
  private starting?: Promise<void>
  /** When each condition a device's row reports began (`<node> finishing|in|out`), while it holds. */
  private readonly since = new Map<string, number>()
  readonly cloudflare: ManagedCloudflare
  /** Wakes the windows when a condition is due to show (`rowStuckMs` after it began). */
  private stuckTimer?: ReturnType<typeof setTimeout>
  /** Mousse Plus and "Remove on all my hosts", as the helper reports them (Phase 4). */
  readonly plus = new EnginePlus(() => this.changed())
  /**
   * What the helper running now said of relays (Phase 3): undefined until it answered, null when it has none (it
   * refused `relay.list`).
   */
  private relayView?: RelayView | null
  /**
   * The relay lists to read again (`relays`, `peers`, `grants`), gathered over `relayReadDebounceMs` so a burst of
   * events reads each list once. `relayReading` is the read running; what arrives meanwhile waits for the next.
   */
  private readonly relayWanted = new Set<RelayList>()
  private relayTimer?: ReturnType<typeof setTimeout>
  private relayReading?: Promise<void>
  /** The relay destinations the owner said Not now to, or stopped using: not asked about again (`dismissKey`). */
  private relayDismissed?: Set<string>
  /**
   * Each device's last refusal for version (pair-with-IP design §5), by identity, as the helper running now lists
   * them; undefined until read, and always for a helper without `version-refusals`. Read again after the events that
   * may change one (`refusalMayChange`), gathered over `relayReadDebounceMs`, one read at a time.
   */
  private refusals?: Map<string, VersionRefusal>
  private refusalTimer?: ReturnType<typeof setTimeout>
  private refusalReading?: Promise<void>
  private refusalAgain = false
  private refusalTicker?: ReturnType<typeof setInterval>
  /** When the refusals were last read (ms since 1970); 0 before the first read. */
  private refusalReadAt = 0
  /**
   * The devices (identities) whose one "needs a Mousse update" notice a window was given, by the refusal's `since`;
   * one leaves once its refusal clears or another takes its place.
   */
  private versionTold?: Map<string, number>
  constructor(
    private readonly options: {
      profileDir: string
      installationHome?: string
      profileId: string
      net: NetService
      bridge(): BridgeProfileService | undefined
      /** The name this computer gives itself in `hello` and when it bootstraps an identity. */
      name?: () => string
      /** Something a window shows changed: the switch, the helper, a device's row or whether it is online. */
      onChanged?: () => void
      /** The installation's start-at-login question (§10), asked when the switch is turned on in a window. */
      loginStart?: LoginStartQuestion
    }
  ) {
    this.cloudflare = new ManagedCloudflare(
      join(this.directory, 'cloudflare'),
      join(options.installationHome ?? options.profileDir, 'runtimes', 'cloudflared'),
      () => this.changed()
    )
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

  /**
   * The switch in Settings: on, and the helper runs. The start-at-login question is settled beside the helper's
   * start (it reads the startup entry), so the reply carries it.
   */
  async switchOn(): Promise<void> {
    await this.enable()
    const question = this.options.loginStart?.turnedOn().catch(() => false)
    try {
      await this.startHelper()
    } finally {
      await question
    }
  }

  /** The window's answer to the start-at-login question: `start` installs the existing startup entry. */
  async answerLoginStart(start: boolean): Promise<void> {
    await this.options.loginStart?.answer(start)
    this.changed()
  }

  /** Turns the switch off: the helper gets `shutdown` and the engine stops. Pairings stay for the next time. */
  async disable(): Promise<void> {
    this.writeSettings(false)
    this.problem = undefined
    // Turned off by the person: editor tunnels end, and what the endpoint started for any device stops.
    this.started?.editor.tunnels.endAll('net_off')
    await this.stop()
    this.changed()
  }

  /** What Settings → Devices and the picker read: the switch, the helper and each paired computer. */
  status(): NetEngineStatus {
    // Opening Devices shows the refusals as the helper holds them now, not only as its last event left them.
    this.freshRefusals()
    const helper = this.helperStatus()
    const text = 'text' in helper ? helper.text : undefined
    const cloudflare = this.cloudflare.status()
    return {
      enabled: !!this.settings()?.enabled,
      on: this.on(),
      helper: {
        state: helper.state,
        ...(text ? { text } : {}),
        ...('step' in helper && helper.step ? { step: helper.step } : {})
      },
      ...(this.helper?.paused ? { paused: this.helper.paused } : {}),
      ...(typeof this.helper?.info.identity === 'string'
        ? { identity: this.helper.info.identity }
        : {}),
      devices: this.devices(),
      approvals: this.started?.pairing.pendingApprovals() ?? [],
      ...(this.started?.access.pending().length ? { accessAsks: this.started.access.pending() } : {}),
      ...(this.routes().length ? { routes: this.routes() } : {}),
      ...(this.sharedAccount() ? { sharedAccount: true } : {}),
      ...(this.settings()?.enabled && this.options.loginStart?.asking() ? { loginStart: 'ask' as const } : {}),
      scanIntervalMs: engineLimits().scanIntervalMs,
      ...(this.helper?.speaks(1) ? { sendLink: true } : {}),
      ...(this.helper?.features().length ? { features: this.helper.features() } : {}),
      ...(this.started?.pairing.links().length ? { links: this.started.pairing.links() } : {}),
      ...(this.started?.pairing.joins().length ? { joins: this.started.pairing.joins() } : {}),
      ...(this.reach() ? { reach: this.reach() } : {}),
      ...(cloudflare ? { cloudflare } : {}),
      ...(this.relayView ? { relays: relaysStatus(this.relayView) } : {}),
      ...(this.options.net.v1On()
        ? {}
        : { workOnThreads: this.options.net.nodePolicyConfig().workOnThreads !== false }),
      ...(this.helper ? this.plus.view((identity) => this.peerName(identity)) : {})
    }
  }

  /**
   * "Work on threads" from this group (v1 off): the same setting and the same switch as v1's, so turning it off ends
   * the open editor tunnels and private streams with `setting_off`.
   */
  setWorkOnThreads(enabled: boolean): void {
    this.options.net.setWorkOnThreads(enabled)
    this.changed()
  }

  // ---------------------------------------------------------------- relays (Phase 3 §B.5, §B.9, §B.11)

  /**
   * Settings → Reach → Your own relay: the owner pastes the link `mousse-relay init` or `enroll` printed. The helper
   * dials the relay pinned to the link's id and registers; pasting is also the owner's approval of that relay.
   */
  async enrollRelay(link: string): Promise<void> {
    const helper = this.relayHelper()
    const value = relayLink(link)
    if (!value)
      throw new NetError('bad_request', "That isn't a relay link.", { details: { reason: 'bad_link' } })
    let answer: Record<string, unknown>
    try {
      answer = await helper.request(
        'relay.enroll',
        { link: value },
        engineLimits().relayEnrollDeadlineMs
      )
    } catch (error) {
      throw relayError(error)
    }
    this.relayInfo(helper, answer.relay)
    this.rereadRelays()
  }

  /** Remove on one of this computer's relays: it stops registering there, and leaves the next invitations. */
  async removeRelay(relay: string): Promise<void> {
    const helper = this.relayHelper()
    try {
      await helper.request('relay.remove', { relay })
    } catch (error) {
      throw relayError(error)
    }
    if (this.helper === helper) this.relayView?.relays.delete(relay)
    this.changed()
    this.rereadRelays()
  }

  /** New relay key: a new registration key takes over, the old one kept until the overlap ends (§B.4, §B.11). */
  /** New relay key, or with `cancel` its Cancel while the relay has not taken the new key. */
  async rotateRelay(relay: string, cancel = false): Promise<void> {
    const helper = this.relayHelper()
    let answer: Record<string, unknown>
    try {
      answer = await helper.request('relay.rotate', cancel ? { relay, cancel: true } : { relay })
    } catch (error) {
      throw relayError(error)
    }
    this.relayInfo(helper, answer.relay)
  }

  /**
   * Allow on "<host> can be reached through relay <host:port>. Allow?" (§B.11), or Stop using relay on its row: the
   * pairing's relay route to `destination` is dialled from now on, or no longer. Only a destination that pairing's
   * relay info offers here is taken. Stopping is also Not now: the row does not ask about it again.
   */
  async allowRelay(node: NodeId, destination: string, allow: boolean): Promise<void> {
    const { row, parsed } = this.relayRoute(node, destination)
    const helper = this.relayHelper()
    try {
      await helper.request(allow ? 'peer.relay.allow' : 'peer.relay.disallow', {
        identity: row.endpoint,
        destination: parsed.destination
      })
    } catch (error) {
      throw relayError(error)
    }
    this.setDismissed(row.endpoint, parsed.destination, !allow)
    // The row changes at once; the read after it confirms.
    const peer = this.relayView?.peers.get(row.endpoint.toLowerCase())
    const route = peer?.routes.find((item) => item.destination === parsed.destination)
    if (route) {
      route.approved = allow
      if (allow) route.source = 'manifest'
      else delete route.source
    }
    this.changed()
    this.rereadRelays('peers')
  }

  /** Not now on a relay route's Allow? row: it is not asked about again, and it is not dialled. */
  dismissRelay(node: NodeId, destination: string): void {
    const { row, parsed } = this.relayRoute(node, destination)
    this.setDismissed(row.endpoint, parsed.destination, true)
    this.changed()
  }

  /** A pairing and one relay destination its relay info offers here; anything else is refused. */
  private relayRoute(node: NodeId, destination: string): { row: EnginePeerRow; parsed: { destination: string } } {
    const started = this.require()
    const row = started.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    this.refuseCutOff(node)
    const parsed = parseRelayDestination(destination)
    if (!parsed)
      throw new NetError('bad_request', "That isn't a relay.", { details: { reason: 'bad_destination' } })
    if (!offeredBy(this.relayView ?? undefined, row.endpoint, parsed.destination))
      throw new NetError('bad_request', `${row.name} doesn't offer that relay.`, {
        details: { reason: 'not_offered' }
      })
    return { row, parsed }
  }

  /** `relay-dismissed.json` in this profile's engine folder: the destinations not to ask about again. */
  private get dismissedPath(): string {
    return join(this.directory, 'relay-dismissed.json')
  }

  private dismissed(): Set<string> {
    if (this.relayDismissed) return this.relayDismissed
    let keys: string[] = []
    try {
      const value = JSON.parse(readFileSync(this.dismissedPath, 'utf8')) as { dismissed?: unknown }
      if (Array.isArray(value?.dismissed))
        keys = value.dismissed.filter((key): key is string => typeof key === 'string')
    } catch {
      // None yet.
    }
    this.relayDismissed = new Set(keys)
    return this.relayDismissed
  }

  private setDismissed(identity: string, destination: string, dismissed: boolean): void {
    const keys = this.dismissed()
    const key = dismissKey(identity, destination)
    if (keys.has(key) === dismissed) return
    if (dismissed) keys.add(key)
    else keys.delete(key)
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.dismissedPath, JSON.stringify({ dismissed: [...keys] }))
    } catch {
      // Kept for this run.
    }
  }

  // ---------------------------------------------------------------- version refusals (pair-with-IP design §5)

  /** `version-notices.json` in this profile's engine folder: the devices whose "needs a Mousse update" notice showed. */
  private get versionToldPath(): string {
    return join(this.directory, 'version-notices.json')
  }

  /** Each device's refusal (by identity) whose notice a window was given to show, by the refusal's `since`. */
  private told(): Map<string, number> {
    if (this.versionTold) return this.versionTold
    const told = new Map<string, number>()
    try {
      const value = JSON.parse(readFileSync(this.versionToldPath, 'utf8')) as { told?: unknown }
      if (value?.told && typeof value.told === 'object' && !Array.isArray(value.told))
        for (const [identity, since] of Object.entries(value.told as Record<string, unknown>))
          if (typeof since === 'number' && Number.isFinite(since)) told.set(identity, since)
    } catch {
      // None yet.
    }
    this.versionTold = told
    return told
  }

  private saveTold(): void {
    try {
      atomicWriteJsonSync(this.versionToldPath, { told: Object.fromEntries(this.told()) })
    } catch {
      // Kept for this run.
    }
  }

  /**
   * A window asks to show the "needs a Mousse update" notice of `node`'s refusal recorded at `since`: only the first
   * ask for the refusal that holds now is granted, so one window shows it, once, until that refusal clears. An ask for
   * an older or later refusal is refused.
   */
  claimVersionNotice(node: NodeId, since: number): { show: boolean } {
    const row = this.require().peers.get(node)
    if (!row || row.state === 'removed') throw new NetError('bad_request', 'Unknown device.')
    const identity = row.endpoint.toLowerCase()
    const told = this.told()
    if (this.refusals?.get(identity)?.since !== since || told.get(identity) === since) return { show: false }
    told.set(identity, since)
    this.saveTold()
    this.changed()
    return { show: true }
  }

  /** Forgets the last helper's refusals (a helper stopped, or another took over). */
  private dropRefusals(): void {
    this.refusals = undefined
    if (this.refusalTimer) clearTimeout(this.refusalTimer)
    this.refusalTimer = undefined
    if (this.refusalTicker) clearInterval(this.refusalTicker)
    this.refusalTicker = undefined
    this.refusalAgain = false
    this.refusalReadAt = 0
  }

  /** Reads the refusals every `refusalReadMs` while the helper has them. */
  private tickRefusals(helper: EngineHelper): void {
    if (!helper.has('version-refusals') || this.helper !== helper) return
    this.refusalTicker = setInterval(() => this.rereadRefusals(), engineLimits().refusalReadMs)
    this.refusalTicker.unref?.()
  }

  /** Reads the refusals again, when the helper lists `version-refusals`; requests meanwhile share one read. */
  private rereadRefusals(): void {
    if (!this.helper?.has('version-refusals')) return
    if (this.refusalReading) {
      this.refusalAgain = true
      return
    }
    if (this.refusalTimer) return
    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = undefined
      const helper = this.helper
      if (!helper) return
      this.refusalReading = this.readRefusals(helper)
        .catch(() => undefined)
        .finally(() => {
          this.refusalReading = undefined
          if (!this.refusalAgain) return
          this.refusalAgain = false
          this.rereadRefusals()
        })
    }, engineLimits().relayReadDebounceMs)
    this.refusalTimer.unref?.()
  }

  /**
   * Both lists carry the refusals: `peers.list` the devices this computer uses, `grants.list` those that use it.
   * Windows and the bridge hear only of a change: a pairing cut off goes offline for the bridge (its threads hidden,
   * kept), and one that agreed a version since comes back.
   */
  private async readRefusals(helper: EngineHelper): Promise<void> {
    const [peers, grants] = await Promise.all([helper.request('peers.list'), helper.request('grants.list')])
    if (this.helper !== helper) return
    this.refusalReadAt = Date.now()
    const before = this.refusals
    const after = readVersionRefusals(peers, grants)
    // A refusal that cleared takes its notice with it: a later refusal is told again.
    const told = this.told()
    const cleared = [...told].filter(([identity, since]) => after.get(identity)?.since !== since).map(([identity]) => identity)
    for (const identity of cleared) told.delete(identity)
    if (cleared.length) this.saveTold()
    if (before && sameRefusals(before, after)) return
    this.refusals = after
    this.changed()
    const started = this.started
    const bridge = this.options.bridge()
    if (!started || !bridge) return
    for (const row of started.peers.all()) {
      const identity = row.endpoint.toLowerCase()
      const was = !!before?.has(identity)
      if (was === after.has(identity)) continue
      if (!was) bridge.peerOffline(row.localId)
      else if (this.online(row.localId)) bridge.peerOnline(row.localId)
    }
  }

  /**
   * The refusals as a window last read them: read again when that read is older than `refusalFreshMs` (Settings
   * opening reads the status), as well as every `refusalReadMs` and after the events that may change one.
   */
  private freshRefusals(): void {
    if (Date.now() - this.refusalReadAt >= engineLimits().refusalFreshMs) this.rereadRefusals()
  }

  /** The helper running now, when it has relays. */
  private relayHelper(): EngineHelper {
    this.require()
    const helper = this.helper
    if (!helper) throw new NetError('peer_offline', 'Turn networking on first.')
    if (this.relayView === null)
      throw new NetError('bad_request', 'Update Mousse to use relays.', {
        details: { reason: 'no_relays' }
      })
    return helper
  }

  /** One own relay as the helper said it (`relay.enroll`, `relay.rotate`, `relay.state`). */
  private relayInfo(helper: EngineHelper, value: unknown): void {
    const relay = readRelayInfo(value, Date.now())
    if (!relay || this.helper !== helper) return
    this.relayView ??= { available: true, relays: new Map(), peers: new Map(), grants: new Map() }
    this.relayView.relays.set(relay.id, relay)
    this.changed()
  }

  /**
   * The helper's relay events: an own relay's state is applied; for the rest, only the list each one changes is
   * read again (a pairing's relay info: `peers.list`; who fits within the relay limit: `grants.list`).
   */
  private relayEvent(helper: EngineHelper, event: Record<string, unknown>): void {
    if (this.helper !== helper || this.relayView === null) return
    switch (event.ev) {
      case 'relay.state':
        return this.relayInfo(helper, event.relay)
      case 'peer.manifest':
      case 'peer.relay.offered':
        return this.rereadRelays('peers')
      // A caller key, or a pairing made or removed here, moves which callers fit within the relay limit.
      case 'peer.keys':
      case 'enrolled':
      case 'grant.closed':
        return this.rereadRelays('grants')
    }
  }

  /**
   * Reads the named relay lists again: the requests of `relayReadDebounceMs` are gathered into one read of each list
   * asked for, one read at a time.
   */
  private rereadRelays(...lists: RelayList[]): void {
    if (!this.helper || this.relayView === null) return
    for (const list of lists.length ? lists : RELAY_LISTS) this.relayWanted.add(list)
    if (this.relayTimer || this.relayReading) return
    this.relayTimer = setTimeout(() => {
      this.relayTimer = undefined
      const helper = this.helper
      const wanted = new Set(this.relayWanted)
      this.relayWanted.clear()
      if (!helper || !wanted.size) return
      this.relayReading = this.readRelays(helper, wanted)
        .catch(() => undefined)
        .finally(() => {
          this.relayReading = undefined
          // Only the lists asked for meanwhile: none asked for would read all three.
          if (this.relayWanted.size) this.rereadRelays(...this.relayWanted)
        })
    }, engineLimits().relayReadDebounceMs)
    this.relayTimer.unref?.()
  }

  /**
   * The relay lists in `wanted`. A helper that refuses `relay.list` has no relays; one that fails it otherwise (just
   * started, busy) is asked again `relayReadRetryMs` later, at most `relayReadTries` times.
   */
  private async readRelays(helper: EngineHelper, wanted: Set<RelayList>): Promise<void> {
    let list: Record<string, unknown> | undefined
    if (wanted.has('relays') || this.relayView === undefined) {
      const { relayReadTries, relayReadRetryMs } = engineLimits()
      for (let attempt = 1; ; attempt++) {
        try {
          list = await helper.request('relay.list')
          break
        } catch (error) {
          if (this.helper !== helper) return
          if (helperCode(error) === 'unknown_op') {
            this.relayView = null
            this.changed()
            return
          }
          if (attempt >= relayReadTries) return
          await new Promise((resolve) => setTimeout(resolve, relayReadRetryMs))
          if (this.helper !== helper) return
        }
      }
    }
    const [peers, grants] = await Promise.all([
      wanted.has('peers') || this.relayView === undefined
        ? helper.request('peers.list').catch(() => undefined)
        : undefined,
      wanted.has('grants') || this.relayView === undefined
        ? helper.request('grants.list').catch(() => undefined)
        : undefined
    ])
    if (this.helper !== helper) return
    const before = this.relayView
    this.relayView = {
      available: list ? list.available !== false : (before?.available ?? true),
      relays: list ? readRelayList(list, Date.now()) : (before?.relays ?? new Map()),
      peers: peers ? readPeerRelays(peers) : (before?.peers ?? new Map()),
      grants: grants ? readGrantRelays(grants) : (before?.grants ?? new Map())
    }
    this.changed()
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
   * "Also share") goes in pairback beside this computer's LAN routes. `arrival: 'link'`: it came as a Send link
   * (§5.3), whatever its kind says. `back: false` pairs one way: this computer uses the other and lets nothing in.
   */
  async join(
    ticket: string,
    share: readonly string[] = [],
    arrival?: 'link',
    back = true
  ): Promise<EnginePeerRow> {
    const started = this.require()
    const allowed = this.shareable()
    const unknown = share.find((route) => !allowed.includes(route))
    if (unknown !== undefined)
      throw new NetError('bad_request', "That isn't one of this computer's addresses.", {
        details: { reason: 'bad_share' }
      })
    // Both ways: the other computer reaches this one the way this one reaches it, without a tick.
    const shared = back ? [...new Set([...this.sameWays(ticket), ...share])] : [...share]
    await this.tellName()
    routeSetupProbes()
    return started.pairing.join(ticket, {
      share: shared,
      ...(arrival ? { arrival } : {}),
      ...(back ? {} : { back: false })
    })
  }

  /** "How will it connect?": each way and whether a code made for it now would work (`routes.available`). */
  async waysAvailable(): Promise<NetEngineWayReadiness[]> {
    const helper = this.featured('route-readiness')
    const answer = await helper.request('routes.available')
    return (Array.isArray(answer.ways) ? answer.ways : []).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return []
      const way = (entry as Record<string, unknown>).way
      const state = (entry as Record<string, unknown>).state
      const reason = (entry as Record<string, unknown>).reason
      const routes = (entry as Record<string, unknown>).routes
      if (!isNetEngineWay(way) || (state !== 'ready' && state !== 'off' && state !== 'unavailable')) return []
      return [
        {
          way,
          state,
          ...(typeof reason === 'string' && reason ? { reason } : {}),
          routes: strings(Array.isArray(routes) ? routes : [])
        }
      ]
    })
  }

  /**
   * A pasted or scanned link, read without a byte on the network (`join.check`): which computer, and which of its
   * routes this computer could use.
   */
  async joinCheck(ticket: string, arrival: 'scan' | 'link'): Promise<NetEngineJoinCheck> {
    const facts = readTicket(ticket)
    const helper = this.featured('route-readiness')
    const answer = await helper.request('join.check', { ticket: facts.fragment, arrival })
    const hints = (Array.isArray(answer.hints) ? answer.hints : []).flatMap(
      (entry: unknown): NetEngineJoinHint[] => {
        if (!entry || typeof entry !== 'object') return []
        const hint = entry as Record<string, unknown>
        if (typeof hint.route !== 'string') return []
        const eligibility =
          hint.eligibility === 'automatic' || hint.eligibility === 'approval_required'
            ? hint.eligibility
            : 'skip'
        const local =
          hint.local === 'interface_present' || hint.local === 'no_matching_interface'
            ? hint.local
            : 'unknown'
        return [
          {
            route: hint.route,
            way: isNetEngineWay(hint.way) ? hint.way : null,
            eligibility,
            ...(typeof hint.reason === 'string' && hint.reason ? { reason: hint.reason } : {}),
            local
          }
        ]
      }
    )
    return {
      kind: typeof answer.kind === 'number' ? answer.kind : (facts.kind ?? 1),
      ...(facts.name ? { name: facts.name } : {}),
      hints
    }
  }

  /** The probes running, by the window call that asked: Check again or a closed dialog cancels its own. */
  private readonly probes = new Map<string, number>()

  /**
   * Whether that computer answers from here (`join.probe`): only private addresses and the hints the person approved
   * are dialled, at most the helper's bound. `reachable: true` is the only answer that claims it can be reached.
   */
  async joinProbe(
    ticket: string,
    arrival: 'scan' | 'link',
    signal?: AbortSignal
  ): Promise<NetEngineJoinProbe> {
    const facts = readTicket(ticket)
    const helper = this.featured('join-probe')
    const key = facts.hash
    const earlier = this.probes.get(key)
    if (earlier) void helper.request('join.probe.cancel', { probe: earlier }).catch(() => undefined)
    let id: number | undefined
    const cancel = (): void => {
      if (id !== undefined) void helper.request('join.probe.cancel', { probe: id }).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const answer = await helper.requestWithId(
        'join.probe',
        // Nothing approved yet: Connect approves the ticket's destinations, so a check dials private ones only.
        { ticket: facts.fragment, arrival },
        engineLimits().joinProbeDeadlineMs,
        (sent) => {
          id = sent
          this.probes.set(key, sent)
        }
      )
      if (answer.reachable === true && typeof answer.route === 'string')
        return {
          reachable: true,
          route: answer.route,
          ...(typeof answer.ms === 'number' ? { ms: answer.ms } : {})
        }
      const reason = typeof answer.reason === 'string' ? answer.reason : 'unknown'
      return answer.reachable === false ? { reachable: false, reason } : { reachable: null, reason }
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (id !== undefined && this.probes.get(key) === id) this.probes.delete(key)
    }
  }

  /** Check again, or a dialog closed: the probe running for that link stops. Answers whether one was running. */
  async cancelProbe(ticket: string): Promise<boolean> {
    const key = readTicket(ticket).hash
    const id = this.probes.get(key)
    if (id === undefined || !this.helper) return false
    this.probes.delete(key)
    const answer = await this.helper.request('join.probe.cancel', { probe: id }).catch(() => ({}))
    return (answer as Record<string, unknown>).cancelled === true
  }

  /** The helper, when it lists `feature`; otherwise the window falls back to what it showed before. */
  private featured(feature: EngineFeature): EngineHelper {
    this.require()
    const helper = this.helper
    if (!helper) throw new NetError('peer_offline', 'Networking is starting.')
    if (!helper.has(feature))
      throw new NetError('bad_request', 'Update networking for this.', {
        details: { reason: 'not_supported' }
      })
    return helper
  }

  // ---------------------------------------------------------------- Add over SSH (Phase 1b §3.4)

  /**
   * Set by the daemon: B's SSH request journal, this profile's selector, and the lock of a remote computer that its
   * prepares (on any profile) and its removals here share (§3.6).
   */
  sshHost?: {
    requests: SshRequestStore
    selector(): string
    locked<T>(joiner: string, work: () => Promise<T>): Promise<T>
  }
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
      now: () => Date.now() / 1000,
      park: (node, why) => this.started?.pairing.park(node, why),
      trusted: (routeId, host) => {
        // Only the pairings whose SSH route goes to that host: another host's key is still unchecked.
        const started = this.started
        for (const row of started?.peers.all() ?? [])
          if (row.ssh && (row.ssh.routeId === routeId || (!!host && row.ssh.host === host)))
            started!.pairing.unpark(row.localId)
      }
    })
    return this.sshFlow
  }

  /**
   * Connect in Add over SSH (§3.4 step 3). A computer this one already pairs with only gets the SSH route: it holds
   * B's pin and is granted already (§3.4, "SSH connections per add").
   */
  async sshConnect(choice: Parameters<SshAdd['connect']>[0]): Promise<EnginePeerRow> {
    const started = this.require()
    // Route setup, whichever way it goes: a computer already paired gets only the SSH route.
    routeSetupProbes()
    // The list session 1 answered in this add: Connect signs in once more only for prepare (§3.4: four
    // connections per add).
    const profile = choice.selector
      ? this.sshAdd()
          .listedProfiles(choice.routeId)
          ?.profiles.find((item) => item.selector === choice.selector)
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
        shell: choice.shell ?? this.sshAdd().shellFor(choice.routeId)
      }
      started.peers.update(paired.localId, { ssh })
      await this.setAddresses({ ...paired, ssh }, paired.addresses ?? [])
      return started.peers.get(paired.localId)!
    }
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
      ...(this.leak ? { listener: this.leak.route } : {}),
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
        // A computer that added this one over SSH starts at Full control (its grant is `owner`); a later change of
        // its level moves its role like any other row's. Saved before the grant, so the role is never the wider.
        started.rt.policy.set(row.localId, accessPreset('full').fields)
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
      },
      rowState: (key) => started.peers.get(key as NodeId)?.state
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
      } else if (!request || now - request.issuedAt > maxAge)
        void this.expireSshRow(row).catch(() => undefined)
    }
    this.changed()
  }

  /**
   * B: an `ssh_granting` row whose request is gone or past its age (§3.6), under the lock of that computer. A grant
   * the request saved before recording it is found by identity and receipt and removed, the request reads
   * `removed`, then the row goes: nothing is left for host recovery to take for an owed pairing.
   */
  private async expireSshRow(row: EnginePeerRow): Promise<void> {
    const host = this.sshHost
    const started = this.started
    if (!host || !started || !row.endpoint) return
    await host.locked(row.endpoint, async () => {
      const helper = this.helper
      const now =
        this.started === started && !started.ending ? started.peers.get(row.localId) : undefined
      if (!helper || now?.state !== 'ssh_granting') return
      const requestId = now.ssh?.requestId
      if (requestId) {
        const listed = await helper.request('grants.list')
        for (const grant of Array.isArray(listed.grants) ? listed.grants : [])
          if (grant?.identity === now.endpoint && grant.receipt === requestId)
            await helper.request('grant.remove', { grant: grant.grant })
        if (host.requests.get(requestId)) host.requests.update(requestId, { state: 'removed' })
      }
      if (this.started !== started || started.ending) return
      started.peers.prune(now.localId)
      this.changed()
    })
  }

  /** What a ticket would do before Connect (§1.3): its destinations by class, and what this computer may share. */
  joinPreview(ticket: string): NetEngineJoinPreview {
    const facts = readTicket(ticket)
    const loopback = !packagedBuild()
    return {
      ...(facts.name ? { name: facts.name } : {}),
      kind: facts.kind ?? 1,
      invitation: facts.invitation,
      ...(facts.expiresAt !== undefined && facts.expiresAt * 1000 <= Date.now()
        ? { expired: true }
        : {}),
      // A loopback hint a check maps to another class reads as that class, and needs Connect as it would.
      destinations: ticketDestinations(facts.routes, loopback).map((item) => {
        const mapped = loopbackClass(item.route)
        return { ...item, ...(mapped ? { cls: mapped } : {}), automatic: automatic(item.route) }
      }),
      sameWay: this.sameWays(ticket).flatMap((route) => this.shareEntry(route)),
      shareable: this.shareable()
        .filter((route) => !this.sameWays(ticket).includes(route))
        .flatMap((route) => this.shareEntry(route))
    }
  }

  /** One of this computer's routes as the Connect dialog shows it, with its class; none for a forbidden one. */
  private shareEntry(route: string): Array<{ route: string; label: string; cls: RouteClass }> {
    const parsed = parseRoute(route)
    const cls = loopbackClass(route) ?? (parsed ? routeClass(parsed) : 'forbidden')
    return cls === 'forbidden' ? [] : [{ route, label: routeText(route), cls }]
  }

  /**
   * This computer's routes of the kinds the ticket reaches the other computer by (§1.3): a computer reached over
   * Tailscale reaches this one over Tailscale too. With "Also let" they go in pairback without a tick, beside the LAN
   * routes that always go; the other kinds stay under "Also share".
   */
  private sameWays(ticket: string): string[] {
    let hints: string[]
    try {
      hints = readTicket(ticket).routes
    } catch {
      return []
    }
    const kinds = new Set<string>(
      ticketDestinations(hints, !packagedBuild())
        .map((item) => loopbackClass(item.route) ?? item.cls)
        .filter((cls) => cls !== 'relay' && cls !== 'lan')
    )
    return this.shareable().filter((route) => this.shareEntry(route).some((entry) => kinds.has(entry.cls)))
  }

  /** The other computer of a pairing: its endpoint id and name, for "Remove on all my hosts". */
  device(node: NodeId): { identity: string; name: string } {
    const row = this.require()
      .peers.all()
      .find((r) => r.localId === node && r.state !== 'removed')
    if (!row) throw new NetError('bad_request', 'No such device.')
    return { identity: row.endpoint, name: row.name }
  }

  /** A paired computer's name by its endpoint id. */
  private peerName(identity: string): string | undefined {
    return this.started?.peers.all().find((r) => r.endpoint === identity && r.state !== 'removed')
      ?.name
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
    this.refuseCutOff(node)
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
    this.refuseCutOff(node)
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
    this.refuseCutOff(node)
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
    // The owner changed how it is reached: a parked SSH login may be tried again.
    started.pairing.unpark(row.localId)
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

  /** Asking for, and answering, the other direction of a one-way pairing (§7). */
  access(): EngineAccess {
    return this.require().access
  }

  /**
   * The routes checks' `route-leak` control (1b §14): a second loopback address of this helper, a forwarder to its
   * listener on a port the checks' class map leaves out, so a route other than the one under test answers. Pairback
   * and Add over SSH offer it first. A helper told to listen off loopback (a cross-machine cell's host, whose
   * computer the other one dials) gets it on every interface, named by this computer's private address.
   */
  private leak?: { port: number; route: string; close(): void }

  private async openLeak(helper: EngineHelper): Promise<void> {
    const port = helper.info.port
    if (typeof port !== 'number' || this.leak?.port === port) return
    this.leak?.close()
    const open = new Set<Socket>()
    const server = createNetServer((socket) => {
      const plain = netConnect(port, '127.0.0.1')
      for (const one of [socket, plain]) {
        open.add(one)
        one.on('close', () => open.delete(one))
        one.on('error', () => undefined)
      }
      socket.pipe(plain).pipe(socket)
    })
    const lan = offLoopback() ? privateAddress() : undefined
    // Off loopback, every interface without naming one (a named address takes a lookup).
    await new Promise<void>((done) => (lan ? server.listen(0, done) : server.listen(0, '127.0.0.1', done)))
    const route = `tcp://${lan ?? '127.0.0.1'}:${(server.address() as { port: number }).port}`
    this.leak = {
      port,
      route,
      close: () => {
        for (const socket of open) socket.destroy()
        server.close()
      }
    }
  }

  /**
   * The `route-leak` control on a helper told to listen off loopback (a cross-machine cell's host, 1b §14): LAN
   * goes on before an invitation, so its ticket offers this computer's LAN addresses, which a joiner dials before
   * any other route. Checks on one computer keep every listener on loopback and leak through pairback instead.
   */
  async leakBeforeInvite(): Promise<void> {
    if (!engineControl('route-leak') || !offLoopback() || this.reach()?.lan !== false) return
    const { restarted } = await this.setReach({ lan: true })
    const until = Date.now() + 30_000
    while (restarted && (!this.helper || this.helperStatus().state !== 'running')) {
      if (Date.now() > until)
        throw new NetError('deadline_exceeded', 'Networking did not start in time.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * A helper that has never saved its routes listens as its command line says and, on every interface, offers every
   * address it has, tailnet ones too, whatever Reach shows. When it offers one whose switch is off, what Reach shows
   * is saved (`routes.config`), so invitations offer only routes whose switch is on.
   */
  private async keepShownReach(helper: EngineHelper): Promise<void> {
    if (!helper.speaks(1)) return
    const reach = readReach(helper.info.routes_config, helper.info)
    const offered = strings(helper.info.routes)
    const switchedOff = offered.some((route) => {
      const parsed = parseRoute(route)
      if (!parsed || parsed.kind !== 'tcp') return false
      const cls = routeClass(parsed)
      return (
        (cls === 'tailnet' && !reach.tailnet) ||
        (cls === 'lan' && !reach.lan) ||
        (cls === 'public' && !reach.public.includes(parsed.canonical))
      )
    })
    if (!switchedOff) return
    const answer = await helper.request('routes.config', {
      lan: reach.lan,
      tailnet: reach.tailnet,
      public: reach.public,
      tunnels: reach.tunnels
    })
    if (answer.config && typeof answer.config === 'object') helper.info.routes_config = answer.config
    if (Array.isArray(answer.routes)) helper.info.routes = strings(answer.routes)
    this.changed()
    if (answer.restart_needed === true) await this.restartHelper()
  }

  /** Retry on a device's row: its ceremony or removal goes on, and it is dialled. */
  async retry(node: NodeId): Promise<void> {
    const started = this.require()
    const row = started.peers.get(node)
    if (!row || row.state === 'removed') throw new NetError('bad_request', 'Unknown device.')
    if (row.state === 'removing') return started.pairing.remove(node)
    // The owner's Retry is what a parked SSH login waits for (§1.4).
    started.pairing.unpark(node)
    if (started.pairing.linkUnfinished(node)) {
      await started.pairing.retryLink(node)
      return
    }
    if (row.state !== 'connected' && row.state !== 'awaiting_pairback')
      await started.pairing.advance(node)
    // A computer only let in is dialled by nothing here: it connects when it uses this one.
    if (row.ways === 'in') return
    // Check again on a pairing cut off for its version: the helper's own dial, at once, even while a session from
    // before the refusal is still up (and with no connection the other computer dialled standing in for it).
    if (this.cutOff(node) && this.helper && row.state !== 'consented') {
      await this.helper.request('dial', { identity: row.endpoint }).catch(() => undefined)
      this.rereadRefusals()
      return
    }
    if (!started.sessions.online(node) && this.helper && row.state !== 'consented') {
      // Also Check again on a device cut off for its version: a dial refused for version records the refusal (it
      // raises no event), one that agrees a version clears it.
      await this.helper.dial(row.endpoint).catch(() => undefined)
      this.rereadRefusals()
    }
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
        // A pairing made one way has the direction its row keeps.
        const ssh = row.source === 'ssh'
        const direction = ssh ? (row.ssh?.routeId ? 'out' : 'in') : row.ways
        const up = direction === 'out' ? online : direction === 'in' ? serving : online && serving
        // Connected only with both directions up: this computer's client to it, and its client here.
        const state =
          row.state === 'removing'
            ? 'removing'
            : ssh && row.state !== 'connected' && row.state !== 'removed'
              ? 'connecting'
              : row.state !== 'connected'
                ? 'finishing'
                : up
                  ? 'connected'
                  : online || serving
                    ? 'connecting'
                    : 'offline'
        // A Send link join waiting for its code is a person's wait, not a stuck pairing.
        const stuck =
          held(`${node} finishing`, state === 'finishing' && !started.pairing.linkJoining(node)) >=
          stuckMs
        // One direction down for the bound while the other works.
        const paired = row.state === 'connected' && !direction
        const outDown = held(`${node} out`, paired && !online) >= stuckMs
        const inDown = held(`${node} in`, paired && !serving) >= stuckMs
        const unreachable = outDown && serving ? 'out' : inDown && online ? 'in' : undefined
        // The class of the route its connection came up on (§7 `conn.up.route`), this computer's dial first; a
        // relay connection names its relay.
        const connectedOn = started.sessions.route(node)
        const route = connectedOn?.kind === 'relay' ? 'relay' : (connectedOn?.class as NetEngineDevice['route'])
        const via = connectedOn?.kind === 'relay' && connectedOn.destination ? relayText(connectedOn.destination) : undefined
        const relay = this.relayView
          ? deviceRelay(this.relayView, row.endpoint, now, this.dismissed(), engineLimits().relayOffersShown)
          : undefined
        const other = started.access.other(row)
        // The ticket's approved hints beyond the same network (LAN ones are found automatically anyway).
        const approvedAddresses = (row.approved ?? []).filter((address) => {
          const parsed = parseRoute(address)
          const cls = parsed && routeClass(parsed)
          return !!cls && cls !== 'forbidden' && cls !== 'lan' && !row.addresses?.includes(address)
        })
        const listsError = this.options.bridge()?.lists.lastError(node)
        const identity = row.endpoint.toLowerCase()
        const refusal = this.refusals?.get(identity)
        const cutOff = needsUpdate(refusal, refusal !== undefined && this.told().get(identity) === refusal.since)
        return {
          node,
          name: row.name,
          shortId: row.endpoint.slice(0, 8),
          ...(started.pairing.accepted(node) && !row.ssh?.removed ? {} : { notAccepted: true }),
          ...(direction ? { direction } : {}),
          // Its app does not know one-way pairing. Used one way: its own row waits to be let in here. Only let in:
          // its pairback adds nothing, so this computer uses it once it is added from here.
          ...(!ssh &&
          ((row.ways === 'out' && started.sessions.says(node, 'one-way') === false) ||
            (row.ways === 'in' && started.pairing.callerSays(node, 'one-way') === false))
            ? { olderApp: true }
            : {}),
          state,
          online,
          ...(stuck ? { stuck: true } : {}),
          ...(unreachable ? { unreachable } : {}),
          ...(started.pairing.certificateWindow(node) ? { certificateWindow: true } : {}),
          ...(listsError ? { listsError } : {}),
          ...(started.roles.pending(node) ? { accessPending: true } : {}),
          ...(started.pairing.sshParked(node) ? { sshParked: started.pairing.sshParked(node) } : {}),
          ...(row.addresses?.length ? { addresses: row.addresses } : {}),
          ...(approvedAddresses.length ? { approvedAddresses } : {}),
          ...(row.ssh && !row.ssh.removed && (row.ssh.target || row.ssh.host)
            ? { ssh: row.ssh.target || (row.ssh.user ? `${row.ssh.user}@${row.ssh.host}` : row.ssh.host!) }
            : {}),
          ...(route ? { route } : {}),
          ...(via ? { via } : {}),
          ...(row.offered?.length ? { offered: row.offered } : {}),
          ...(row.source ? { source: row.source } : {}),
          ...(started.pairing.linkUnfinished(node)
            ? {
                unfinished: true,
                ...(row.link?.expiresAt === undefined || row.link.expiresAt * 1000 > now
                  ? { linkValid: true }
                  : {})
              }
            : {}),
          ...(relay ? { relay } : {}),
          ...(other ? { other } : {}),
          ...(cutOff ? { needsUpdate: cutOff } : {})
        }
      })
    for (const key of [...this.since.keys()]) if (!seen.has(key)) this.since.delete(key)
    // A pairing's relay info going stale shows then too.
    const stale = this.relayView ? nextStale(this.relayView, now) : undefined
    this.wakeWhenStuck(now, stuckMs, stale)
    return devices
  }

  /**
   * A condition that has not shown yet shows once it has held for the bound, and relay info once it goes stale
   * (`also`): the windows read again then.
   */
  private wakeWhenStuck(now: number, stuckMs: number, also?: number): void {
    const due = [...this.since.values()].map((at) => at + stuckMs).filter((at) => at > now)
    if (also !== undefined && also > now) due.push(also)
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = undefined
    if (!due.length || !this.started) return
    this.stuckTimer = setTimeout(
      () => {
        this.stuckTimer = undefined
        this.changed()
      },
      // A timer's longest wait is about 24 days; one due later is set again when it fires.
      Math.min(Math.min(...due) - now + 50, 2 ** 31 - 1)
    )
    this.stuckTimer.unref?.()
  }

  /** Tells the windows to read the status again. */
  private changed(): void {
    try {
      // Each open access exchange says what this computer grants the other one now, when that changed.
      this.started?.access.refresh()
    } catch {
      // Said again on the next change.
    }
    try {
      // The rows' conditions are timed from the change that began them.
      if (this.started) this.devices()
    } catch {
      // Stopping: its database closed already.
    }
    try {
      // A pairing added, renamed or removed: the editor aliases follow (only when the list itself changed).
      const computers = JSON.stringify(this.editorComputers())
      if (this.started && computers !== this.aliasedComputers) {
        this.aliasedComputers = computers
        this.options.net.engineComputersChanged()
      }
    } catch {
      // Read again on the next change.
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
    const rt = typeof net.ensureEngineRuntime === 'function' ? await net.ensureEngineRuntime() : net.runtime()
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
    /**
     * A pairing's row while this run of the engine is on. A helper's pipe can close after the profile's database
     * did (the app stopping): then there is none.
     */
    const liveRow = (node: NodeId): EnginePeerRow | undefined => {
      if (this.started?.peers !== peers || this.started.ending) return undefined
      try {
        return peers.get(node)
      } catch {
        return undefined
      }
    }
    // Each grant's role follows its device's level here (§8); a narrowing stops serving the device first.
    const roles = new EngineRoles({
      peers,
      helper: () => this.helper,
      level: (node) => rt.policy.get(node),
      stopServing: (node) => this.stopServing(node),
      changed: () => this.changed()
    })
    const grantRole = (node: NodeId | undefined, access?: AccessPresetFields): string =>
      roleForLevel(
        access
          ? { ...access, blocked: node ? rt.policy.get(node).blocked : false }
          : node
            ? rt.policy.get(node)
            : DEFAULT_LEVEL
      )
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
        pairback: (caller, request) => pairing.pairback(caller, request),
        tunnel: (connection, stream) => editor.accept(connection, stream),
        // Bot streams and bot calls ride on the bot labels alone (`mousse.botsub`, `mousse.botrpc`), and a bot's
        // browser view on its own (`mousse.botview`), served by the Bridge under the bot level and the bot's Devices.
        botStream: (stream) => isBotStreamKind(bridge().threads.privateAccess(stream)?.kind),
        callMethod: (id, caller) => rt.rpc.methodOf(id, caller),
        botview: (connection, stream) => {
          const views = bridge().botViews
          if (!views) return stream.reset('not_supported')
          views.accept(this.callerOf(connection).node, stream)
        },
        calledBy: (caller, name, features) => {
          pairing.heard(caller.node, features)
          pairing.named(caller.node, name)
        },
        features: () => access.features(),
        access: {
          open: (caller, connection, channel) => access.opened(caller.node, connection, channel),
          message: (caller, _channel, header) => access.receive(caller.node, header)
        }
      },
      client: {
        get store() {
          return bridge().threads.store
        },
        verify: (stream, _record, _snapshot, client) => this.verifyIngest(stream, client),
        features: () => access.features()
      },
      hooks: {
        onClientReady: (node) => {
          this.options.bridge()?.peerOnline(node)
          void this.askPeerInfo(node)
          pairing.clientReady(node)
          access.ensure(node)
          // A: its first live connection to B confirms an SSH add (1b §3.4 step 6).
          // Stopping: the store is closed, and nothing is written.
          const row = liveRow(node)
          if (row?.source === 'ssh' && row.state === 'ssh_granted') this.sshAdd().connected(row)
          this.changed()
        },
        onClientClosed: (node) => {
          this.options.bridge()?.peerOffline(node)
          this.notePeer((presence) => presence.seen(node))
          this.changed()
        },
        onServingChanged: (node) => {
          // A pairing that can no longer reach this computer keeps no editor tunnel here.
          editor.reconcile()
          // Nor a bot's browser it took over: the bot has it back at once.
          if (!sessions.serving(node)) this.options.bridge()?.botViews.releaseNode(node)
          // B: A's first live inbound with the row's grant connects it ("Added over SSH from <A>").
          const row = liveRow(node)
          if (
            row?.source === 'ssh' &&
            row.state === 'ssh_granted' &&
            !row.ssh?.routeId &&
            !!row.grant &&
            sessions.serving(node, row.grant)
          )
            peers.advance(node, ['ssh_granted'], { state: 'connected' })
          this.changed()
        },
        // The other computer said this computer's role there: the helper's record of it follows (§8.4).
        onRoleThere: (node, role) => void roles.recordThere(node, role),
        // The helper keeps a newer outbound path (renewed, or dialled while one was up) waiting until told.
        onPathInUse: (connection) => {
          // The access exchange follows the client to the path it uses now.
          access.ensure(connection.peer)
          // The row names the route in use, which may have changed (to the same network, say).
          this.changed()
          const conn = Number(connection.id)
          if (!Number.isSafeInteger(conn) || !this.helper || connection.reversed) return
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
    const rights: EngineEditorRights = {
      on: () => this.started?.rt === rt,
      row: (node) => peers.serving(node),
      blocked: (node) => rt.policy.get(node).blocked,
      connected: (node) => sessions.serving(node),
      workOnThreads: () => net.nodePolicyConfig().workOnThreads !== false,
      editor: (node) => rt.policy.get(node).editor
    }
    const editor = new EngineEditor({
      rt,
      directory: this.directory,
      rights,
      devices: () =>
        peers
          .all()
          .map((row) => row.localId)
          .filter((node) => engineEditorRefusal(rights, node) === undefined),
      useSystemSsh: () => net.editorUsesSystemSsh(),
      onFirstOpen: (node) => net.editorFirstOpened(node),
      ...(this.editorTest ? { test: this.editorTest } : {})
    })
    const pairing: EnginePairing = new EnginePairing({
      peers,
      sessions,
      helper: () => this.helper,
      teardown: (node) => this.teardown(node),
      endServing: (node) => this.endInbound(node),
      // The access the owner picked in Allow, saved under the id its row takes before its grant exists.
      applyAccess: (node, access: AccessPresetFields) => {
        rt.policy.set(node, access)
      },
      copyAccess: (from, to) => {
        const saved = rt.policy.list().find((policy) => policy.node === from)
        if (saved)
          rt.policy.set(to, {
            work: saved.work,
            terminal: saved.terminal,
            editor: saved.editor,
            maxPermissionMode: saved.maxPermissionMode,
            agentReach: saved.agentReach,
            bots: saved.bots
          })
      },
      grantRole,
      followRole: (node) => roles.follow(node),
      changed: () => this.changed(),
      crashAt: (step) => !!this.pairingCrash?.(step),
      sshRequest: (receipt) => this.sshHost?.requests.get(receipt)?.state,
      // A removal of a computer and its SSH prepares here take one lock: neither undoes the other (§3.6).
      leakedRoute: () => this.leak?.route,
      exclusive: (endpoint, work) =>
        this.sshHost && endpoint ? this.sshHost.locked(endpoint, work) : work(),
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
    const access: EngineAccess = new EngineAccess({
      peers,
      sessions,
      helper: () => this.helper,
      callerSays: (node, feature) => pairing.callerSays(node, feature),
      applyAccess: (node, fields) => {
        rt.policy.set(node, fields)
      },
      grantRole: (node) => grantRole(node),
      followRole: (node) => roles.follow(node),
      // Over the other computer's own connection: this computer holds no address of it.
      dial: async (node) => {
        const row = peers.serving(node)
        if (row && this.helper && !sessions.online(node)) await this.helper.dial(row.endpoint)
      },
      served: async (node) => {
        const row = peers.serving(node)
        return !!row && !!this.helper && (await this.helper.served(row.endpoint))
      },
      release: (node) => {
        const row = peers.serving(node)
        if (row) this.helper?.dropCallBack(row.endpoint)
        sessions.closeClients(node, 'peer_forgotten')
      },
      checkpoint: (step) => pairing.checkpoint(step),
      changed: () => this.changed()
    })
    const timer = setInterval(() => {
      try {
        this.renew()
      } catch {
        // Tried again on the next tick; the host keeps serving on its current delegation until it lapses.
      }
    }, engineLimits().renewIntervalMs)
    timer.unref?.()
    // A block, a device's editor switch, the work switch: tunnels without the right end at once.
    const release = [
      rt.policy.onChange(() => editor.reconcile()),
      net.onWorkOnThreadsOff(() => editor.reconcile())
    ]
    this.started = { rt, peers, sessions, timer, revocations, pairing, access, roles, editor, rights, release }
    net.setEngineAuthorizer((method, caller, capability) =>
      this.authorizeEngine(method, caller, capability)
    )
    net.setEngineEditor({
      owns: (node) => this.started?.editor === editor && !!peers.get(node),
      computers: () => (this.started?.editor === editor ? this.editorComputers() : []),
      link: (node) => {
        if (this.started?.editor !== editor || !peers.serving(node) || !sessions.online(node))
          throw new TunnelError('offline')
        return { tunnels: editor.tunnels, link: editor.clientLink(node, sessions.client(node)) }
      }
    })
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
      // An installed app runs only the helper it was packaged with (`launchBuilt` reads which).
      expectedBuild: () => (this.launcher ? undefined : this.packagedCommit),
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
    this.packagedCommit = packagedBuild() ? packagedHelperCommit(binary) : undefined
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
    try {
      this.onSwitched?.()
    } catch {
      // What reads the switch elsewhere catches up on its next change; the switch itself is saved.
    }
  }
  /** The switch was saved (on or off): the installation rewrites `endpoints.json`, which says it (Phase 1b §3.3). */
  onSwitched?: () => void

  /** The endpoint goes aside; the next start makes a new one, and its pairings show "Pair again". */
  private setEndpointAside(why: string): void {
    if (existsSync(this.endpointPath))
      renameSync(this.endpointPath, `${this.endpointPath}.${why}-${Date.now()}`)
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined)
    if (this.started) this.started.ending = true
    await this.cloudflare.useOrigin(undefined)
    // A's Add over SSH holds this run's store: the next start (after Start over, say) makes its own.
    this.sshFlow?.dispose()
    this.sshFlow = undefined
    this.leak?.close()
    this.leak = undefined
    const supervisor = this.supervisor
    this.supervisor = undefined
    await supervisor?.stop()
    const started = this.started
    if (!started) return
    this.started = undefined
    this.own = undefined
    started.pairing.stop()
    started.access.stop()
    started.roles.stop()
    for (const release of started.release.splice(0)) release()
    this.options.net.setEngineEditor(undefined)
    // An ordinary end (a quit, a restart): editor servers keep running, as when an SSH server restarts.
    started.editor.tunnels.endAll('net_off', false)
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = undefined
    this.since.clear()
    this.helper?.close()
    this.helper = undefined
    this.relayView = undefined
    if (this.relayTimer) clearTimeout(this.relayTimer)
    this.relayTimer = undefined
    this.relayWanted.clear()
    this.dropRefusals()
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
    // The editor rows answer as the editor tunnel would (§9.2); the ask to turn the editor on works while it is off.
    if (method.method.startsWith('routed.editor.')) {
      const why = engineEditorRefusal(started.rights, caller.node, caller.grant)
      if (why && !(why === 'editor_off' && method.method === 'routed.editor.ask')) {
        // In the words a routed refusal has (`FORBIDDEN_REASONS`); the editor switch has none of its own there.
        const reason = why === 'net_off' ? 'not_connected' : why === 'editor_off' ? undefined : why
        throw new NetError('forbidden', undefined, reason ? { details: { reason } } : undefined)
      }
    }
  }

  /**
   * `bridge.policy` for an engine pairing: what it may do here, kept in the same table as v1 devices'. The level is
   * the truth and the grant's role follows it, ordered so a stop in between can only leave the role narrower
   * (`EngineRoles.change`). A role not applied (no helper, one without roles, an edit that failed) is an error here
   * and stays on the row until it is applied.
   */
  async setPolicy(node: NodeId, change: NodePolicyChange): Promise<{ policy: BridgeNodePolicy }> {
    const started = this.require()
    if (!started.peers.serving(node)) throw new NetError('bad_request', 'Unknown device.')
    this.refuseCutOff(node)
    let saved: NodePolicy | undefined
    const next = levelAfter(started.rt.policy.get(node), change)
    const applied = await started.roles.change(node, next, () => {
      saved = started.rt.policy.set(node, change)
    })
    if (!applied)
      throw started.roles.reason(node) === ROLES_UNSUPPORTED
        ? new NetError('peer_offline', 'Saved, but networking needs an update to apply it.', {
            details: { reason: 'role_unsupported' }
          })
        : new NetError('peer_offline', "Saved, but networking hasn't applied it yet. Retrying.", {
            details: { reason: 'role_pending' }
          })
    return { policy: policyView(saved!) }
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
          // A computer only let in is not used from here: no client of it rides its connections.
          return {
            node: row.localId,
            grant: row.grant,
            endpoint: row.endpoint,
            ...(row.ways === 'in' ? { uses: false } : {})
          }
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
    this.relayView = undefined
    this.relayWanted.clear()
    this.dropRefusals()
    helper.onEvent((event) => started.pairing.event(event))
    helper.onEvent((event) => this.relayEvent(helper, event))
    helper.onEvent((event) => {
      if (this.helper === helper && refusalMayChange(event)) this.rereadRefusals()
    })
    helper.onPaused(() => this.changed())
    helper.channel.onClose(() => {
      if (this.helper !== helper) return
      this.helper = undefined
      this.relayView = undefined
      this.dropRefusals()
      void this.cloudflare.useOrigin(undefined)
    })
    const told = this.selfName()
    await helper.hello()
    // Straight after the hello, before the helper reads as running: every grant's role follows its device's level
    // (a role an older build made `owner` under a lower level, or a write that failed). One not applied stays
    // pending on its row and is tried again until it is.
    if (this.helper === helper) await started.roles.followAll().catch(() => undefined)
    this.plus.attach(helper)
    this.toldName = told
    this.changed()
    // Its relays, and what each pairing's relays need (Phase 3); a helper without them says so once.
    if (this.helper === helper) this.rereadRelays()
    // Which devices are cut off for their version, as this helper recorded them (kept across its restarts).
    if (this.helper === helper) this.rereadRefusals()
    // A device refused coming in again within the helper's hour between notices raises no event: read on a timer too.
    if (this.helper === helper) this.tickRefusals(helper)
    if (this.helper === helper) await this.keepShownReach(helper).catch(() => undefined)
    // A helper that takes a managed tunnel lists `managed-tunnel`; `managed_tunnel` in its hello says its local
    // origin runs now (false when the port could not bind).
    if (this.helper === helper && helper.has('managed-tunnel') && helper.info.managed_tunnel === true &&
        typeof helper.info.ws_port === 'number' && helper.info.ws_port > 0 && helper.info.ws_port <= 65535) {
      void this.cloudflare.useOrigin({
        port: helper.info.ws_port,
        test: async (route) =>
          this.helper === helper && (await this.testRoute(route)).ok && this.helper === helper,
        advertise: async (route) => {
          if (this.helper !== helper) throw new NetError('peer_offline')
          const answer = await helper.request('routes.managed_tunnel', { route })
          if (this.helper !== helper) throw new NetError('peer_offline')
          helper.info.routes = strings(answer.routes)
          this.changed()
        }
      })
    }
    // Removals finish, ceremonies resume, owed rows are written and every pairing is dialled again.
    if (this.helper === helper) {
      if (engineControl('route-leak')) await this.openLeak(helper)
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
    // Its editor tunnels end and what the endpoint started for it stops (its row is removing, or its grant gone).
    started.editor.reconcile()
    this.options.bridge()?.releaseNode(node)
  }

  /**
   * Before its grant narrows (§8.3): what this computer runs for the device ends (its calls, subscriptions,
   * private streams and terminals), as at a revocation. Its connections stay: the helper's role edit closes them,
   * and the device connects again under the new role.
   */
  private stopServing(node: NodeId): void {
    const started = this.started
    if (!started) return
    started.revocations.get(node)?.abort()
    started.revocations.delete(node)
    started.rt.rpc.abortCaller(node)
    started.sessions.endServing(node)
    started.editor.reconcile()
    this.options.bridge()?.releaseNode(node)
  }

  /**
   * One direction removed (it no longer uses this computer): what it runs here ends as a revocation's does, and its
   * connections here close; this computer's own clients of it stay. Idempotent.
   */
  endInbound(node: NodeId): void {
    const started = this.started
    if (!started) return
    started.revocations.get(node)?.abort()
    started.revocations.delete(node)
    started.rt.rpc.abortCaller(node)
    started.sessions.closeHosts(node, 'grant_revoked')
    started.editor.reconcile()
    this.options.bridge()?.releaseNode(node)
  }

  // ---------------------------------------------------------------- the peer directory's engine half

  rows(): PeerRow[] {
    const started = this.started
    if (!started) return []
    const current = mousseVersion()
    return started.peers
      .all()
      .filter((row) => row.state !== 'removing' && row.state !== 'removed')
      .map((row) => {
        const online = started.sessions.online(row.localId)
        let seen: ReturnType<PeerPresence['get']>
        try {
          seen = this.presence(started).get(row.localId)
        } catch {
          // Presence is a convenience; the list works without it.
        }
        const standing = versionStanding(seen, current)
        const lastSeenAt = online ? Date.now() : seen?.lastSeenAt
        return {
          node: row.localId,
          name: row.name,
          caps: ['read', 'chat', 'write', 'terminal', 'settings'],
          kind: 'computer',
          policy: policyView(started.rt.policy.get(row.localId)),
          self: false,
          keeper: false,
          connection: online ? 'connected' : 'disconnected',
          routeHeld: false,
          revoked: false,
          state: online ? 'open' : 'closed',
          source: 'engine',
          // What the computer said of itself when it last connected. One that said nothing (an older build, or
          // one this computer does not use) has no version and is never called behind.
          ...(seen?.version ? { version: seen.version } : {}),
          ...(seen?.platform ? { platform: seen.platform } : {}),
          ...(seen?.arch ? { arch: seen.arch } : {}),
          ...(seen?.update ? { update: seen.update } : {}),
          ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
          olderThanThis: standing === 'behind',
          newerThanThis: standing === 'newer',
          ...(standing === 'channel' ? { otherChannel: true } : {})
        }
      })
  }

  /** The pairings' last version and time seen, in the profile's net database; its table is made on first use. */
  private presenceStore?: PeerPresence
  private presence(started: Started): PeerPresence {
    if (this.presenceStore?.db !== started.rt.db) {
      ensurePresenceTable(started.rt.db, ENGINE_PRESENCE_TABLE)
      this.presenceStore = new PeerPresence(started.rt.db, { now: () => Date.now() }, ENGINE_PRESENCE_TABLE)
    }
    return this.presenceStore
  }
  /** Writes what was seen of a pairing; best effort, never affecting a session. */
  private notePeer(write: (presence: PeerPresence) => void): void {
    const started = this.started
    if (!started || started.ending) return
    try {
      write(this.presence(started))
    } catch {
      // Stopping, or the database is busy: written again at the next connection.
    }
  }
  /**
   * A pairing's client is up: note when, and ask the computer its version and whether it updates itself (`net.info`).
   * When it can't be asked, what it said before is dropped, so a computer updated since is never left called behind.
   */
  /** Asks `node` what it runs and keeps the answer; returns it, or undefined when there was none. */
  private async askPeerInfo(node: NodeId): Promise<ReturnType<typeof parsePeerInfo>> {
    const started = this.started
    if (!started) return undefined
    this.notePeer((presence) => presence.opened(node, { direction: 'out' }))
    let info: ReturnType<typeof parsePeerInfo>
    try {
      info = parsePeerInfo(
        await started.sessions
          .client(node)
          .rpc('net.info', {}, { id: newId('rpc'), deadlineMs: engineLimits().peerInfoDeadlineMs })
      )
    } catch {
      info = undefined
    }
    if (this.started !== started) return undefined
    this.notePeer((presence) => (info ? presence.info(node, info) : presence.unknown(node)))
    this.changed()
    return info
  }
  /**
   * `net.update.there` for a pairing: asks it again what it runs (`refresh`), or one step of updating it (`update.*`).
   * Only a computer this one uses (its client here) can be asked.
   */
  async updateThere(params: UpdateThereParams): Promise<unknown> {
    const node = params.node as NodeId
    if (params.step === 'refresh' || params.step === 'version') {
      const info = await this.askPeerInfo(node)
      if (params.step === 'refresh') return { ok: true }
      // What it answered just now, never what was kept from before: no answer is an error.
      if (!info) throw new NetError('peer_offline')
      return { version: info.version, ...(info.update ? { update: info.update } : {}) }
    }
    const client = this.client(node)
    return askUpdate((method, body, options) => client.rpc(method, body, options), params)
  }
  isEngine(node: NodeId): boolean {
    return !!this.started?.peers.get(node)
  }
  serving(node: NodeId): boolean {
    return !!this.started?.peers.serving(node)
  }
  accepted(node: NodeId): boolean {
    const started = this.started
    return !started || started.pairing.accepted(node)
  }
  name(node: NodeId): string | undefined {
    return this.started?.peers.get(node)?.name
  }
  /**
   * Which computer needs a Mousse update while `node` is cut off for its version (pair-with-IP design §5): nothing
   * of it is used then, not even a session that outlived the refusal, until a connection agrees a version.
   */
  cutOff(node: NodeId): 'there' | 'here' | undefined {
    const row = this.started?.peers.get(node)
    return row ? needsUpdate(this.refusals?.get(row.endpoint.toLowerCase()), false)?.who : undefined
  }
  /**
   * A device cut off for its version is disabled: what it may do here, its routes and the other direction are not
   * changed until a connection agrees a version (a dialog opened before the refusal saves nothing). Remove, its update
   * and Check again stay.
   */
  refuseCutOff(node: NodeId): void {
    const who = this.cutOff(node)
    if (!who) return
    const name = this.started?.peers.get(node)?.name ?? 'The other computer'
    throw new NetError(
      'incompatible_peer',
      who === 'here' ? `Update Mousse here to use ${name}.` : `${name} needs a Mousse update.`,
      { details: { reason: 'needs_update' } }
    )
  }
  openBotView(node: NodeId): EngineStream {
    const started = this.started
    if (!started || !started.peers.serving(node)) throw new NetError('peer_offline')
    if (this.cutOff(node)) throw new NetError('incompatible_peer')
    return started.sessions.client(node).connection.open('mousse.botview')
  }
  client(node: NodeId): BridgeClient {
    const started = this.started
    if (!started || !started.peers.serving(node)) throw new NetError('peer_offline')
    if (this.cutOff(node)) throw new NetError('incompatible_peer')
    this.renewIfDue()
    return started.sessions.client(node)
  }
  online(node: NodeId): boolean {
    const started = this.started
    return !!started && !!started.peers.serving(node) && started.sessions.online(node) && !this.cutOff(node)
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
    if (
      !row ||
      !self ||
      connection.direction !== 'inbound' ||
      !row.grant ||
      row.grant !== connection.grant
    )
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
   * §4.4: an engine caller reads only a private stream bound to it (open, its reader, its bound reader, and allowed by
   * current policy for the stream's kind: thread sharing for the routed kinds, the bot level and the bot's Devices for
   * the bot streams) or a request artifact of its own.
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
    // A bot stream (the bots feed, a bot's chat) stands apart from thread sharing: the device's bot level and the bot's
    // Devices keep it, read on every batch through `access.open` above.
    if (isBotStreamKind(access.kind)) return
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
export function engineOn(home: string): boolean {
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
  return handedRoutes<string | SshRouteEntry>([
    ...addresses,
    ...(ssh?.routeId && ssh.selector
      ? [{ route_id: ssh.routeId, selector: ssh.selector, shell: ssh.shell ?? 'sh' }]
      : [])
  ])
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

/** Whether the helper was told to listen off loopback (`MOUSSE_NET_ENGINE_HELPER_LISTEN_IP`, set by checks only). */
function offLoopback(env: NodeJS.ProcessEnv = process.env): boolean {
  const ip = env.MOUSSE_NET_ENGINE_HELPER_LISTEN_IP?.trim()
  return !!ip && ip !== '127.0.0.1' && ip !== '::1'
}

/** This computer's first private-range IPv4 address (not link-local), if it has one. */
function privateAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const one of list ?? [])
      if (
        one.family === 'IPv4' &&
        !one.internal &&
        !one.address.startsWith('169.254.') &&
        privateRoute(`tcp://${one.address}:1`)
      )
        return one.address
  return undefined
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

