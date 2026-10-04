import { afterEach, expect, it, vi } from 'vitest'
import { setup } from '../admission/helpers'
import { cleanup, peer } from '../../spaces/host/helpers'
import { BotPresenceReceiver, BotPresenceService } from '../../../../src/mms/bots/presence'
import { SpaceCurrentIdentity } from '../../../../src/mms/spaces/SpaceCurrentIdentity'
import { newId, type PresenceMessage } from '../../../../src/shared/net'

afterEach(cleanup)

it('selects current proof only from the registered Space descriptor and accepts the original signature once after preparation', async () => {
  const f = await setup(),
    captured: PresenceMessage[] = []
  const current = new SpaceCurrentIdentity({
    runtime: { db: f.p.db, identity: f.p.identity, keys: f.p.keys },
    store: f.p.store,
    meta: f.p.projection,
    host: f.p.host,
    session: () => undefined
  })
  const identityForSpace = vi.fn((space) => current.presenceIdentity(space))
  const receiver = new BotPresenceReceiver({
    db: f.p.db,
    identity: f.p.identity,
    meta: f.p.projection,
    store: f.p.store,
    identityForSpace,
    viewIdentityForSpace: (space) => current.presenceDisplayIdentity(space)
  })
  const producer = new BotPresenceService({
    db: f.p.db,
    identity: f.p.identity,
    keys: f.p.keys,
    registry: f.registry,
    executions: f.executions,
    store: f.p.store,
    send: async (message) => {
      captured.push(message)
    }
  })
  try {
    await producer.publish(f.bot, f.parent)
    expect(receiver.receive(captured[0], peer(f.p))).toBe(false)
    expect(receiver.view(f.parent, f.bot).state).toBe('offline')
    identityForSpace.mockClear()
    expect(receiver.receive({ ...captured[0], stream: newId('stream') }, peer(f.p))).toBe(false)
    expect(identityForSpace).not.toHaveBeenCalled()
    await current.preparePresence(f.space.space, f.bot)
    expect(receiver.receive(captured[0], peer(f.p))).toBe(true)
    current.recordVerifiedPresence(captured[0])
    expect(identityForSpace).toHaveBeenCalledWith(f.space.space)
    expect(receiver.receive(captured[0], peer(f.p))).toBe(false)
    expect(receiver.view(f.parent, f.bot).state).toBe('idle')
    await producer.publish(f.bot, f.parent)
    const displayAsPacket = new BotPresenceReceiver({
      db: f.p.db,
      identity: current.presenceDisplayIdentity(f.space.space),
      meta: f.p.projection,
      store: f.p.store
    })
    expect(displayAsPacket.receive(captured[1], peer(f.p))).toBe(false)
    f.p.clock.advance(45000)
    expect(receiver.receive({ ...captured[0], counter: captured[0].counter + 1 }, peer(f.p))).toBe(
      false
    )
    expect(receiver.view(f.parent, f.bot).state).toBe('reconnecting')
    f.p.clock.advance(45000)
    expect(receiver.view(f.parent, f.bot).state).toBe('offline')
    f.p.identity.revoke(f.bot)
    expect(receiver.view(f.parent, f.bot).state).toBe('offline')
  } finally {
    producer.close()
    current.close()
  }
})
