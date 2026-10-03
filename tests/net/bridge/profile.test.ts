import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { newId } from '../../../src/shared/net'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function profile() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-profile-')))
  const mms = await MousseMainService.create({ homeDir: home, repoRoot: home, headless: true, requireOwnership: false })
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => mms.stop())
  return mms
}
async function linked() {
  const target = await profile(), caller = await profile()
  expect(caller.bridge.spaces.store).toBeDefined()
  expect(caller.net.runtime().identity.self()).toBeUndefined()
  await target.net.request('net.init', { listen: true })
  await target.net.request('net.protect', { passphrase: 'bridge-profile-fixture' })
  const invite = await target.net.request('bridge.invite', {}) as { invite: string }
  await caller.net.request('bridge.join', { invite: invite.invite })
  await caller.net.request('net.protect', { passphrase: 'bridge-caller-fixture' })
  const node = target.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(caller.net.session(node).state()).toBe('open'), { timeout: 10000 })
  return { target, caller, node }
}

it('composes actual profile backend over direct TLS and keeps one mutation for aliases', async () => {
  const { target, caller, node } = await linked(), id = newId('rpc')
  const result = await caller.bridge.hub.create(node, 'actual remote thread', { id, idem: 'one-thread' }) as { thread: { id: string; name: string } }
  expect(target.threads.getThread(result.thread.id)?.name).toBe('actual remote thread')
  const alias = newId('rpc')
  expect(await caller.bridge.hub.create(node, 'actual remote thread', { id: alias, idem: 'one-thread' })).toEqual(result)
  expect(target.threads.listAllThreads().filter(thread => thread.name === 'actual remote thread')).toHaveLength(1)
  expect(await caller.bridge.hub.query(id)).toEqual(result)
  expect(caller.bridge.hub.status(alias).original).toBe(id)
  const rows = target.net.runtime().db.database.prepare("SELECT DISTINCT execution FROM net_rpc_aliases WHERE method='threads.create'").all()
  expect(rows).toHaveLength(1)
}, 20000)

it('serves signed real thread snapshots and actual profile metadata events without a model call', async () => {
  const { target, caller, node } = await linked()
  const thread = target.threads.createThread('signed display source'), events: unknown[] = [], errors: unknown[] = []
  const ref = { nodeId: node, entityId: thread.id }
  const attached = await caller.bridge.hub.attachFor('fixture-connection', ref, update => { events.push(update) }, code => { errors.push(code) })
  expect(attached.descriptor.kind).toBe('node.thread')
  expect(target.bridge.composition().authority!.canRead(attached.descriptor.id, target.net.session(caller.net.runtime().identity.self()!.node).peer)).toBe(true)
  expect(caller.bridge.hub.canReceive(attached.descriptor, caller.net.session(node).peer)).toBe(true)
  await vi.waitFor(() => expect(events.some(update => (update as { kind?: string }).kind === 'snapshot'), JSON.stringify({ events, errors })).toBe(true))
  await dispatchMethod({ mms: target, globalSequence: () => 0 }, 'threads.rename', { threadId: thread.id, name: 'updated at target' })
  await vi.waitFor(() => expect(JSON.stringify(events)).toContain('updated at target'))
  await caller.bridge.hub.call(node, 'threads.rename', { threadId: thread.id, name: 'one remote metadata event' })
  await vi.waitFor(() => expect(JSON.stringify(events)).toContain('one remote metadata event'))
  expect(events.filter(update => {
    const value = update as { kind?: string; type?: string; data?: { thread?: { name?: string } } }
    return value.kind === 'event' && value.type === 'thread.metadata' && value.data?.thread?.name === 'one remote metadata event'
  })).toHaveLength(1)
  expect(caller.bridge.hub.canReceive(attached.descriptor, caller.net.session(node).peer)).toBe(true)
  caller.bridge.hub.detachOwner('fixture-connection')
}, 20000)
