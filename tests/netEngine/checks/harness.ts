/**
 * What the Phase 1a owner checks share: fresh profiles in one process with the engine switched on and v1
 * networking off, each running its connections through a helper its engine service starts and starts again
 * (`startHelper`), paired with each other; a window's daemon calls on each; fake shells on an owner; what each app
 * sends its helper (`./tap`); and the marker record `scripts/net-engine-check.mjs` reads (the reason the first
 * failed step gives).
 *
 * The helper is the fake one of `../fakeHelper` on a fake network, or with `MOUSSE_NET_HELPER` set, that real
 * helper: each computer's endpoint in its profile, its key in a file, listening on loopback.
 *
 * Computers pair as the helper pairs them: the caller joins the owner's invitation and the owner's window approves
 * it, then each records the other with the grant the helper named, and the owner pairs back (`grant.add` at the
 * caller, `peer.add` at the owner).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
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

let recorded = false
function record(reason: string): void {
  const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
  if (recorded || !out) return
  recorded = true
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

  get crossed(): Crossed[] {
    return this.tap.crossed
  }
  /** Decides each message an app sends; `drop` loses it before its helper (unset after it drops one, by the caller). */
  set decide(decide: Tap['decide']) {
    this.tap.decide = decide
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
      process.env.MOUSSE_NET_ENGINE_HELPER_LISTEN_IP = '127.0.0.1'
      mms.netEngine.launcher = async () => {
        const launched = await mms.netEngine.launchBuilt()
        kill = () => launched.kill()
        return { ...launched, pipe: tapPipe(launched.pipe, () => endpoint, this.tap) }
      }
    } else {
      mms.netEngine.launcher = async () => {
        const fake = this.network.helper(`endpoint-${name}`)
        computer.fake = fake
        kill = () => fake.kill()
        const exited = new Promise<{ code: number; signal: null; stderr: string }>((resolve) =>
          fake.pipe.onClose(() => resolve({ code: 0, signal: null, stderr: '' }))
        )
        return { pipe: tapPipe(fake.pipe, () => endpoint, this.tap), exited, kill: () => fake.kill() }
      }
    }
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
    return Object.assign(computer, {
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
          params
        )
    })
  }

  /**
   * Pairs two computers both ways: `caller` joins an invitation of `owner`, whose window approves it; then the owner
   * pairs back. The join's connection is the caller's first. Answers each one's local id for the other.
   */
  async pair(
    owner: Computer,
    caller: Computer
  ): Promise<{ callerOnOwner: NodeId; ownerOnCaller: NodeId; grant: string }> {
    const invite = await owner.engine.request('invite.create')
    const enrolled = new Promise<Record<string, unknown>>((resolve) => {
      const stop = owner.engine.onEvent((event) => {
        if (event.invitation !== invite.invitation) return
        if (event.ev === 'approval')
          void owner.engine.request('approval.answer', { request: event.request, yes: true })
        if (event.ev === 'enrolled') {
          stop()
          resolve(event)
        }
      })
    })
    const joined = await caller.engine.request(
      'join',
      { ticket: invite.uri, pinned: false },
      60_000
    )
    const { grant } = await enrolled
    if (joined.identity !== owner.endpoint)
      throw new Error(`Joined ${String(joined.identity)}, not ${owner.endpoint}`)
    const back = await caller.engine.request('grant.add', {
      identity: owner.endpoint,
      name: `${owner.name} computer`
    })
    await owner.engine.request('peer.add', {
      identity: caller.endpoint,
      name: `${caller.name} computer`,
      routes: caller.engine.info.routes ?? []
    })
    const callerOnOwner = owner.mms.netEngine.pair({
      endpoint: caller.endpoint,
      fingerprint: `sha256:${caller.endpoint}`,
      grant: String(grant),
      name: `${caller.name} computer`,
      state: 'connected'
    }).localId
    const ownerOnCaller = caller.mms.netEngine.pair({
      endpoint: owner.endpoint,
      fingerprint: `sha256:${owner.endpoint}`,
      grant: String(back.grant),
      name: `${owner.name} computer`,
      state: 'connected'
    }).localId
    // The join's connection, held until the caller recorded the pairing, attaches now.
    await eventually(() => {
      if (!caller.mms.netEngine.online(ownerOnCaller)) throw new Error('not connected yet')
    })
    return { callerOnOwner, ownerOnCaller, grant: String(grant) }
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

  shells(owner: Computer): Spawned[] {
    return fakeShells(owner.mms.ptyManager, this.cleanups as Array<() => void | Promise<void>>)
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

/** The helper `mms` runs once it said hello (another than `before`). */
async function running(mms: MousseMainService, before?: EngineHelper): Promise<EngineHelper> {
  let engine: EngineHelper | undefined
  await eventually(() => {
    const status = mms.netEngine.helperStatus()
    engine = mms.netEngine.currentHelper()
    if (status.state !== 'running' || !engine || engine === before || !engine.info.identity)
      throw new Error(`helper ${status.state}${'text' in status && status.text ? `: ${status.text}` : ''}`)
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
