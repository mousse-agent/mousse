import { afterEach, expect, it, vi } from 'vitest'
import { profile, cleanup } from './profile'
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const nodes = (p: ReturnType<typeof profile>, user: string) =>
  JSON.parse(
    Buffer.from(p.net.runtime().identity.roster(user as any)!.payload, 'base64url').toString()
  )
it('a late-joining device still discovers a private stream whose older control wrapped a since re-keyed host device', async () => {
  const host = profile(),
    member = profile(),
    phone = profile(),
    spare = profile(),
    follower = profile()
  for (const p of [host, member, spare]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'discovery-fixture' })
  }
  const space = host.spaces.host.create({ name: 'Re-keyed recipient' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await member.spaces.client.connect(space.space)
  const owner = host.net.runtime().identity.self()!
  const invite = (await host.net.request('bridge.invite', {})) as { invite: string }
  await phone.net.request('bridge.join', { invite: invite.invite, name: 'Host phone' })
  await phone.net.request('net.protect', { passphrase: 'discovery-fixture' })
  const phoneSelf = phone.net.runtime().identity.self()!
  expect(phoneSelf.user).toBe(owner.user)
  await vi.waitFor(() => expect(nodes(host, owner.user).nodes).toHaveLength(2))
  const memberSelf = member.net.runtime().identity.self()!,
    created = host.spaces.private.prepareCreation(space.space, channel, [
      owner.user,
      memberSelf.user
    ])
  await host.spaces.private.publishCreation(created.descriptor.id)
  await member.spaces.client.subscribe(channel)
  const first = host.spaces.private.state(created.descriptor.id)!.control
  const phoneWrap1 = first.wrapped.find((w) => w.node === phoneSelf.node)!
  expect(phoneWrap1).toBeDefined()
  // Re-key the phone: a new key epoch for the same node id supersedes epoch 1, which pruning drops.
  host.net.runtime().identity.issueNodeDelegation({
    node: phoneSelf.node,
    keys: spare.net.runtime().keys.nodeKeys(),
    name: 'Host phone (re-keyed)',
    caps: ['read', 'write']
  })
  const live = nodes(host, owner.user)
  expect(live.nodes).toHaveLength(2)
  expect(live.revoked).toHaveLength(0)
  const rotation = host.spaces.private.rotate(created.descriptor.id, [owner.user, memberSelf.user])
  await host.spaces.flush(space.space)
  expect(host.net.runtime().outbox.get(rotation.id)?.state).toBe('sent')
  const second = host.spaces.private.state(created.descriptor.id)!.control
  const phoneWrap2 = second.wrapped.find((w) => w.node === phoneSelf.node)!
  expect(phoneWrap2.recipientAgreementKey).not.toBe(phoneWrap1.recipientAgreementKey)
  await member.spaces.discover(space.space, created.descriptor.id)
  expect(member.spaces.private.state(created.descriptor.id)?.control.keyEpoch).toBe(2)
  const invite2 = (await member.net.request('bridge.invite', {})) as { invite: string }
  await follower.net.request('bridge.join', { invite: invite2.invite, name: 'Late follower' })
  await follower.net.request('net.protect', { passphrase: 'discovery-fixture' })
  const followerSelf = follower.net.runtime().identity.self()!
  expect(followerSelf.user).toBe(memberSelf.user)
  await follower.spaces.client.join(
    follower.spaces.client.prepareJoin(
      host.spaces.host.invite(space.space).text,
      host.spaces.meta.member(space.space, memberSelf.user)!.displayName
    )
  )
  await follower.spaces.client.connect(space.space)
  await follower.spaces.client.subscribe(channel)
  host.spaces.private.rewrap(created.descriptor.id, followerSelf.node)
  await host.spaces.flush(space.space)
  const failures: string[] = []
  follower.spaces.session(space.space)!.onClosed((error) => {
    if (error && 'code' in error) failures.push(String(error.code))
  })
  await follower.spaces.discover(space.space, created.descriptor.id)
  expect(
    follower.spaces.private
      .state(created.descriptor.id)
      ?.control.wrapped.some((w) => w.node === followerSelf.node)
  ).toBe(true)
  await follower.spaces.client.subscribe(created.descriptor.id)
  await vi.waitFor(() =>
    expect(follower.spaces.store.head(created.descriptor.id)).toEqual(
      host.spaces.store.head(created.descriptor.id)
    )
  )
  expect(failures).toEqual([])
}, 60000)
