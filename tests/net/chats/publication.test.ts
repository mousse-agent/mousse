import { afterEach, expect, it, vi } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, profile } from './helpers'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { signedDocument } from '../../../src/mms/net/identity/crypto'
import type { NodeDelegation, Roster } from '../../../src/shared/net'

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('keeps legacy local default execution and publishes no transcript, resources, prompts or agent identity', async () => {
  const p = await profile(), group = await p.createGroup(), chats = p.services.platform.chats
  chats.send({ chatId: group.id, text: 'OLD LOCAL CANARY', clientMessageId: 'old-message' })
  await chats.waitForIdle()
  expect(p.contexts).toHaveLength(1)
  const old = chats.get(group.id), resource = chats.resourceBinding(group.id)
  writeFileSync(join(resource.workspaceRoot, 'local-canary.txt'), 'LOCAL FILE CANARY')
  const recordPath = join(p.home, 'chats', `${group.id}.json`), originalBytes = readFileSync(recordPath)
  const binding = p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'original-publish' })
  expect(binding.localHistory).toEqual({ messageCount: 2, lastMessageId: old.messages.at(-1)!.id })
  expect(readFileSync(recordPath)).toEqual(originalBytes)
  expect(p.services.spaces.store.head(binding.channel).seq).toBe(0)
  expect(p.services.spaces.meta.entities(binding.space, 'member')).toHaveLength(1)
  expect(p.services.spaces.meta.entities(binding.space, 'bot')).toHaveLength(0)
  expect(p.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_blobs').get()!.n).toBe(0)
  expect(() => chats.send({ chatId: group.id, text: 'must not fall back' })).toThrow(expect.objectContaining({ code: 'chat_published' }))
  const sent = await p.services.chatNetwork.send({ chatId: group.id, text: 'PUBLIC MESSAGE', clientMessageId: 'network-one' })
  expect(sent.messages).toEqual(old.messages)
  expect(sent.network?.delivery?.state).toBe('sent')
  expect(sent.network?.records).toHaveLength(1)
  expect(sent.network?.records[0].envelope.author.user).toBe(p.services.net.runtime().identity.self()!.user)
  expect(JSON.stringify(sent.network)).not.toContain('OLD LOCAL CANARY')
  expect(JSON.stringify(sent.network)).not.toContain('LOCAL FILE CANARY')
  expect(JSON.stringify(sent.network)).not.toContain('LOCAL ONLY PROMPT')
  expect(p.contexts).toHaveLength(1)
})

it('retains committed publication after a lost reply and reopens the same dispatch fence without duplicate channels', async () => {
  const p = await profile(), group = await p.createGroup(), request = { chatId: group.id, publicationId: 'lost-reply' }
  const rt = p.services.net.runtime(), checkpoint = rt.db.checkpoint.bind(rt.db)
  const fault = vi.spyOn(rt.db, 'checkpoint').mockImplementation(point => { if (point === 'chats.publication.afterCommit') throw new Error('lost publication reply'); checkpoint(point) })
  expect(() => p.services.chatNetwork.publish(request)).toThrow('lost publication reply')
  const original = p.services.chatNetwork.binding(group.id)!
  fault.mockRestore()
  expect(() => p.services.platform.chats.send({ chatId: group.id, text: 'after lost reply' })).toThrow(expect.objectContaining({ code: 'chat_published' }))
  await p.services.stop()
  const reopened = await profile({ home: p.home, profileId: p.profileId })
  expect(reopened.services.chatNetwork.publish(request)).toEqual(original)
  expect(reopened.services.spaces.store.listStreams({ space: original.space, kind: 'space.channel' })).toHaveLength(1)
  expect(() => reopened.services.platform.chats.send({ chatId: group.id, text: 'after restart' })).toThrow(expect.objectContaining({ code: 'chat_published' }))
  expect(reopened.contexts).toHaveLength(0)
})

it('atomically rolls back Host effects and binding when publication fails before commit', async () => {
  const p = await profile(), group = await p.createGroup(), rt = p.services.net.runtime(), before = p.services.spaces.store.listStreams({}).length
  const checkpoint = rt.db.checkpoint.bind(rt.db), fault = vi.spyOn(rt.db, 'checkpoint').mockImplementation(point => { if (point === 'chats.publication.hostCreated') throw new Error('before commit'); checkpoint(point) })
  expect(() => p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'rollback' })).toThrow('before commit')
  fault.mockRestore()
  expect(p.services.chatNetwork.binding(group.id)).toBeUndefined()
  expect(p.services.spaces.store.listStreams({})).toHaveLength(before)
  expect(p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'rollback' }).state).toBe('published')
})

it('deduplicates concurrent publication and messages, rejects changed keys and never starts local execution', async () => {
  const p = await profile(), group = await p.createGroup(), request = { chatId: group.id, publicationId: 'parallel-publish' }
  const [one, two] = await Promise.all([Promise.resolve().then(() => p.services.chatNetwork.publish(request)), Promise.resolve().then(() => p.services.chatNetwork.publish(request))])
  expect(two).toEqual(one)
  expect(() => p.services.chatNetwork.publish({ ...request, name: 'changed' })).toThrow(expect.objectContaining({ code: 'conflict' }))
  const message = { chatId: group.id, text: 'only original', clientMessageId: 'parallel-message' }
  const sends = await Promise.all([p.services.chatNetwork.send(message), p.services.chatNetwork.send(message)])
  expect(sends[0].network?.delivery?.id).toBe(sends[1].network?.delivery?.id)
  expect(p.services.spaces.store.head(one.channel).seq).toBe(1)
  const stored = p.services.spaces.store.getById(one.channel, sends[0].network!.delivery!.id)!
  expect(decodeEnvelope(stored.envelope).envelope.refs?.mentions).toBeUndefined()
  await expect(p.services.chatNetwork.send({ ...message, text: 'substituted' })).rejects.toMatchObject({ code: 'conflict' })
  expect(p.contexts).toHaveLength(0)
})

it('does not publish during an actual local provider run and fences outer transaction escape', async () => {
  const p = await profile({ paused: true }), group = await p.createGroup(), chats = p.services.platform.chats
  chats.send({ chatId: group.id, text: 'running locally' })
  await vi.waitFor(() => expect(p.contexts).toHaveLength(1))
  expect(() => p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'busy' })).toThrow(expect.objectContaining({ code: 'chat_busy' }))
  expect(p.services.chatNetwork.binding(group.id)).toBeUndefined()
  p.release(); await chats.waitForIdle()
  expect(() => p.services.net.runtime().db.transaction(() => p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'escape' }))).toThrow(expect.objectContaining({ code: 'forbidden' }))
  expect(p.services.chatNetwork.binding(group.id)).toBeUndefined()
})

it('keeps local chats default off and denies unprotected publication before Host effects', async () => {
  const p = await profile({ initialize: false }), group = await p.createGroup()
  p.services.platform.chats.send({ chatId: group.id, text: 'local default' }); await p.services.platform.chats.waitForIdle()
  expect(p.services.net.status().enabled).toBe(false)
  const plain = await profile({ protect: false }), second = await plain.createGroup()
  expect(() => plain.services.chatNetwork.publish({ chatId: second.id, publicationId: 'unprotected' })).toThrow(expect.objectContaining({ code: 'keystore_locked' }))
  expect(plain.services.spaces.store.listStreams({ kind: 'space.meta' })).toHaveLength(0)
  expect(plain.services.chatNetwork.binding(second.id)).toBeUndefined()
})

it('projects the exact foreign human event identity from real authenticated TLS without substituting self or rewriting ChatStore', async () => {
  const owner = await profile(), member = await profile(), group = await owner.createGroup()
  const before = readFileSync(join(owner.home, 'chats', `${group.id}.json`))
  const binding = owner.services.chatNetwork.publish({ chatId: group.id, publicationId: 'foreign-person' })
  const invitation = owner.services.spaces.host.invite(binding.space)
  const id = member.services.spaces.client.prepareJoin(invitation.text)
  await member.services.spaces.client.join(id); await member.services.spaces.client.connect(binding.space)
  await member.services.spaces.client.subscribe(binding.channel)
  const event = member.services.spaces.client.post(binding.channel, 'foreign original')
  await member.services.spaces.flush(binding.space)
  const projection = owner.services.chatNetwork.get(group.id)
  expect(projection.network?.records[0].envelope).toMatchObject({ id: event, author: { user: member.services.net.runtime().identity.self()!.user }, body: { text: 'foreign original' } })
  expect(projection.network?.records[0].envelope.author.user).not.toBe('self')
  expect(readFileSync(join(owner.home, 'chats', `${group.id}.json`))).toEqual(before)
  expect(projection.messages).toEqual([])
  expect(owner.contexts).toHaveLength(0); expect(member.contexts).toHaveLength(0)
  const rt = member.services.net.runtime(), self = rt.identity.self()!, root = rt.keys.rootKey()!
  const roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, root)
  const delegation = roster.nodes.map(row => rt.identity.verifySigned<NodeDelegation>(row, root)).find(row => row.subject === self.node)!
  const peer = { user: self.user, node: self.node, delegation, transportKey: delegation.keys.transport }
  expect(owner.services.spaces.host.canRead(binding.channel, peer)).toBe(true)
  owner.services.spaces.host.postMeta(binding.space, 'member.removed', { user: self.user })
  expect(owner.services.spaces.host.canRead(binding.channel, peer)).toBe(false)
  // A removed member may retain its old display projection. The current Host
  // ACL still denies an actual request over its authenticated TLS session.
  await expect(member.services.spaces.session(binding.space)!.metaHead(owner.services.spaces.host.metaStream(binding.space))).rejects.toMatchObject({ code: 'route_unreachable' })
  const denied = member.services.spaces.client.post(binding.channel, 'revoked member')
  await member.services.spaces.flush(binding.space)
  expect(rt.outbox.get(denied)?.state).not.toBe('sent')
  expect(owner.services.spaces.store.head(binding.channel).seq).toBe(1)
  expect(owner.services.chatNetwork.get(group.id).network?.records).toHaveLength(1)
})

it('owns sending before a real committed Host append callback can begin shutdown', async () => {
  const p = await profile(), group = await p.createGroup()
  const binding = p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'owned-send' })
  let observed = -1
  const dispose = p.services.spaces.host.onAppend(stream => {
    if (stream !== binding.channel) return
    observed = p.services.chatNetwork.activeCount()
    p.services.chatNetwork.beginShutdown()
  })
  await expect(p.services.chatNetwork.send({ chatId: group.id, text: 'owned original', clientMessageId: 'owned-message' })).rejects.toMatchObject({ code: 'cancelled' })
  dispose()
  expect(observed).toBe(1)
  await p.services.chatNetwork.close()
  expect(p.services.chatNetwork.activeCount()).toBe(0)
  expect(p.services.spaces.store.head(binding.channel).seq).toBe(1)
  expect(p.contexts).toHaveLength(0)
})

it('denies published reads and sends after independently signed current identity conflict without restoring local execution', async () => {
  const p = await profile(), group = await p.createGroup(), rt = p.services.net.runtime()
  const binding = p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'current-conflict' })
  const root = rt.keys.rootKey()!, original = rt.identity.verifySigned<Roster>(rt.identity.roster()!, root)
  expect(rt.identity.acceptRoster(signedDocument({ ...original, issuedAt: original.issuedAt + 1 }, bytes => rt.keys.signAsRoot(bytes)), root).state).toBe('conflict')
  expect(() => p.services.chatNetwork.get(group.id)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  await expect(p.services.chatNetwork.send({ chatId: group.id, text: 'denied', clientMessageId: 'conflicted' })).rejects.toMatchObject({ code: 'forbidden' })
  expect(() => p.services.platform.chats.send({ chatId: group.id, text: 'local fallback' })).toThrow(expect.objectContaining({ code: 'chat_published' }))
  expect(p.services.spaces.store.head(binding.channel).seq).toBe(0)
  expect(rt.outbox.list(binding.channel)).toHaveLength(0)
  expect(p.contexts).toHaveLength(0)
})

it('denies published read/send across an unadopted authority epoch boundary before creating an original', async () => {
  const p = await profile(), group = await p.createGroup(), rt = p.services.net.runtime()
  const binding = p.services.chatNetwork.publish({ chatId: group.id, publicationId: 'epoch-boundary' })
  // The real trusted store seam changes cursors; until the independently signed
  // new metadata generation is adopted, Chats cannot dispatch in that epoch.
  p.services.spaces.store.beginEpoch(binding.space, 2)
  expect(() => p.services.chatNetwork.get(group.id)).toThrow(expect.objectContaining({ code: 'conflict' }))
  await expect(p.services.chatNetwork.send({ chatId: group.id, text: 'denied', clientMessageId: 'new-epoch' })).rejects.toMatchObject({ code: 'conflict' })
  expect(rt.outbox.list(binding.channel)).toHaveLength(0)
  expect(p.contexts).toHaveLength(0)
})
