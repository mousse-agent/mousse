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
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { connect as netConnect, createServer as createNetServer, Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { createServer as createTlsServer } from 'node:tls'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, vi } from 'vitest'
import { runNetEngineSsh } from '../../../src/cli/commands/netEngineSsh'
import { setSharedShellPath } from '../../../src/mms/harness/shellPath'
import { observeHarnessSpawns } from '../../../src/mms/harness/spawn'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import type { DomainConnectionContext } from '../../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import type { EngineHelper } from '../../../src/mms/netEngine/helper/connections'
import type { NodeId } from '../../../src/shared/net'
import { NET_LOCAL_CAPABILITY } from '../../../src/shared/net/local'
import { qualifyId } from '../../../src/shared/threadRef'
import { fakeShells, type Spawned } from '../../net/bridge/routed/terminalFixture'
import { FakeNetwork, type FakeHelper } from '../fakeHelper'
import { tapPipe, type Crossed, type Tap } from './tap'

export type { Crossed } from './tap'

/** Whether the checks run the real helper (`MOUSSE_NET_HELPER`) instead of the fake one. */
export const REAL_HELPER = !!process.env.MOUSSE_NET_HELPER?.trim()

/**
 * The route a 1b routes check runs over (`--route`, 1b §14): each computer is given only that route, and every
 * connection must come up on it (`conn.up.route`), else the run fails with `route_mismatch`. Each `conn.up` it judges
 * is written to `<out>/conn-up.jsonl`, one JSON object per line, for the kit to judge too.
 *
 * `relay` (Phase 3): each computer adds one of the relays in `MOUSSE_RELAY_TEST_LINKS` as its own. Pairing setup runs
 * direct (a host learns a caller's relay only from what that caller sends as a host); `Fabric.settle` then turns every
 * computer's direct routes off and restarts its helpers, and every `conn.up` after setup must be of kind `relay`
 * through one of those relays. Unset: 1a's checks.
 */
export const CHECK_ROUTE = readCheckRoute()
/**
 * Over ssh with the real helper, computers pair through Add over SSH (1b §3.4), the real flow: one way, the caller
 * uses the owner and the owner gets no way back (§3.6).
 */
export const ONE_WAY = REAL_HELPER && CHECK_ROUTE === 'ssh'
/** In a real-helper tcp run, how many computers' loopback ports (from 47301) the class map names. */
const CLASS_MAPPED_PORTS = 32
/** The class `tcp` is mapped to for this run (`MOUSSE_NET_ENGINE_CHECK_CLASS`): tailnet, then public. */
export const CHECK_CLASS: 'tailnet' | 'public' =
  process.env.MOUSSE_NET_ENGINE_CHECK_CLASS === 'public' ? 'public' : 'tailnet'

function readCheckRoute(): 'tcp' | 'ws' | 'ssh' | 'relay' | undefined {
  const value = process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE?.trim()
  return value === 'tcp' || value === 'ws' || value === 'ssh' || value === 'relay' ? value : undefined
}

/**
 * The enrollment links of a running `mousse-relay` in `text` (`MOUSSE_RELAY_TEST_LINKS`: whitespace- or
 * comma-separated, each used once), each with the destination (`relay://host:port`) it names. Words that are not
 * links are left out.
 */
export function relayTestLinks(text: string | undefined): Array<{ link: string; destination: string }> {
  const out: Array<{ link: string; destination: string }> = []
  for (const word of (text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const match =
      /^mousse-relay:\/\/(\[[0-9A-Fa-f:.]+\]|[^/:[\]]+):(\d{1,5})\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(word)
    if (match) out.push({ link: word, destination: `relay://${match[1]!.toLowerCase()}:${Number(match[2])}` })
  }
  return out
}

/** The route kind and class every connection of a routes run must report. */
export function expectedRoute(): { kind: string; class: string } | undefined {
  if (CHECK_ROUTE === 'tcp') return { kind: 'tcp', class: CHECK_CLASS }
  if (CHECK_ROUTE === 'ws') return { kind: 'ws', class: 'tunnel' }
  if (CHECK_ROUTE === 'ssh') return { kind: 'ssh', class: 'ssh' }
  if (CHECK_ROUTE === 'relay') return { kind: 'relay', class: 'relay' }
  return undefined
}

/**
 * Whether a `conn.up` route is the one a routes run expects: its kind and class; for a relay, class `relay` or
 * `relay_bulk`, through one of `relays` when it names its destination.
 */
export function routeMatches(
  route: unknown,
  expected: { kind: string; class: string },
  relays: readonly string[] = []
): boolean {
  const up = route as { kind?: unknown; class?: unknown; destination?: unknown } | undefined
  if (up?.kind !== expected.kind) return false
  if (expected.kind !== 'relay') return up.class === expected.class
  if (up.class !== 'relay' && up.class !== 'relay_bulk') return false
  return up.destination === undefined || relays.includes(String(up.destination).toLowerCase())
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
  /** Its Mousse folder (`MOUSSE_HOME`). */
  home: string
}

/** A computer's SSH test server in a real-helper run: its host alias and its default profile's selector. */
interface SshHost {
  alias: string
  selector: string
}

/** The computers of one check, their helpers and the fake network between them. */
export class Fabric {
  readonly network = fakeNetwork()
  /** Every engine message each app sent its helper; `decide` may drop one. */
  private readonly tap: Tap = { crossed: [] }
  private readonly cleanups: Array<() => unknown> = []
  /** In a routes run, each computer taps Use on offered addresses by itself; a check of Use itself turns it off. */
  autoUse = true
  /** In a routes run over ssh, the computers made so far. */
  private readonly computers: Computer[] = []
  /** Every computer made so far. */
  private readonly all: Computer[] = []
  /** In a routes run over ssh, each fake computer's SSH route id, by its identity. */
  private readonly sshRouteOf = new Map<string, string>()
  /** The computers made so far (each fake one gets its own route in a routes run). */
  private made = 0
  /** Every `conn.up` route a helper reported in a routes run, by the app it went to. */
  readonly routesSeen: Array<{ to: string; route: unknown }> = []
  /** A relay run's links not given to a computer yet. */
  private readonly relayLinks = relayTestLinks(process.env.MOUSSE_RELAY_TEST_LINKS)
  /** The pairings `pair` made. */
  private readonly pairs: Array<{ owner: Computer; caller: Computer; callerOnOwner: NodeId; ownerOnCaller: NodeId }> =
    []
  /** A relay run's setup has ended (`settle`): from now on every connection is judged. */
  private settled = CHECK_ROUTE !== 'relay'

  constructor() {
    withoutAgentClis()
    const expected = expectedRoute()
    if (CHECK_ROUTE === 'relay') {
      // Redials and re-registrations after `settle`'s restarts, without minutes of backoff.
      process.env.MOUSSE_NET_KEEP_RETRY_FIRST_MS ||= '200'
      process.env.MOUSSE_NET_KEEP_RETRY_MAX_MS ||= '2000'
      process.env.MOUSSE_NET_VIA_RELAY_RETRY_FIRST_MS ||= '200'
    }
    const relays = this.relayLinks.map((entry) => entry.destination)
    // Every connection a helper reports goes to <out>/conn-up.jsonl, one JSON object per line: the kit judges the
    // route case from it (1b §14). A relay run's setup runs direct, so only what comes after it (`settle`) counts.
    const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
    this.tap.watch = (message, to) => {
      if (message.ev !== 'conn.up' || !this.settled) return
      if (out) appendFileSync(join(out, 'conn-up.jsonl'), `${JSON.stringify({ ...message, to })}
`)
      if (!expected) return
      this.routesSeen.push({ to, route: message.route })
      // Every connection of the route's kind (as the kit judges it), and of its class: an inbound loopback
      // connection takes the class the map gives the listener port it arrived on. A relay's names one of the run's
      // relays.
      if (!routeMatches(message.route, expected, relays)) record('route_mismatch')
    }
    if (!expected) return
    if (!REAL_HELPER && CHECK_ROUTE !== 'relay') {
      // A 1.1 fake: routes with approvals, and the class map the debug helper reads.
      this.network.minor = 1
      this.network.classMap = {}
    }
  }

  /**
   * In a routes run, the fake helper of computer `n` advertises only the route under test, and listens on its
   * loopback port besides (as a 1.1 helper with nothing selected does, 1b §1.5).
   */
  private routeFor(identity: string, n: number): void {
    if (!CHECK_ROUTE || REAL_HELPER) return
    // A fake helper with relays: once its computer adds one, every dial to it goes through that relay.
    if (CHECK_ROUTE === 'relay') {
      this.network.relays.set(identity, { available: true, relays: [], peers: new Map(), grants: new Map() })
      return
    }
    const port = 47100 + n
    const route =
      CHECK_ROUTE === 'tcp'
        ? `tcp://100.101.0.${n}:${port}`
        : CHECK_ROUTE === 'ws'
          ? `wss://tunnel-${n}.check.invalid/mousse-net/1`
          : undefined
    this.network.ports.set(identity, port)
    this.network.listening.set(identity, [`tcp://127.0.0.1:${port}`])
    if (CHECK_ROUTE === 'ssh') {
      // Its own SSH test server, reached by the route `ssh-<n>` (1b §14: one SSH route per direction).
      this.network.sshServers.set(`host-${n}`, {
        owns: (id) => id === identity,
        serve: async () => ({})
      })
      this.network.sshRoutes.set(`ssh-${n}`, { hostname: `host-${n}`, user: 'me', pinned: true })
      this.sshRouteOf.set(identity, `ssh-${n}`)
    }
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

  /** A fresh profile with its engine on; `prepare` runs on its service before the engine starts (test hooks). */
  async computer(name: string, prepare?: (mms: MousseMainService) => void): Promise<Computer> {
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
      // Every helper of the run reads the one SSH config the test servers' entries go in.
      process.env.MOUSSE_NET_TEST_SSH_CONFIG ||= sshConfig()
      // Over tcp on one computer, each helper's loopback port stands for the class under test: the debug helper
      // and the app read the same map (`<port>=<class>`, 1b §14). The whole range is mapped before the first helper
      // starts, so each helper, which reads the map once, knows the computers made after it. Other loopback ports
      // stay `lan` (a LAN address that changes, as in reconnect).
      if (CHECK_ROUTE === 'tcp' && !process.env.MOUSSE_NET_ENGINE_CHECK_ROLE) {
        computer.port = 47300 + ++this.made
        if (computer.port > 47300 + CLASS_MAPPED_PORTS)
          throw new Error(`a routes run maps ${CLASS_MAPPED_PORTS} computers' ports`)
        process.env.MOUSSE_NET_TEST_CLASS_MAP ||= Array.from(
          { length: CLASS_MAPPED_PORTS },
          (_, i) => `${47301 + i}=${CHECK_CLASS}`
        ).join(',')
      }
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
    prepare?.(mms)
    await mms.netEngine.enable()
    await mms.netEngine.startHelper()
    let engine = await running(mms)
    // Over ws with the real helper, this computer's only route is its tunnel: its own stand-in (1b §14).
    if (REAL_HELPER && CHECK_ROUTE === 'ws') {
      const tunnel = await tunnelStandIn(() => mms.netEngine.reach()?.wsPort)
      this.cleanups.push(tunnel.close)
      const before = engine
      const { restarted } = await mms.netEngine.setReach({ lan: false, tunnels: [tunnel.route] })
      if (restarted) engine = await running(mms, before)
    }
    // Over ssh with the real helper: this computer advertises no route, and answers SSH on its own test server.
    let ssh: SshHost | undefined
    if (REAL_HELPER && CHECK_ROUTE === 'ssh') {
      const before = engine
      const { restarted } = await mms.netEngine.setReach({ lan: false, tailnet: false, public: [] })
      if (restarted) engine = await running(mms, before)
      ssh = await this.sshHost(`mousse-check-${name}`, mms, home)
    }
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
      home,
      dispatch: (method: string, params: unknown, local = false) =>
        dispatchMethod(
          { mms, connection: window(local), globalSequence: () => mms.protocolSequence() },
          method,
          routedParams(mms, method, params)
        )
    })
    // A relay run: one of the run's relays becomes this computer's own, and it allows its pairings' relays.
    if (CHECK_ROUTE === 'relay') {
      await this.addRelay(computer)
      this.cleanups.push(allowRelays(computer))
    }
    // A routes run: each owner taps Use on what its pairings offer, as its window would (unless a check says no).
    if (CHECK_ROUTE && this.autoUse) this.cleanups.push(useOffered(computer))
    this.all.push(computer)
    // Over ssh, each fake computer holds every other's SSH route as its owner address, as the kit sets it (1b §14).
    // A real helper takes owner addresses only for a peer it is paired with (a join dials only the ticket's hints,
    // where ssh is reserved), so real computers pair through Add over SSH instead (`pair`).
    if (ssh) this.sshOf.set(computer, ssh)
    if (CHECK_ROUTE === 'ssh' && !REAL_HELPER) {
      for (const other of this.computers)
        for (const [from, to] of [
          [computer, other],
          [other, computer]
        ] as const)
          await from.engine.request('peer.addresses.set', {
            identity: to.endpoint,
            routes: [
              { route_id: this.sshRouteOf.get(to.endpoint), selector: 'a'.repeat(26), shell: 'sh' }
            ]
          })
      this.computers.push(computer)
    }
    return computer
  }

  /** In a real-helper run over ssh, each computer's test SSH server. */
  private readonly sshOf = new Map<Computer, SshHost>()

  /**
   * `mms` answers SSH at `alias` on the kit's test SSH server (`MOUSSE_CHECK_TEST_SSHD`, started through
   * `MOUSSE_CHECK_SSH_ROUTES`, 1b §14): on loopback, into its Mousse folder `home`. Its `mousse-helper` is this
   * run's helper and its `mousse-cli` the stand-in that carries `net-engine ssh` to this app (`cliStandIn`). The
   * server's entry goes in the run's one SSH config as `alias`. Every request B answers goes in `served`.
   */
  private async sshHost(
    alias: string,
    mms: MousseMainService,
    home: string,
    served: Array<Record<string, unknown>> = []
  ): Promise<SshHost> {
    const routes = process.env.MOUSSE_CHECK_SSH_ROUTES?.trim()
    if (!routes || !process.env.MOUSSE_CHECK_TEST_SSHD?.trim())
      throw new Error(
        'a real-helper ssh run needs MOUSSE_CHECK_TEST_SSHD and MOUSSE_CHECK_SSH_ROUTES (run.mjs)'
      )
    const cli = await this.cliStandIn(mms, served)
    // On Unix the launchers the app writes in <home>/bin run what MOUSSE_NET_ENGINE_CLI names; Windows is not an
    // SSH remote in 1b, so there test-sshd's `--launcher` stands in for them.
    if (process.platform !== 'win32') process.env.MOUSSE_NET_ENGINE_CLI = cli.command.join(' ')
    // endpoints.json names this computer's profiles by selector, as `mousse-helper pipe` reads it.
    const remote = mms.sshRemote()!
    await remote.afterReady()
    const selector = remote.selectorOf(mms.netEngine.profileDir)
    const { startSshRoute } = (await import(pathToFileURL(routes).href)) as {
      startSshRoute: (options: Record<string, unknown>) => Promise<{
        config: string
        stop: () => Promise<void>
      }>
    }
    const server = await startSshRoute({
      keys: join(home, `ssh-server-${alias}`),
      mousseHome: home,
      launchers:
        process.platform === 'win32'
          ? { 'mousse-helper': process.env.MOUSSE_NET_HELPER!.trim(), 'mousse-cli': cli.launcher }
          : {}
    })
    this.cleanups.push(server.stop)
    const entry = readFileSync(server.config, 'utf8').replace(
      /^Host mousse-test-sshd$/m,
      `Host ${alias}`
    )
    appendFileSync(sshConfig(), `\n${entry}\n`)
    return { alias, selector }
  }

  /**
   * Test only: `mousse-cli net-engine ssh` for `mms` as the SSH test server runs it. Its launcher
   * (`sshCliStandIn.mjs`) connects to a loopback server here, sends the token and carries the session; the session
   * is answered with the command's own code, asking this app's `sshRemote` as its daemon would. A reply
   * `network.sshLose` picks is lost after B served it, as a dropped session loses it.
   */
  private async cliStandIn(
    mms: MousseMainService,
    served: Array<Record<string, unknown>>
  ): Promise<{ launcher: string; command: string[] }> {
    const token = randomBytes(16).toString('hex')
    const open = new Set<Socket>()
    const server = createNetServer({ allowHalfOpen: true }, (socket) => {
      open.add(socket)
      socket.on('close', () => open.delete(socket))
      socket.on('error', () => undefined)
      let head = Buffer.alloc(0)
      const first = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf(10)
        if (end < 0) {
          if (head.length > 256) socket.destroy()
          return
        }
        socket.off('data', first)
        if (head.subarray(0, end).toString() !== token) return void socket.destroy()
        const body = new PassThrough()
        body.write(head.subarray(end + 1))
        socket.pipe(body)
        let lost = false
        void runNetEngineSsh({
          stdin: body,
          stdout: { write: (text: string) => lost || socket.write(text) },
          serve: async (request) => {
            served.push(request as Record<string, unknown>)
            const reply = await mms.sshRemote()!.serve(request)
            if (this.network.sshLose?.(request as Record<string, unknown>)) lost = true
            return reply
          }
        }).finally(() => (lost ? socket.destroy() : socket.end()))
      }
      socket.on('data', first)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.cleanups.push(() => closeServer(server, open))
    const port = (server.address() as { port: number }).port
    const script = join(dirname(fileURLToPath(import.meta.url)), 'sshCliStandIn.mjs')
    const command = [process.execPath, script, String(port), token]
    let launcher = ''
    if (process.platform === 'win32') {
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-cli-')))
      this.cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
      launcher = join(folder, 'mousse-cli.cmd')
      writeFileSync(launcher, `@"${process.execPath}" "${script}" ${port} ${token} %*\r\n`)
    }
    return { launcher, command }
  }

  /**
   * Over ssh with the real helper, pairing is Add over SSH (1b §3.4), the real flow: the caller's window resolves
   * the owner's SSH route, trusts its key and connects to the owner's default profile; the owner's row connects on
   * the caller's first inbound. One way: the owner gets no way back (§3.6).
   */
  private async sshPair(
    owner: Computer,
    caller: Computer
  ): Promise<{ callerOnOwner: NodeId; ownerOnCaller: NodeId; grant: string }> {
    const { alias, selector } = this.sshOf.get(owner)!
    const resolved = await caller.dispatch('netEngine.ssh.resolve', { target: alias }, true)
    const host = { routeId: resolved.routeId, host: alias }
    const probe = await caller.dispatch('netEngine.ssh.probe', host, true)
    await caller.dispatch('netEngine.ssh.trust', { ...host, sha256: probe.sha256 }, true)
    await caller.dispatch(
      'netEngine.ssh.connect',
      { ...host, target: alias, user: resolved.user, selector },
      true
    )
    const callerOnOwner = await connectedBothWays(owner, caller)
    const grant = owner.mms.netEngine.peerRows().find((row) => row.localId === callerOnOwner)!.grant
    return { callerOnOwner, ownerOnCaller: rowFor(caller, owner)!.localId, grant }
  }

  /**
   * The grants the helper of `identity` holds, as the fake network lists them: a computer's default profile or a
   * profile an SSH add made there.
   */
  async grantsAt(identity: string): Promise<Array<{ caller: string; grant: number | string }>> {
    if (!REAL_HELPER) return this.network.grantsAt(identity)
    for (const computer of this.all) {
      const host = computer.mms.getInstallationHost()
      const ids = host ? host.manager.list().map((record) => record.id) : [computer.mms.profileId]
      for (const id of ids) {
        const helper = (await computer.mms.getProfileServices(id)).netEngine.currentHelper()
        if (String(helper?.info.identity ?? '') !== identity) continue
        const answer = await helper!.request('grants.list')
        return (answer.grants as Array<{ identity: string; grant: number | string }>).map(
          (one) => ({
            caller: one.identity,
            grant: one.grant
          })
        )
      }
    }
    throw new Error(`no helper is ${identity}`)
  }

  /**
   * A relay run: `computer` adds the next relay of `MOUSSE_RELAY_TEST_LINKS` as its own, as Settings → Reach does.
   * Without a link left the run fails with `not_configured`.
   */
  private async addRelay(computer: Computer): Promise<void> {
    const next = this.relayLinks.shift()
    if (!next) {
      record('not_configured')
      throw new Error('A relay run needs one MOUSSE_RELAY_TEST_LINKS link for each computer.')
    }
    await step('relay_not_added', () =>
      computer.dispatch('netEngine.relay.enroll', { link: next.link }, true)
    )
  }

  /**
   * The end of a check's setup. In a relay run (Phase 3), once every pairing knows the other's relay (the host lists
   * the caller's key, the caller allowed the host's relay), each computer turns LAN and tailnet off and moves to a
   * new port, so no direct route is left; then every helper restarts at once and every pairing must come back,
   * both ways, through a relay. Every connection from here on is judged. Nothing in other runs.
   */
  async settle(): Promise<void> {
    if (this.settled) return
    if (REAL_HELPER)
      await step('relay_not_ready', () =>
        eventually(async () => {
          for (const { owner, caller } of this.pairs)
            for (const [host, peer] of [
              [owner, caller],
              [caller, owner]
            ] as const) {
              const grants = await host.engine.request('grants.list')
              const grant = (grants.grants as Array<Record<string, unknown>>).find(
                (item) => item.identity === peer.endpoint
              )
              expect(grant?.relay).toBe('listed')
              const peers = await peer.engine.request('peers.list')
              const entry = (peers.peers as Array<Record<string, any>>).find(
                (item) => item.identity === host.endpoint
              )
              expect(entry?.relay?.routes?.some((route: { approved?: unknown }) => route.approved === true)).toBe(
                true
              )
            }
        }, 60_000)
      )
    for (const computer of this.all) {
      if (!computer.mms.netEngine.status().reach) continue
      const before = computer.engine
      const port = await freePort()
      computer.port = port
      const saved = await step(undefined, () =>
        computer.dispatch('netEngine.routes.config', { lan: false, tailnet: false, port }, true)
      )
      if (saved?.restarted) computer.engine = await running(computer.mms, before)
    }
    this.settled = true
    await Promise.all(this.all.map((computer) => this.restartHelper(computer)))
    for (const { owner, caller, callerOnOwner, ownerOnCaller } of this.pairs)
      await step('not_reconnected', () =>
        eventually(() => {
          expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
          expect(caller.mms.netEngine.online(ownerOnCaller)).toBe(true)
        }, 90_000)
      )
  }

  /**
   * Pairs two computers both ways through their windows: the owner's shows an invitation, the caller's joins it,
   * the owner's says Yes; then each waits until its row reads Connected. Answers each one's local id for the other.
   */
  async pair(
    owner: Computer,
    caller: Computer
  ): Promise<{ callerOnOwner: NodeId; ownerOnCaller: NodeId; grant: string }> {
    if (ONE_WAY) return this.sshPair(owner, caller)
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
    this.pairs.push({ owner, caller, callerOnOwner, ownerOnCaller: joined.node })
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
   * `computer` answers SSH at `hostname` (1b §3.7's test server, in process; with the real helper, the kit's test
   * SSH server and the `mousse-cli` stand-in): its `mousse-cli net-engine ssh` is its daemon's
   * `netEngine.ssh.serve`, and a pipe over that route reaches the chosen profile's helper. Every request it answers
   * is kept.
   */
  async sshServer(hostname: string, computer: Computer): Promise<Array<Record<string, unknown>>> {
    const served: Array<Record<string, unknown>> = []
    if (REAL_HELPER) {
      await this.sshHost(hostname, computer.mms, computer.home, served)
      return served
    }
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

/**
 * A fake network whose helpers carry the defects the kit's helper controls build into a real one (each
 * `--cfg mousse_control="<name>"` in `RUSTFLAGS`), so a control fails the same way with the fake helper.
 */
function fakeNetwork(): FakeNetwork {
  const network = new FakeNetwork()
  for (const match of (process.env.RUSTFLAGS ?? '').matchAll(/mousse_control="([a-z0-9-]+)"/g))
    network.defects.add(match[1]!)
  return network
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
  if (!CHECK_ROUTE || method !== 'netEngine.join' || !params || typeof params !== 'object')
    return params
  if ('share' in params) return params
  const share = mms.netEngine.shareable()
  return share.length ? { ...params, share } : params
}

let guarded = false

/** An attempt outside the cell: recorded, and where it went kept beside the reason (`egress`). */
function denied(where: string): void {
  record('egress_attempted')
  const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
  if (out) appendFileSync(join(out, 'egress'), `${where}\n`)
}

/** Agent CLIs a profile could find and start (each name as installed, `.exe`, `.cmd` and `.ps1` on Windows). */
const AGENT_CLIS = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'cursor-agent',
  'agy',
  'antigravity',
  'opencode',
  'pi',
  'qwen',
  'copilot',
  'amp',
  'goose',
  'droid'
]

let agentClisHidden = false

/**
 * A check never starts the user's installed agent CLIs: they reach the network (Codex syncs its plugins) and use
 * the user's real install. Each profile finds none: PATH loses every folder holding one, the stored PATH the app
 * would read (`shellPath`) is empty, and the user's folders the app also searches (`~/.local/bin`, the standalone
 * installs under LOCALAPPDATA) point at an empty one. Any agent CLI started anyway fails the run with
 * `egress_attempted`, the command kept in `<out>/egress`.
 */
function withoutAgentClis(): void {
  if (agentClisHidden) return
  agentClisHidden = true
  const windows = process.platform === 'win32'
  const names = AGENT_CLIS.flatMap((name) =>
    windows ? [name, `${name}.exe`, `${name}.cmd`, `${name}.ps1`] : [name]
  )
  const separator = windows ? ';' : ':'
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  process.env[key] = (process.env[key] ?? '')
    .split(separator)
    .filter((folder) => folder && !names.some((name) => existsSync(join(folder, name))))
    .join(separator)
  setSharedShellPath({ entries: [], source: 'failed', error: 'a check run reads no stored PATH' })
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-user-')))
  for (const name of windows ? ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] : ['HOME'])
    process.env[name] = home
  observeHarnessSpawns((spawned) =>
    denied(`agent CLI (${spawned.instanceId}, ${spawned.purpose}): ${spawned.command}`)
  )
}

/**
 * The routes checks' egress guard in this process (1b §14, as the kit's preload does for the app): a request to
 * Plus (`MOUSSE_ID_ORIGIN`, pointed at a name that never resolves when unset) records `plus_contacted`; a connection
 * to any address but loopback records `egress_attempted` and fails before a packet leaves.
 */
export function guardEgress(): void {
  if (guarded) return
  guarded = true
  // As under the kit: the app skips its background lookups (the daily agent version check, model lists).
  process.env.MOUSSE_CHECK_EGRESS_GUARD ||= 'in-process'
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
      { host?: unknown; path?: unknown } | number | string
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

/**
 * Taps Allow on every "<host> can be reached through relay <host:port>. Allow?" on `computer`, as its window would,
 * until stopped (Phase 3 §B.11).
 */
export function allowRelays(computer: Pick<Computer, 'mms' | 'dispatch'>): () => void {
  const asked = new Set<string>()
  const timer = setInterval(() => {
    let devices: Array<{ node: string; relay?: { offered?: string[] } }> = []
    try {
      devices = computer.mms.netEngine.status().devices
    } catch {
      return
    }
    for (const device of devices)
      for (const destination of device.relay?.offered ?? []) {
        const key = `${device.node} ${destination}`
        if (asked.has(key)) continue
        asked.add(key)
        void computer
          .dispatch('netEngine.relay.allow', { node: device.node, destination }, true)
          .catch(() => asked.delete(key))
      }
  }, 25)
  return () => clearInterval(timer)
}

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
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
let runSshConfig: string | undefined

/** The run's one SSH config (`MOUSSE_NET_TEST_SSH_CONFIG`, read by debug helpers): each test server's entry. */
function sshConfig(): string {
  if (runSshConfig) return runSshConfig
  runSshConfig = join(realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-ssh-'))), 'ssh_config')
  writeFileSync(runSshConfig, '')
  return runSshConfig
}

/** The test root and the stand-ins' certificate, made once per run (`openssl`, or MOUSSE_CHECK_OPENSSL). */
let standInPki: { key: string; cert: string } | undefined

/**
 * A run's tunnel PKI (1b §4.2): a root the debug helper trusts through MOUSSE_NET_TEST_EXTRA_ROOT (nothing goes in
 * an OS store) and a `localhost` certificate it signed.
 */
const GIT_OPENSSL = 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'

function tunnelPki(): { key: string; cert: string } {
  if (standInPki) return standInPki
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-pki-')))
  const openssl =
    process.env.MOUSSE_CHECK_OPENSSL?.trim() ||
    (process.platform === 'win32' && existsSync(GIT_OPENSSL) ? GIT_OPENSSL : 'openssl')
  const run = (...args: string[]) => execFileSync(openssl, args, { cwd: dir, stdio: 'pipe' })
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']
  run(
    'req',
    '-x509',
    ...ec,
    '-keyout',
    'root.key',
    '-out',
    'root.pem',
    '-days',
    '2',
    '-subj',
    '/CN=mousse-net check root',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  )
  run('req', ...ec, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost')
  writeFileSync(
    join(dir, 'leaf.ext'),
    [
      'subjectAltName=DNS:localhost',
      'extendedKeyUsage=serverAuth',
      'keyUsage=critical,digitalSignature',
      'basicConstraints=CA:FALSE',
      ''
    ].join('\n')
  )
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '2',
    '-extfile',
    'leaf.ext'
  )
  run('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der')
  process.env.MOUSSE_NET_TEST_EXTRA_ROOT = join(dir, 'root.der')
  standInPki = {
    key: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    cert: readFileSync(join(dir, 'leaf.pem'), 'utf8') + readFileSync(join(dir, 'root.pem'), 'utf8')
  }
  return standInPki
}

/**
 * A TLS-terminating tunnel stand-in on loopback (1b §14 `ws`): the outer TLS ends here, with a certificate from
 * the run's test root, and the plain bytes go on to the helper's ws listener (`wsPort()` at each connection, so a
 * helper restart is followed). Its route is `wss://localhost:<port>/t/mousse-net/1`.
 */
async function tunnelStandIn(
  wsPort: () => number | undefined
): Promise<{ route: string; close: () => Promise<void> }> {
  const { key, cert } = tunnelPki()
  const open = new Set<Socket>()
  const server = createTlsServer({ key, cert, ALPNProtocols: ['http/1.1'] }, (socket) => {
    const port = wsPort()
    if (!port) return socket.destroy()
    const plain = netConnect(port, '127.0.0.1')
    for (const one of [socket, plain]) {
      open.add(one)
      one.on('close', () => open.delete(one))
    }
    socket.on('error', () => plain.destroy())
    plain.on('error', () => socket.destroy())
    socket.pipe(plain).pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    route: `wss://localhost:${port}/t/mousse-net/1`,
    close: () => closeServer(server, open)
  }
}

/** Stops a test server: its open connections end at once (a close alone waits for every one to end). */
function closeServer(
  server: { close(done: () => void): unknown },
  open: Set<Socket>
): Promise<void> {
  for (const socket of open) socket.destroy()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

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
