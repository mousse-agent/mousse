/**
 * Two real daemons linked over a real Net session: `owner` runs the threads and `caller` is the
 * computer whose window works on them. The caller's router is switched on, the owner lets other
 * computers work on its threads, and a call is made the way the protocol server makes it, as a `gui`
 * connection of the caller.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import type { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import type { ThreadStreamAdapter } from '../../../../src/mms/bridge/remote/ThreadStreamAdapter'
import type { RoutedClient } from '../../../../src/mms/bridge/routed/RoutedClient'
import type { ThreadRouter } from '../../../../src/mms/bridge/routed/ThreadRouter'
import type { DomainConnectionContext } from '../../../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import type { NodeId } from '../../../../src/shared/net'
import { qualifyId } from '../../../../src/shared/threadRef'

export const cleanups: Array<() => void | Promise<void>> = []
export async function cleanupAll(): Promise<void> {
  for (const close of cleanups.splice(0).reverse()) await close()
}

async function profile(): Promise<MousseMainService> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-router-')))
  const mms = await MousseMainService.create({
    homeDir: home,
    repoRoot: home,
    headless: true,
    requireOwnership: false
  })
  cleanups.push(
    () => { try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }) } catch { /* a database file the system still holds is left to the temp folder */ } },
    () => mms.stop()
  )
  return mms
}

export interface ProtocolEvent {
  type: string
  data: any
  threadId?: string
}

export type ClientType = 'gui' | 'cli' | 'bridge' | 'test'

export async function linked(options: { routing?: boolean } = {}) {
  const owner = await profile(),
    caller = await profile()
  await owner.net.request('net.init', { listen: true })
  await owner.net.request('net.protect', { passphrase: 'bridge-router-owner' })
  const invite = (await owner.net.request('bridge.invite', {})) as { invite: string }
  await caller.net.request('bridge.join', { invite: invite.invite })
  await caller.net.request('net.protect', { passphrase: 'bridge-router-caller' })
  const node = owner.net.runtime().identity.self()!.node as NodeId,
    callerNode = caller.net.runtime().identity.self()!.node as NodeId
  await vi.waitFor(() => expect(caller.net.session(node).state()).toBe('open'), { timeout: 15_000 })
  await owner.net.request('bridge.workOnThreads', { enabled: true })
  const routing = (on: boolean) => {
    ;(caller.net as unknown as { config: { features: { netBridgeThreads: boolean } } }).config.features.netBridgeThreads = on
  }
  routing(options.routing !== false)

  // The sequence of the caller's event ring, as the protocol server numbers it.
  let sequence = 0
  caller.protocolSequence = () => sequence
  const events: ProtocolEvent[] = []
  caller.events.on('protocol:event', ((event: ProtocolEvent) => {
    sequence += 1
    events.push(event)
  }) as (data: unknown) => void)

  const insideOwner = owner.bridge as unknown as { routes: OwnerRoutes; threads: ThreadStreamAdapter }
  const router = (caller.bridge as unknown as { router: ThreadRouter }).router
  const client = (): RoutedClient => router.client

  const connection = (id: string, clientType: ClientType = 'gui'): DomainConnectionContext => ({
    id,
    clientType,
    capabilities: new Set(),
    binding: { profileId: caller.profileId, epoch: 1 }
  })
  const dispatch = (
    method: string,
    params: unknown,
    conn: DomainConnectionContext = connection('window-1')
  ): Promise<any> =>
    dispatchMethod(
      { mms: caller, connection: conn, globalSequence: () => caller.protocolSequence() },
      method,
      params
    )
  const thread = (name = 'A thread') => owner.threads.createThread(name)
  const qualified = (id: string) => qualifyId(node, id)
  return {
    owner,
    caller,
    node,
    callerNode,
    routing,
    events,
    router,
    client,
    connection,
    dispatch,
    thread,
    qualified,
    insideOwner,
    ownerThreads: () => insideOwner.threads,
    /** Resolves with the error a call is refused with. */
    refused: async (run: Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> => {
      try {
        await run
      } catch (error) {
        return error as { code: string; message: string; details?: unknown }
      }
      throw new Error('The call was not refused.')
    }
  }
}
