/**
 * What a computer holds on the owner (its private streams, the results it waits to fetch in pages,
 * the values it staged) is let go of when it may no longer work on threads here, whichever way that
 * happens: the owner switch goes off, the grant is taken back, or the device is blocked. This runs
 * the real Bridge service of each computer over a real session.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import type { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import type { RoutedStaging } from '../../../../src/mms/bridge/routed/staging'
import type { ThreadStreamAdapter } from '../../../../src/mms/bridge/remote/ThreadStreamAdapter'
import { isRoutedPagedReply } from '../../../../src/shared/bridge/routed'
import { newId } from '../../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function profile() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-release-')))
  const mms = await MousseMainService.create({
    homeDir: home,
    repoRoot: home,
    headless: true,
    requireOwnership: false
  })
  cleanup.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => mms.stop()
  )
  return mms
}

async function linked() {
  const target = await profile(),
    caller = await profile()
  await target.net.request('net.init', { listen: true })
  await target.net.request('net.protect', { passphrase: 'bridge-release-fixture' })
  const invite = (await target.net.request('bridge.invite', {})) as { invite: string }
  await caller.net.request('bridge.join', { invite: invite.invite })
  await caller.net.request('net.protect', { passphrase: 'bridge-caller-fixture' })
  const node = target.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(caller.net.session(node).state()).toBe('open'), { timeout: 10000 })
  await target.net.request('bridge.workOnThreads', { enabled: true })
  const callerNode = caller.net.runtime().identity.self()!.node
  const inside = target.bridge as unknown as {
    routes: OwnerRoutes
    staging: RoutedStaging
    threads: ThreadStreamAdapter
  }
  const rpc = (method: string, params: Record<string, unknown>) =>
    caller.net
      .session(node)
      .rpc(`routed.${method}`, params, { id: newId('rpc'), deadlineMs: 20_000 })

  /** Gives the caller a stream, a result waiting to be fetched and a staged value. */
  const hold = async () => {
    const thread = target.threads.createThread('Held')
    target.orchestrator.getOrCreateSession(thread.id).messages = [
      {
        id: 'm-0',
        role: 'user',
        content: 'x'.repeat(200 * 1024),
        timestamp: new Date().toISOString()
      }
    ] as never
    await rpc('stream.open', { kind: 'thread', threadId: thread.id })
    expect(isRoutedPagedReply(await rpc('thread.snapshot', { threadId: thread.id }))).toBe(true)
    target.net
      .runtime()
      .db.database.prepare('INSERT INTO routed_stage VALUES(?,?,?,?,?,?,?)')
      .run(
        `stg_${newId('rpc').slice(4).toLowerCase().padEnd(32, '0').slice(0, 32)}`,
        callerNode,
        'strm',
        'evnt',
        'blb_x',
        10,
        Date.now()
      )
    expect(inside.threads.privateHead(callerNode, thread.id)).toBeDefined()
    expect(inside.routes.pages.heldCount(callerNode)).toBe(1)
    expect(inside.staging.count(callerNode)).toBe(1)
    return thread
  }
  const nothingHeld = (threadId: string) => {
    expect(inside.threads.privateHead(callerNode, threadId)).toBeUndefined()
    expect(inside.routes.pages.heldCount(callerNode)).toBe(0)
    expect(inside.staging.count(callerNode)).toBe(0)
  }
  return { target, caller, node, callerNode, hold, nothingHeld }
}

it('lets go of a computer’s streams, waiting results and staged values when the owner switch goes off', async () => {
  const { target, hold, nothingHeld } = await linked()
  const thread = await hold()
  await target.net.request('bridge.workOnThreads', { enabled: false })
  nothingHeld(thread.id)
}, 120_000)

it('lets go of them when the computer loses Works on threads', async () => {
  const { target, callerNode, hold, nothingHeld } = await linked()
  const thread = await hold()
  await target.net.request('bridge.setCaps', {
    node: callerNode,
    caps: ['read', 'chat', 'write']
  })
  await vi.waitFor(() => nothingHeld(thread.id))
}, 120_000)

it('lets go of them when the computer is blocked', async () => {
  const { target, callerNode, hold, nothingHeld } = await linked()
  const thread = await hold()
  await target.net.request('bridge.policy', { node: callerNode, blocked: true })
  nothingHeld(thread.id)
}, 120_000)
