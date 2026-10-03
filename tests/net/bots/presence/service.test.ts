import { afterEach, describe, expect, it } from 'vitest'
import { BotPresenceService, BotPresenceReceiver } from '../../../../src/mms/bots/presence'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
import { cleanup, peer } from '../../spaces/host/helpers'
import { setup } from '../admission/helpers'
import type { PresenceMessage } from '../../../../src/shared/net'
afterEach(cleanup)
describe('durable signed bot presence with private content suppression', () => {
  it('signs monotonically after reconstructed service and exposes only fixed private indicator', async () => {
    const f = await setup(),
      sent: PresenceMessage[] = [],
      options = {
        db: f.p.db,
        store: f.p.store,
        identity: f.p.identity,
        keys: f.p.keys,
        registry: f.registry,
        executions: f.executions,
        send: async (message: PresenceMessage) => {
          sent.push(message)
        }
      },
      first = new BotPresenceService(options)
    await first.publish(f.bot, f.parent)
    expect(sent[0].state).toBe('idle')
    const record = f.service.admit(f.message()).record
    await first.publish(f.bot, f.parent, record.id)
    expect(sent[1].state).toBe('working') // Persisted immutable private binding is the source, never caller-provided activity text.
    f.p.db.database
      .prepare("UPDATE net_executions SET binding=json_set(binding,'$.visibilityEpoch',1)")
      .run()
    await new BotPresenceService(options).publish(f.bot, f.parent, record.id)
    expect(sent[2].state).toBe('workingPrivate')
    expect(sent.map((m) => m.counter)).toEqual([1, 2, 3])
    expect(sent.every((m) => !Object.hasOwn(m, 'activity'))).toBe(true)
    for (const message of sent) {
      const { sig, ...unsigned } = message
      expect(
        f.p.identity.verifyAuthor(
          { bot: f.bot, node: f.p.identity.self()!.node, keyEpoch: 1 },
          canonicalJson(unsigned),
          Buffer.from(sig, 'base64url'),
          message.ts,
          'newWork'
        ).kind
      ).toBe('bot')
    }
    f.registry.stop(f.space.space, f.bot)
    await expect(first.publish(f.bot, f.parent)).rejects.toMatchObject({ code: 'cancelled' })
    expect(sent).toHaveLength(3)
  })
  it('rejects signed replay/forgery and becomes reconnecting at45s/offline at90s with durable replay fences after receiver restart', async () => {
    const f = await setup(),
      sent: PresenceMessage[] = [],
      producer = new BotPresenceService({
        db: f.p.db,
        store: f.p.store,
        identity: f.p.identity,
        keys: f.p.keys,
        registry: f.registry,
        executions: f.executions,
        send: async (message) => {
          sent.push(message)
        }
      }),
      options = { db: f.p.db, identity: f.p.identity, meta: f.p.projection, store: f.p.store },
      receiver = new BotPresenceReceiver(options)
    await producer.publish(f.bot, f.parent)
    const message = sent[0],
      caller = peer(f.p)
    expect(receiver.receive(message, caller)).toBe(true)
    expect(receiver.receive(message, caller)).toBe(false)
    expect(receiver.view(f.parent, f.bot).state).toBe('idle')
    const changed = { ...message, counter: message.counter + 1 }
    expect(receiver.receive(changed, caller)).toBe(false)
    expect(new BotPresenceReceiver(options).receive(message, caller)).toBe(false)
    expect(new BotPresenceReceiver(options).view(f.parent, f.bot).state).toBe('offline')
    f.p.clock.advance(45000)
    expect(receiver.view(f.parent, f.bot).state).toBe('reconnecting')
    f.p.clock.advance(45000)
    expect(receiver.view(f.parent, f.bot).state).toBe('offline')
    await producer.publish(f.bot, f.parent)
    expect(receiver.receive(sent[1], caller)).toBe(true)
    f.p.identity.revoke(f.bot)
    expect(receiver.view(f.parent, f.bot).state).toBe('offline')
    expect(receiver.receive(sent[1], caller)).toBe(false)
  })
})
