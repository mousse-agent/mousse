import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { LocalMmsClient, MmsProtocolServer } from '../../../src/mms/protocol'
import { StaticAgentIntegrationLookup } from '../../../src/mms/agentDefinitions/lookups'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import type { ChatConversation } from '../../../src/shared/chats'
import type { ChatNetworkBinding } from '../../../src/shared/chatsNetwork'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('drops a real framed publication response after commit and recovers the original through a fresh authenticated client', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chats-framed-'))), home = join(root, 'installation')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, headless: true, requireOwnership: false })
  cleanup.push(() => main.stop())
  const manager = main.getInstallationHost()!.manager, person = manager.create({ displayName: 'Owner', slug: 'owner' }), other = manager.create({ displayName: 'Other', slug: 'other' })
  const services = await main.getProfileServices(person.id)
  const settings = defaultAgentSettings({ name: 'Local definition', slug: 'local' })
  const draft = services.platform.agentDefinitions.createDraft({ settings, systemPrompt: 'Do not copy' })
  services.platform.agentDefinitions.publish(draft.id, draft.draftHash, { integrationLookup: new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write'] }) })
  const modelRun = vi.spyOn(services.orchestrator, 'runAgentDefinition')
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'chats-framed-fixture-owner' }), endpoint = await server.start()
  cleanup.push(() => server.stop())
  const connect = async (profile: string, caps = ['profiles-v1', 'chats.v1', 'net.v1']) => {
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'chats-framed-fixture-owner', clientType: 'gui', requestedCapabilities: caps })
    cleanup.push(() => client.close()); await client.connect(); await client.request('profiles.bind', { profile }); return client
  }
  const first = await connect(person.id)
  await first.request('net.init', { listen: true }); await first.request('net.protect', { passphrase: 'chats-candidate-fixture-protection' })
  const group = await first.request<ChatConversation>('chats.create', { kind: 'group', name: 'Network Group', agentIds: [draft.id] })
  const request = { chatId: group.id, publicationId: 'framed-lost-reply' }
  const concrete = server as unknown as { sendRaw(session: { socket: { destroy(): void } }, message: any): boolean }, send = concrete.sendRaw.bind(server)
  let dropped = false
  const fault = vi.spyOn(concrete, 'sendRaw').mockImplementation((session, message) => {
    if (!dropped && message.kind === 'res' && message.ok && message.result?.publicationId === request.publicationId) { dropped = true; session.socket.destroy(); return false }
    return send(session, message)
  })
  await expect(first.request('chats.publish', request)).rejects.toThrow()
  expect(dropped).toBe(true); fault.mockRestore(); await first.close()
  const fresh = await connect(person.id)
  const original = await fresh.request<ChatNetworkBinding>('chats.publication', { chatId: group.id })
  expect(await fresh.request('chats.publish', request)).toEqual(original)
  expect(services.spaces.store.listStreams({ space: original.space, kind: 'space.channel' })).toHaveLength(1)
  const message = { chatId: group.id, text: 'a real shared message', clientMessageId: 'same-original' }
  const [one, two] = await Promise.all([fresh.request<ChatConversation>('chats.send', message), fresh.request<ChatConversation>('chats.send', message)])
  expect(one.network!.delivery!.id).toBe(two.network!.delivery!.id)
  expect(one.network!.delivery!.state).toBe('sent')
  expect(services.spaces.store.head(original.channel).seq).toBe(1)
  const withoutNet = await connect(person.id, ['profiles-v1', 'chats.v1'])
  // The existing owner protocol grants advertised domain capabilities by
  // default. Omitting net.v1 from requestedCapabilities is not a deny request.
  expect((await withoutNet.request<ChatConversation>('chats.get', { chatId: group.id })).network?.binding).toEqual(original)
  const foreign = await connect(other.id)
  await expect(foreign.request('chats.publish', request)).rejects.toMatchObject({ code: 'chat_not_found' })
  await expect(fresh.request('chats.send', { ...message, text: 'substitute' })).rejects.toMatchObject({ code: 'conflict' })
  expect(modelRun).not.toHaveBeenCalled()
}, 30000)
