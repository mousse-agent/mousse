/**
 * What the Phase 1a owner checks share: two fresh profiles in one process with the engine switched on and v1
 * networking off, paired with each other, a window's daemon calls on each, fake shells on the owner, and the
 * marker record `scripts/net-engine-check.mjs` reads (the reason the first failed step gives).
 *
 * The pairing is written directly (the ceremony lands with the pairing slice) and the two computers are joined by
 * the link `connect` makes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import type { DomainConnectionContext } from '../../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import type { EngineConnection } from '../../../src/mms/netEngine/session/transport'
import type { NodeId } from '../../../src/shared/net'
import { NET_LOCAL_CAPABILITY } from '../../../src/shared/net/local'
import { qualifyId } from '../../../src/shared/threadRef'
import { fakeShells, type Spawned } from '../../net/bridge/routed/terminalFixture'

export const DAY = 24 * 60 * 60_000
export const eventually = (check: () => unknown, timeout = 15_000) => vi.waitFor(check, { timeout })

/**
 * One step of a check. When it fails, its reason is the first one recorded for the run: the step's own word, or
 * else the code of what it threw. The check script prints it on the FAIL line.
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
  const value = error as { code?: unknown; details?: { reason?: unknown; cause?: unknown } } | undefined
  for (const word of [value?.details?.cause, value?.details?.reason])
    if (typeof word === 'string' && /^[a-z_]{1,64}$/.test(word)) return word
  return typeof value?.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code : undefined
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

interface ProtocolEvent {
  type: string
  data: any
}

export interface Pair {
  owner: MousseMainService
  caller: MousseMainService
  /** The owner, as the caller's pairing names it. */
  ownerOnCaller: NodeId
  /** The caller, as the owner's pairing names it. */
  callerOnOwner: NodeId
  grant: string
  /** Whether each profile had a `net.db` before its engine was switched on. */
  hadNetDb: { owner: boolean; caller: boolean }
  /** What the caller's windows heard. */
  events: ProtocolEvent[]
  shells: Spawned[]
  dispatch(method: string, params: unknown, local?: boolean): Promise<any>
  ownerLocal(method: string, params: unknown): Promise<any>
  q(threadId: string): string
  folder(): string
  close(): Promise<void>
}

/** A link between the two: the outbound connection on the caller and the inbound one it reaches on the owner. */
export type LinkFactory = (pair: {
  ownerOnCaller: NodeId
  callerOnOwner: NodeId
  grant: string
  endpoint: string
}) => Promise<{ outbound: EngineConnection; inbound: EngineConnection; cut(): void }>

async function profile(cleanups: Array<() => unknown>): Promise<{ mms: MousseMainService; home: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-')))
  const mms = await MousseMainService.create({ homeDir: home, repoRoot: home, headless: true, requireOwnership: false })
  cleanups.push(
    () => {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      } catch {
        // A database file the system still holds is left to the temp folder.
      }
    },
    () => mms.stop()
  )
  return { mms, home }
}

/** Two fresh profiles, the engine on in both, paired and connected. */
export async function pairProfiles(link: LinkFactory): Promise<Pair & { cut(): void; reconnect(): Promise<void> }> {
  const cleanups: Array<() => unknown> = []
  const o = await profile(cleanups),
    c = await profile(cleanups)
  const owner = o.mms,
    caller = c.mms
  const hadNetDb = {
    owner: existsSync(join(o.home, 'net', 'net.db')),
    caller: existsSync(join(c.home, 'net', 'net.db'))
  }
  await owner.netEngine.enable()
  await caller.netEngine.enable()
  const grant = 'grant-held-by-caller'
  const callerOnOwner = owner.netEngine.pair({
    endpoint: 'caller.test:7000',
    fingerprint: 'sha256:caller',
    grant,
    name: 'Caller computer',
    state: 'connected'
  }).localId
  const ownerOnCaller = caller.netEngine.pair({
    endpoint: 'owner.test:7000',
    fingerprint: 'sha256:owner',
    grant: 'grant-held-by-owner',
    name: 'Owner computer',
    state: 'connected'
  }).localId
  const events: ProtocolEvent[] = []
  let sequence = 0
  caller.protocolSequence = () => sequence
  caller.events.on('protocol:event', ((event: ProtocolEvent) => {
    sequence += 1
    events.push(event)
  }) as (data: unknown) => void)
  const shells = fakeShells(owner.ptyManager, cleanups as Array<() => void | Promise<void>>)
  let current: { cut(): void } | undefined
  const reconnect = async (): Promise<void> => {
    const made = await link({ ownerOnCaller, callerOnOwner, grant, endpoint: 'caller.test:7000' })
    current = made
    await owner.netEngine.attach(made.inbound)
    await caller.netEngine.attach(made.outbound)
  }
  await reconnect()
  const window = (local: boolean): DomainConnectionContext => ({
    id: local ? 'settings' : 'window-1',
    clientType: 'gui',
    capabilities: new Set(local ? [NET_LOCAL_CAPABILITY] : []),
    binding: { profileId: caller.profileId, epoch: 1 }
  })
  return {
    owner,
    caller,
    ownerOnCaller,
    callerOnOwner,
    grant,
    hadNetDb,
    events,
    shells,
    dispatch: (method, params, local = false) =>
      dispatchMethod({ mms: caller, connection: window(local), globalSequence: () => caller.protocolSequence() }, method, params),
    ownerLocal: (method, params) =>
      dispatchMethod(
        {
          mms: owner,
          globalSequence: () => 0,
          connection: {
            id: 'owner-window',
            clientType: 'gui',
            capabilities: new Set([NET_LOCAL_CAPABILITY]),
            binding: { profileId: owner.profileId, epoch: 1 }
          }
        },
        method,
        params
      ),
    q: (threadId) => qualifyId(ownerOnCaller, threadId),
    folder: () => {
      const path = realpathSync(mkdtempSync(join(tmpdir(), 'engine-check-folder-')))
      cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
      const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
      git('init', '-q')
      git('config', 'user.email', 'owner@example.test')
      git('config', 'user.name', 'Owner')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(path, 'a.txt'), 'one\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'first')
      return path
    },
    cut: () => current?.cut(),
    reconnect,
    close: async () => {
      vi.useRealTimers()
      current?.cut()
      for (const close of cleanups.splice(0).reverse()) await close()
    }
  }
}

/** What the caller's windows were shown of one terminal. */
export function terminalOutput(events: ProtocolEvent[], ptyId: string): string {
  return events
    .filter((event) => event.type === 'pty.data' && event.data.ptyId === ptyId)
    .map((event) => event.data.data as string)
    .join('')
}
