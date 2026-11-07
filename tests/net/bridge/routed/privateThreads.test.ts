/**
 * Routed calls from another of the user's computers never reach a private thread (`Thread.localOnly`,
 * issue #672): every call that names one, a stream of it, and a trashed one answer as if it did not exist.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { SqliteBridgeAudit } from '../../../../src/mms/net/store/audit'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { systemClock } from '../../../../src/mms/net/clock'
import { ROUTED_METHODS, isRoutedReply, routedNetMethod, type RoutedReply } from '../../../../src/shared/bridge/routed'
import { newId, type NodeCapability } from '../../../../src/shared/net'
import { cleanup, fixture } from '../hub/fixture'

afterEach(cleanup)

const COMPUTER: NodeCapability[] = ['read', 'chat', 'write', 'settings']

async function owner() {
  const f = await fixture(COMPUTER)
  new OwnerRoutes({
    services: f.mms,
    rpc: f.targetRpc,
    policy: new SqliteNodePolicy(f.targetDb, systemClock),
    audit: new SqliteBridgeAudit(f.targetDb, systemClock),
    track: (work) => work
  }).register()
  await f.connect()
  const call = async (method: string, params: Record<string, unknown>): Promise<RoutedReply> => {
    const reply = await f.caller().rpc(routedNetMethod(method), params, {
      id: newId('rpc'),
      ...(ROUTED_METHODS[method].durable ? { idem: `idem-${newId('rpc')}` } : {}),
      deadlineMs: 20_000
    })
    expect(isRoutedReply(reply)).toBe(true)
    return reply as RoutedReply
  }
  return { f, call }
}

describe('a private thread seen from another computer', () => {
  it('answers every call that names it as an unknown thread', async () => {
    const { f, call } = await owner()
    const shared = f.mms.threads.createThread('Shared', undefined, undefined, { started: true })
    const secret = f.mms.threads.createThread('Secret', undefined, undefined, { started: true, localOnly: true })
    expect(await call('threads.get', { threadId: shared.id })).toMatchObject({ ok: true })
    for (const [method, params] of [
      ['threads.get', { threadId: secret.id }],
      ['queue.list', { threadId: secret.id }],
      ['thread.snapshot', { threadId: secret.id }],
      ['threads.rename', { threadId: secret.id, name: 'Seen' }]
    ] as const) {
      expect(await call(method, params), method).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    }
    expect(f.mms.threads.getThread(secret.id)?.name).toBe('Secret')
    const listed = await call('threads.list', {})
    expect(listed.ok && (listed.result as { threads: Array<{ id: string }> }).threads.map((thread) => thread.id)).toEqual([shared.id])
  }, 60_000)

  it('a personal bot\'s thread answers every call as an unknown thread', async () => {
    const { f, call } = await owner()
    const shared = f.mms.threads.createThread('Shared', undefined, undefined, { started: true })
    const bot = f.mms.threads.ensureExecutionThread('bot:b1', 'Alpha bot', undefined, undefined, { botOwned: true })
    for (const [method, params] of [
      ['threads.get', { threadId: bot.id }],
      ['queue.list', { threadId: bot.id }],
      ['thread.snapshot', { threadId: bot.id }],
      ['threads.rename', { threadId: bot.id, name: 'Seen' }]
    ] as const) {
      expect(await call(method, params), method).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    }
    expect(f.mms.threads.getThread(bot.id)?.name).toBe('Alpha bot')
    const listed = await call('threads.list', {})
    expect(listed.ok && (listed.result as { threads: Array<{ id: string }> }).threads.map((thread) => thread.id)).toEqual([shared.id])
  }, 60_000)

  it('cannot be created or read in the trash from another computer', async () => {
    const { f, call } = await owner()
    // `localOnly` is not a key of the routed create: the call is malformed before any handler runs.
    await expect(call('threads.create', { name: 'Remote private', localOnly: true })).rejects.toMatchObject({ code: 'bad_request' })
    const secret = f.mms.threads.createThread('Secret', undefined, undefined, { started: true, localOnly: true })
    await f.mms.trashThread(secret.id)
    expect(await call('threads.inventory', { threadId: secret.id })).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    expect(f.mms.threads.lifecycleStore.get(secret.id)?.state).toBe('trashed')
  }, 60_000)
})
