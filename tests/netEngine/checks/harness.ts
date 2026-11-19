/**
 * What the Phase 1a owner checks share: fresh profiles in one process with the engine switched on and v1
 * networking off, each running its connections through a helper its engine service starts and starts again
 * (`startHelper`), paired with each other; a window's daemon calls on each; fake shells on an owner; what each app
 * sends its helper (`./tap`); and the marker record `scripts/net-engine-check.mjs` reads (the reason the first
 * failed step gives).
 *
 * The helper is the fake one of `../fakeHelper` on a fake network, or with `MOUSSE_NET_HELPER` set, that real
 * helper: each computer's endpoint in its profile, its key in a file, listening on loopback, or on the address
 * `MOUSSE_NET_ENGINE_HELPER_LISTEN_IP` names (a release helper dials private-range addresses only, never loopback).
 *
 * Computers pair as their windows pair them (§5.1): the owner's window shows an invitation, the caller's joins it
 * (`netEngine.join`), the owner's window says Yes, and the apps finish both directions themselves.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import type { DomainConnectionContext } from '../../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import type { EngineHelper } from '../../../src/mms/netEngine/helper/connections'
import type { NodeId } from '../../../src/shared/net'
import { NET_LOCAL_CAPABILITY } from '../../../src/shared/net/local'
import { OUTBOUND } from '../../../src/shared/privacy/outbound'
import { qualifyId } from '../../../src/shared/threadRef'
import { fakeShells, type Spawned } from '../../net/bridge/routed/terminalFixture'
import { FakeNetwork, type FakeHelper } from '../fakeHelper'
import { tapPipe, type Crossed, type Tap } from './tap'

export type { Crossed } from './tap'

/** Whether the checks run the real helper (`MOUSSE_NET_HELPER`) instead of the fake one. */
export const REAL_HELPER = !!process.env.MOUSSE_NET_HELPER?.trim()

/**
 * The route a 1b routes check runs over (`--route`, 1b §14): each computer is given only that route, and every
 * connection must come up on it (`conn.up.route`), else the run fails with `route_mismatch`. Unset: 1a's checks.
 */
export const CHECK_ROUTE = readCheckRoute()
/** The class `tcp` is mapped to for this run (`MOUSSE_NET_ENGINE_CHECK_CLASS`): tailnet, then public. */
export const CHECK_CLASS: 'tailnet' | 'public' =
  process.env.MOUSSE_NET_ENGINE_CHECK_CLASS === 'public' ? 'public' : 'tailnet'

function readCheckRoute(): 'tcp' | 'ws' | 'ssh' | undefined {
  const value = process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE?.trim()
  return value === 'tcp' || value === 'ws' || value === 'ssh' ? value : undefined
}

/** The route kind and class every connection of a routes run must report. */
export function expectedRoute(): { kind: string; class: string } | undefined {
  if (CHECK_ROUTE === 'tcp') return { kind: 'tcp', class: CHECK_CLASS }
  if (CHECK_ROUTE === 'ws') return { kind: 'ws', class: 'tunnel' }
  if (CHECK_ROUTE === 'ssh') return { kind: 'ssh', class: 'ssh' }
  return undefined
}

export const DAY = 24 * 60 * 60_000
export const eventually = (check: () => unknown, timeout = 15_000) => vi.waitFor(check, { timeout })

/**
 * One step of a check. When it fails, its reason is the first one recorded for the run: the step's own word, or
 * else the word in what it threw. The check script prints it on the FAIL line.
 */
export async function step<T>(reason: string | undefined, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    record(reason ?? codeOf(error) ?? 'failed')
    throw error
  }
}

export function codeOf(error: unknown): string | undefined {
  const value = error as
    { code?: unknown; details?: { reason?: unknown; cause?: unknown } } | undefined
  for (const word of [value?.details?.cause, value?.details?.reason])
    if (typeof word === 'string' && /^[a-z_]{1,64}$/.test(word)) return word
  return typeof value?.code === 'string' && /^[a-z_]{1,64}$/.test(value.code)
    ? value.code
    : undefined
}

let recorded: string | undefined

/** The reason the first failed step gave, if one failed. */
export function recordedReason(): string | undefined {
  return recorded
}

function record(reason: string): void {
  if (recorded) return
  recorded = reason
  const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
  if (!out) return
  try {
    writeFileSync(join(out, 'reason'), reason)
  } catch {
    // The FAIL line then has no reason, which the kit counts as a failed control.
  }
}

/** Fails the step with `reason` unless `work` is refused. */
export async function refused(reason: string, work: () => Promise<unknown>): Promise<unknown> {
  let answer: unknown
  try {
    answer = await work()
  } catch (error) {
    return error
  }
  record(reason)
  throw new Error(`Not refused (${reason}): ${JSON.stringify(answer)?.slice(0, 200)}`)
}

export interface ProtocolEvent {
  type: string
  data: any
}

/** One computer of a check: a fresh profile with the engine on and a helper. */
export interface Computer {
  name: string
  mms: MousseMainService
  /** Its helper identity, as its pairings know it. */
  endpoint: string
  /** The app's view of its helper (the one running now; `restartHelper` updates it). */
  engine: EngineHelper
  /** Its fake helper now, when the helper is fake. */
  fake?: FakeHelper
  /** Kills its helper now, as a crash does; its engine service starts another. */
  kill(): void
  /** The port its next helper listens on (the real helper keeps its first one otherwise). */
  port?: number
  /** Whether it had a `net.db` before its engine was switched on. */
  hadNetDb: boolean
  /** What its windows heard. */
  events: ProtocolEvent[]
  /** A window's daemon call on this computer (`local`: the Settings window, with the local capability). */
  dispatch(method: string, params: unknown, local?: boolean): Promise<any>
}

/** The computers of one check, their helpers and the fake network between them. */
export class Fabric {
  readonly network = new FakeNetwork()
  /** Every engine message each app sent its helper; `decide` may drop one. */
  private readonly tap: Tap = { crossed: [] }
  private readonly cleanups: Array<() => unknown> = []
  /** In a routes run, each computer taps Use on offered addresses by itself; a check of Use itself turns it off. */
  autoUse = true
  /** The computers made so far (each fake one gets its own route in a routes run). */
  private made = 0
  /** Every `conn.up` route a helper reported in a routes run, by the app it went to. */
  readonly routesSeen: Array<{ to: string; route: unknown }> = []

  constructor() {
    const expected = expectedRoute()
    if (!expected) return
    if (!REAL_HELPER) {
      // A 1.1 fake: routes with approvals, and the class map the debug helper reads.
      this.network.minor = 1
      this.network.classMap = {}
      process.env.MOUSSE_NET_TEST_CLASS_MAP ||= 'fake'
    }
    // Every connection must come up on the route under test (1b §14).
    this.tap.watch = (message, to) => {
      if (message.ev !== 'conn.up') return
      this.routesSeen.push({ to, route: message.route })
      const route = message.route as { kind?: unknown; class?: unknown } | undefined
      if (route?.kind !== expected.kind || route?.class !== expected.class)
        record('route_mismatch')
    }
  }

  /**
   * In a routes run, the fake helper of computer `n` advertises only the route under test, and listens on its
   * loopback port besides (as a 1.1 helper with nothing selected does, 1b §1.5).
   */
  private routeFor(identity: string, n: number): void {
    if (!CHECK_ROUTE || REAL_HELPER) return
    const port = 47100 + n
    const route =
      CHECK_ROUTE === 'tcp'
        ? `tcp://100.101.0.${n}:${port}`
        : CHECK_ROUTE === 'ws'
          ? `wss://tunnel-${n}.check.invalid/mousse-net/1`
          : undefined
    this.network.ports.set(identity, port)
    this.network.listening.set(identity, [`tcp://127.0.0.1:${port}`])
    if (!route) return
    this.network.routes.set(identity, [route])
    if (CHECK_ROUTE === 'tcp') this.network.classMap![route] = CHECK_CLASS
    this.network.reach.set(identity, {
      lan: false,
      tailnet: CHECK_ROUTE === 'tcp',
      public: [],
      tunnels: CHECK_ROUTE === 'ws' ? [route] : [],
      port
    })
  }

  get crossed(): Crossed[] {
    return this.tap.crossed
  }
  /** Decides each message an app sends; `drop` loses it before its helper (unset after it drops one, by the caller). */
  set decide(decide: Tap['decide']) {
    this.tap.decide = decide
  }
  /** Decides each event or reply a helper sends its app (`to` is the app's endpoint); `drop` loses it. */
  set hold(hold: Tap['hold']) {
    this.tap.hold = hold
  }

  async computer(name: string): Promise<Computer> {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-')))
    const mms = await MousseMainService.create({
      homeDir: home,
      repoRoot: home,
      headless: true,
      requireOwnership: false
    })
    this.cleanups.push(
      () => {
        try {
          rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
        } catch {
          // A database file the system still holds is left to the temp folder.
        }
      },
      () => mms.stop()
    )
    const hadNetDb = existsSync(join(home, 'net', 'net.db'))
    let endpoint = ''
    let kill = () => undefined as void
    const computer = {} as Computer
    if (REAL_HELPER) {
      process.env.MOUSSE_NET_ENGINE_INSECURE_FILE_KEY = '1'
      // A cross-machine cell's computers listen on every interface; the others only on loopback.
      process.env.MOUSSE_NET_ENGINE_HELPER_LISTEN_IP ||= process.env.MOUSSE_NET_ENGINE_CHECK_ROLE
        ? '0.0.0.0'
        : '127.0.0.1'
      mms.netEngine.launcher = async () => {
        const launched = await mms.netEngine.launchBuilt(
          computer.port === undefined ? {} : { port: computer.port }
        )
        kill = () => launched.kill()
        return { ...launched, pipe: tapPipe(launched.pipe, () => endpoint, this.tap) }
      }
    } else {
      const identity = Buffer.from(`endpoint-${name}`).toString('hex')
      this.routeFor(identity, ++this.made)
      mms.netEngine.launcher = async () => {
        // Hex, as a real identity is: tickets carry it as bytes.
        const fake = this.network.helper(identity)
        computer.fake = fake
        kill = () => fake.kill()
        const exited = new Promise<{ code: number; signal: null; stderr: string }>((resolve) =>
          fake.pipe.onClose(() => resolve({ code: 0, signal: null, stderr: '' }))
        )
        return {
          pipe: tapPipe(fake.pipe, () => endpoint, this.tap),
          exited,
          kill: () => fake.kill()
        }
      }
      // A profile an SSH add makes on this computer gets its own fake helper.
      let made = 0
      mms.netEngineLauncher = (engine) => {
        if (engine === mms.netEngine || engine.launcher) return
        const own = Buffer.from(`endpoint-${name}-profile-${++made}`).toString('hex')
        engine.displayName = `${name} computer`
        engine.launcher = async () => {
          const fake = this.network.helper(own)
          return {
            pipe: tapPipe(fake.pipe, () => own, this.tap),
            exited: new Promise((resolve) =>
              fake.pipe.onClose(() => resolve({ code: 0, signal: null, stderr: '' }))
            ),
            kill: () => fake.kill()
          }
        }
      }
    }
    mms.netEngine.displayName = `${name} computer`
    await mms.netEngine.enable()
    await mms.netEngine.startHelper()
    const engine = await running(mms)
    endpoint = String(engine.info.identity)
    const events: ProtocolEvent[] = []
    let sequence = 0
    mms.protocolSequence = () => sequence
    mms.events.on('protocol:event', ((event: ProtocolEvent) => {
      sequence += 1
      events.push(event)
    }) as (data: unknown) => void)
    const window = (local: boolean): DomainConnectionContext => ({
      id: local ? 'settings' : 'window-1',
      clientType: 'gui',
      capabilities: new Set(local ? [NET_LOCAL_CAPABILITY] : []),
      binding: { profileId: mms.profileId, epoch: 1 }
    })
    Object.assign(computer, {
      name,
      mms,
      endpoint,
      engine,
      kill: () => kill(),
      hadNetDb,
      events,
      dispatch: (method: string, params: unknown, local = false) =>
        dispatchMethod(
          { mms, connection: window(local), globalSequence: () => mms.protocolSequence() },
          method,
          routedParams(mms, method, params)
        )
    })
    // A routes run: each owner taps Use on what its pairings offer, as its window would (unless a check says no).
    if (CHECK_ROUTE && this.autoUse) this.cleanups.push(useOffered(computer))
    return computer
  }

  /**
   * Pairs two computers both ways through their windows: the owner's shows an invitation, the caller's joins it,
   * the owner's says Yes; then each waits until its row reads Connected. Answers each one's local id for the other.
   */
  async pair(
    owner: Computer,
    caller: Computer
  ): Promise<{ callerOnOwner: NodeId; ownerOnCaller: NodeId; grant: string }> {
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    const stopApproving = approveAll(owner)
    let joined: { node: NodeId }
    try {
      joined = await caller.dispatch('netEngine.join', { ticket: invite.uri }, true)
    } finally {
      stopApproving()
    }
    const callerOnOwner = await connectedBothWays(owner, caller)
    const grant = owner.mms.netEngine.peerRows().find((row) => row.localId === callerOnOwner)!.grant
    return { callerOnOwner, ownerOnCaller: joined.node, grant }
  }

  /** The computer's daemon stops and starts again (its engine and its helper), as an app restart does. */
  async restartEngine(computer: Computer): Promise<void> {
    const before = computer.engine
    await computer.mms.netEngine.stop()
    await computer.mms.netEngine.enable()
    await computer.mms.netEngine.startHelper()
    computer.engine = await running(computer.mms, before)
  }

  /** `caller` connects to the pairing `node` (unless it is connected) and waits until its client is ready. */
  async connect(caller: Computer, node: NodeId): Promise<void> {
    if (!caller.mms.netEngine.online(node)) await caller.mms.netEngine.dial(node)
    await eventually(() => {
      if (!caller.mms.netEngine.online(node)) throw new Error('not connected yet')
    })
  }

  /**
   * The helper of `computer` exits (unless it already did) and its engine service starts a new one; nothing
   * reconnects until someone dials.
   */
  async restartHelper(computer: Computer): Promise<void> {
    const before = computer.engine
    computer.kill()
    computer.engine = await running(computer.mms, before)
  }

  /**
   * `computer` answers SSH at `hostname` (1b §3.7's test server, in process): its `mousse-cli net-engine ssh` is
   * its daemon's `netEngine.ssh.serve`, and a pipe over that route reaches its default profile's helper. Every
   * request it answers is kept.
   */
  sshServer(hostname: string, computer: Computer): Array<Record<string, unknown>> {
    const served: Array<Record<string, unknown>> = []
    this.network.sshServers.set(hostname, {
      // Its default profile, and every profile an SSH add made there.
      owns: (identity) =>
        identity === computer.endpoint ||
        identity.startsWith(Buffer.from(`endpoint-${computer.name}-profile-`).toString('hex')),
      serve: async (request) => {
        served.push(request)
        return computer.mms.sshRemote()!.serve(request)
      }
    })
    return served
  }

  shells(owner: Computer, onSpawn?: (shell: Spawned) => void): Spawned[] {
    return fakeShells(
      owner.mms.ptyManager,
      this.cleanups as Array<() => void | Promise<void>>,
      onSpawn
    )
  }

  folder(): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-folder-')))
    this.cleanups.push(() =>
      rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    )
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'owner@example.test')
    git('config', 'user.name', 'Owner')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(path, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    return path
  }

  async close(): Promise<void> {
    vi.useRealTimers()
    for (const close of this.cleanups.splice(0).reverse()) await close()
  }
}

/** Says Yes to every computer asking to join `owner`, as its window would, until stopped. */
export function approveAll(owner: Computer): () => void {
  const answered = new Set<string>()
  const timer = setInterval(() => {
    let approvals: Array<{ request: string }> = []
    try {
      approvals = owner.mms.netEngine.status().approvals
    } catch {
      return
    }
    for (const approval of approvals)
      if (!answered.has(approval.request)) {
        answered.add(approval.request)
        void owner
          .dispatch('netEngine.approve', { request: approval.request, yes: true }, true)
          .catch(() => undefined)
      }
  }, 25)
  return () => clearInterval(timer)
}

/**
 * A window's join in a routes run: unless the check chose what to share, the joiner ticks every route it may share,
 * so the reverse direction runs over the route under test too (1b §14).
 */
function routedParams(mms: MousseMainService, method: string, params: unknown): unknown {
  if (!CHECK_ROUTE || method !== 'netEngine.join' || !params || typeof params !== 'object') return params
  if ('share' in params) return params
  const share = mms.netEngine.shareable()
  return share.length ? { ...params, share } : params
}

/** Hosts the app contacts for its other features, as its outbound inventory lists them. */
const PRODUCT_HOSTS = new Set(
  OUTBOUND.filter((entry) => entry.kind === 'contacted').flatMap((entry) => entry.hosts)
)

let guarded = false

/** An attempt outside the cell: recorded, and where it went kept beside the reason (`egress`). */
function denied(where: string): void {
  // What the app contacts for other features (its outbound inventory, such as the daily agent version check) is
  // not route setup: the kit judges that traffic on its own.
  if (PRODUCT_HOSTS.has(where.replace(/:\d+$/, ''))) return
  record('egress_attempted')
  const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
  if (out) appendFileSync(join(out, 'egress'), `${where}\n`)
}

/**
 * The routes checks' egress guard in this process (1b §14, as the kit's preload does for the app): a request to
 * Plus (`MOUSSE_ID_ORIGIN`, pointed at a name that never resolves when unset) records `plus_contacted`; a connection
 * to any address but loopback records `egress_attempted` and fails before a packet leaves.
 */
export function guardEgress(): void {
  if (guarded) return
  guarded = true
  process.env.MOUSSE_ID_ORIGIN ||= 'https://plus.check.invalid'
  const plus = new URL(process.env.MOUSSE_ID_ORIGIN).host
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.host === plus) record('plus_contacted')
    else if (!/^(localhost|127\.|\[::1\])/.test(url.host)) denied(url.host)
    else return realFetch(input, init)
    throw new Error('egress denied by the check')
  }) as typeof fetch
  const connect = Socket.prototype.connect as (...args: unknown[]) => Socket
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const first = args[0] as { host?: unknown; path?: unknown } | unknown[] | number | string
    const options = (Array.isArray(first) ? first[0] : first) as
      | { host?: unknown; path?: unknown }
      | number
      | string
    const host =
      typeof options === 'object' && options
        ? options.path
          ? 'pipe'
          : String(options.host ?? 'localhost')
        : typeof options === 'number'
          ? String(args[1] ?? 'localhost')
          : 'pipe'
    if (!['pipe', 'localhost', '::1'].includes(host) && !host.startsWith('127.')) {
      denied(host)
      process.nextTick(() => this.destroy(new Error('egress denied by the check')))
      return this
    }
    return connect.apply(this, args)
  } as typeof Socket.prototype.connect
}

/** Taps Use on every "Addresses <B> offered" on `owner`, as its window would, until stopped. */
export function useOffered(owner: Pick<Computer, 'mms' | 'dispatch'>): () => void {
  const used = new Set<string>()
  const timer = setInterval(() => {
    let devices: Array<{ node: string; offered?: string[] }> = []
    try {
      devices = owner.mms.netEngine.status().devices
    } catch {
      return
    }
    for (const device of devices) {
      const key = `${device.node} ${device.offered?.join(' ')}`
      if (!device.offered?.length || used.has(key)) continue
      used.add(key)
      void owner
        .dispatch('netEngine.address.use', { node: device.node }, true)
        .catch(() => used.delete(key))
    }
  }, 25)
  return () => clearInterval(timer)
}

/** A computer's row for another (by its endpoint), in any state but removed. */
export function rowFor(on: Computer, other: Computer) {
  return on.mms.netEngine
    .peerRows()
    .find((row) => row.endpoint === other.endpoint && row.state !== 'removed')
}

/** What a computer's Devices list shows for `node`. */
export function deviceState(on: Computer, node: NodeId): string | undefined {
  return on.mms.netEngine.status().devices.find((row) => row.node === node)?.state
}

/** Waits until each computer's row for the other reads Connected; answers the caller's id on the owner. */
export async function connectedBothWays(
  owner: Computer,
  caller: Computer,
  timeout = 60_000
): Promise<NodeId> {
  let callerOnOwner: NodeId | undefined
  await eventually(() => {
    const onOwner = rowFor(owner, caller),
      onCaller = rowFor(caller, owner)
    if (!onOwner || !onCaller)
      throw new Error(`rows: owner ${onOwner?.state}, caller ${onCaller?.state}`)
    if (
      deviceState(owner, onOwner.localId) !== 'connected' ||
      deviceState(caller, onCaller.localId) !== 'connected'
    )
      throw new Error(`owner ${onOwner.state}, caller ${onCaller.state}`)
    callerOnOwner = onOwner.localId
  }, timeout)
  return callerOnOwner!
}

/** The helper `mms` runs once it said hello (another than `before`). */
async function running(mms: MousseMainService, before?: EngineHelper): Promise<EngineHelper> {
  let engine: EngineHelper | undefined
  await eventually(() => {
    const status = mms.netEngine.helperStatus()
    engine = mms.netEngine.currentHelper()
    if (status.state !== 'running' || !engine || engine === before || !engine.info.identity)
      throw new Error(
        `helper ${status.state}${'text' in status && status.text ? `: ${status.text}` : ''}`
      )
  }, 30_000)
  return engine!
}

/** The common shape: an owner and one caller, paired and connected. */
export interface Pair {
  fabric: Fabric
  ownerComputer: Computer
  callerComputer: Computer
  owner: MousseMainService
  caller: MousseMainService
  ownerOnCaller: NodeId
  callerOnOwner: NodeId
  hadNetDb: { owner: boolean; caller: boolean }
  events: ProtocolEvent[]
  shells: Spawned[]
  dispatch(method: string, params: unknown, local?: boolean): Promise<any>
  ownerLocal(method: string, params: unknown): Promise<any>
  q(threadId: string): string
  folder(): string
  close(): Promise<void>
}

export async function pairProfiles(): Promise<Pair> {
  const fabric = new Fabric()
  const owner = await fabric.computer('owner'),
    caller = await fabric.computer('caller')
  const { callerOnOwner, ownerOnCaller } = await fabric.pair(owner, caller)
  const shells = fabric.shells(owner)
  await fabric.connect(caller, ownerOnCaller)
  return {
    fabric,
    ownerComputer: owner,
    callerComputer: caller,
    owner: owner.mms,
    caller: caller.mms,
    ownerOnCaller,
    callerOnOwner,
    hadNetDb: { owner: owner.hadNetDb, caller: caller.hadNetDb },
    events: caller.events,
    shells,
    dispatch: caller.dispatch,
    ownerLocal: (method, params) => owner.dispatch(method, params, true),
    q: (threadId) => qualifyId(ownerOnCaller, threadId),
    folder: () => fabric.folder(),
    close: () => fabric.close()
  }
}

/** What a computer's windows were shown of one terminal. */
export function terminalOutput(events: ProtocolEvent[], ptyId: string): string {
  return events
    .filter((event) => event.type === 'pty.data' && event.data.ptyId === ptyId)
    .map((event) => event.data.data as string)
    .join('')
}
