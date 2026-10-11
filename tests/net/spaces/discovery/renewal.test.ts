import { afterEach, expect, it, vi } from 'vitest'
import { systemClock } from '../../../../src/mms/net/clock'
import { newId } from '../../../../src/shared/net'
import { profile, cleanup } from './profile'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it('verifies a same-key renewed bot lease at the original control time without requiring a replacement of its historical Meta registration', async () => {
  let elapsed = 0
  const clock = {
      ...systemClock,
      now: () => systemClock.now() + elapsed,
      monotonic: () => systemClock.monotonic() + elapsed
    },
    host = profile(clock),
    member = profile(clock)
  for (const p of [host, member]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'discovery-fixture' })
  }
  const rt = host.net.runtime(),
    owner = rt.identity.self()!,
    bot = newId('bot'),
    key = rt.keys.createBotKey(bot),
    delegation = rt.identity.issueBotDelegation({
      bot,
      key,
      name: 'Renewed same-key participant',
      hostNode: owner.node
    }),
    space = host.spaces.host.create({ name: 'Historical lease renewal' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  host.spaces.host.postMeta(space.space, 'bot.added', {
    record: {
      bot,
      owner: owner.user,
      delegation,
      displayName: 'Renewed',
      profile: 'chat',
      policy: { steer: { kind: 'everyone' }, visibility: 'private' }
    }
  })
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await member.spaces.client.connect(space.space)
  elapsed = 6 * 86400000
  for (const p of [host, member]) expect(p.net.runtime().identity.renewExpiring()).toBeDefined()
  const recipient = member.net.runtime().identity.self()!.user
  await vi.waitFor(() => {
    for (const [p, user] of [
      [host, recipient],
      [member, owner.user]
    ] as const)
      expect(
        JSON.parse(
          Buffer.from(p.net.runtime().identity.roster(user)!.payload, 'base64url').toString()
        ).issuedAt
      ).toBeGreaterThan(systemClock.now() + 5 * 86400000)
  })
  elapsed = 8 * 86400000
  const created = host.spaces.private.prepareCreation(space.space, channel, [
    owner.user,
    recipient,
    bot
  ])
  await host.spaces.private.publishCreation(created.descriptor.id)
  await member.spaces.client.subscribe(channel)
  await member.spaces.discover(space.space, created.descriptor.id)
  expect(member.spaces.private.state(created.descriptor.id)?.control.participants).toContain(bot)
}, 20000)
