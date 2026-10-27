import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import { CHAT_CAPABILITY, type ChatConversation, type ChatsSnapshot } from '../src/shared/chats'
import type { ChatResourceSnapshot, ChatSharedFile, ChatSharedFileWriteResult } from '../src/shared/chatResources'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

// Real profile composition, framed transport, LLM loop and filesystem; provider I/O is deterministic.
describe('Chats daemon composition', () => {
  it('binds persistent chats, actual provider history and shared resources to the authenticated profile and client', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = mkdtempSync(join(tmpdir(), 'mousse-chat-composition-'))
    const main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false, headless: true })
    const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner' })
    const clients: LocalMmsClient[] = []
    try {
      const manager = main.getInstallationHost()!.manager
      const alice = manager.create({ displayName: 'Alice', slug: 'alice' })
      const bob = manager.create({ displayName: 'Bob', slug: 'bob' })
      const services = await main.getProfileServices(alice.id)
      const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
      const model = services.providerAuth.models.getModels(provider.id)[0]!
      vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
      vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
      const captured: Context[] = []
      const outputs = ['@forge review this', 'Reviewed.', 'I remember the review.']
      vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
        captured.push(structuredClone(context))
        return streamOf(providerResponse([{ type: 'text', text: outputs.shift()! }], 'stop')) as never
      })
      const ids = ['scout', 'forge'].map((slug) => {
        const settings = defaultAgentSettings({ name: slug === 'scout' ? 'Scout' : 'Forge', slug })
        settings.primaryModel.ref = { providerId: provider.id, modelId: model.id }
        settings.recovery.retryCount = 0
        const record = services.platform.agentDefinitions.createDraft({ settings, systemPrompt: `You are ${slug}.` })
        services.platform.agentDefinitions.publish(record.id, record.draftHash)
        return record.id
      })
      const endpoint = await server.start()
      const connect = async (profile: string) => {
        const client = new LocalMmsClient({ homeDir: join(root, 'home'), endpoint, ownerToken: 'fixture-owner', clientType: 'gui', requestedCapabilities: ['profiles-v1', CHAT_CAPABILITY] })
        clients.push(client); await client.connect(); await client.request('profiles.bind', { profile }); return client
      }
      const one = await connect(alice.id), two = await connect(alice.id), foreign = await connect(bob.id)
      expect((await one.request<ChatsSnapshot>('chats.snapshot', {})).agents.map((agent) => agent.name)).toEqual(['Forge', 'Scout'])
      expect((await foreign.request<ChatsSnapshot>('chats.snapshot', {})).agents).toEqual([])
      const chat = await one.request<ChatConversation>('chats.create', { kind: 'group', name: 'Review', agentIds: ids })
      const admitted = await one.request<ChatConversation>('chats.send', { chatId: chat.id, text: '@scout start', clientMessageId: 'first' })
      expect(admitted.run?.state).toBe('running')
      await services.platform.chats.waitForIdle()
      const completed = await two.request<ChatConversation>('chats.get', { chatId: chat.id })
      expect(completed.messages.map((entry) => entry.participantId)).toEqual(['self', ids[0], ids[1]])
      expect(completed.run?.state).toBe('completed')
      expect(captured[1]!.systemPrompt).toContain('Participants: You, Scout (@scout), Forge (@forge)')
      await one.request('chats.send', { chatId: chat.id, text: '@scout remember?' })
      await services.platform.chats.waitForIdle()
      expect(JSON.stringify(captured[2]!.messages)).toContain('Reviewed.')
      await expect(foreign.request('chats.get', { chatId: chat.id })).rejects.toMatchObject({ code: 'chat_not_found' })
      await expect(one.request('chats.snapshot', { profileId: bob.id })).rejects.toMatchObject({ code: 'profile_mismatch' })
      const binding = services.platform.chats.resourceBinding(chat.id)
      writeFileSync(join(binding.workspaceRoot, 'shared.txt'), 'initial')
      const fileOne = await one.request<ChatSharedFile>('chatResources.file.read', { groupId: chat.id, path: 'shared.txt' })
      const fileTwo = await two.request<ChatSharedFile>('chatResources.file.read', { groupId: chat.id, path: 'shared.txt' })
      expect(fileOne.revision).toBe(fileTwo.revision)
      const saved = await one.request<ChatSharedFileWriteResult>('chatResources.file.write', { groupId: chat.id, path: 'shared.txt', content: 'first edit', expectedRevision: fileOne.revision })
      expect(saved.status).toBe('saved')
      const conflict = await two.request<ChatSharedFileWriteResult>('chatResources.file.write', { groupId: chat.id, path: 'shared.txt', content: 'second edit', expectedRevision: fileTwo.revision })
      expect(conflict).toMatchObject({ status: 'conflict', file: { content: 'first edit' } })
      await one.request('chatResources.presence.update', { groupId: chat.id, target: { kind: 'file', id: 'shared.txt' }, cursor: { kind: 'file', revision: saved.file.revision, line: 1, column: 2 } })
      const presence = await two.request<ChatResourceSnapshot>('chatResources.snapshot', { groupId: chat.id })
      expect(presence.presence).toEqual([expect.objectContaining({ participant: { id: 'self', kind: 'person', name: 'You' }, cursor: expect.objectContaining({ column: 2 }) })])
      expect(presence.presence[0]!.clientId).not.toBe(presence.viewerClientId)
      await expect(foreign.request('chatResources.file.read', { groupId: chat.id, path: 'shared.txt' })).rejects.toMatchObject({ code: 'chat_not_found' })
      await expect(one.request('chatResources.presence.update', { groupId: chat.id, participantId: 'forge', target: { kind: 'file', id: 'shared.txt' } })).rejects.toMatchObject({ code: 'unknown_field' })
      await one.close()
      await vi.waitFor(async () => expect((await two.request<ChatResourceSnapshot>('chatResources.snapshot', { groupId: chat.id })).presence).toEqual([]))
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      await server.stop(); await main.stop()
      vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
