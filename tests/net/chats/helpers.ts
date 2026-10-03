import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Provider, type StreamOptions } from '@earendil-works/pi-ai'
import { MmsProfileServices } from '../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import { StaticAgentIntegrationLookup } from '../../../src/mms/agentDefinitions/lookups'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import { registerChatMethods } from '../../../src/mms/chats/registerMethods'
import { registerChatNetworkMethods } from '../../../src/mms/chats/network/registerMethods'

export const cleanup: Array<() => void | Promise<void>> = []
export async function profile(input: { home?: string; profileId?: string; initialize?: boolean; protect?: boolean; paused?: boolean } = {}) {
  const home = input.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'net-chats-'))), profileId = input.profileId ?? randomUUID()
  if (!input.home) cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const domains = new DomainHandlerRegistry(), contexts: Context[] = []
  let release = () => {}
  const model: Model<'anthropic-messages'> = { id: 'chats-fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'chats-fixture', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 10000, maxTokens: 1000 }
  const stream = (_model: Model<'anthropic-messages'>, context: Context, request: StreamOptions = {}) => {
    contexts.push(structuredClone(context))
    const output = createAssistantMessageEventStream()
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: 'LOCAL ONLY ANSWER' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    release = () => { output.push({ type: 'done', reason: 'stop', message }); output.end(message) }
    request.signal?.addEventListener('abort', release, { once: true })
    if (!input.paused) queueMicrotask(release)
    return output
  }
  const provider: Provider<'anthropic-messages'> = { id: model.provider, name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'deterministic-unpaid-chats-fixture' } }) } }, getModels: () => [model], stream, streamSimple: stream }
  auth.models.setProvider(provider)
  await auth.credentials.modify(provider.id, async () => ({ type: 'api_key', key: 'deterministic-unpaid-chats-fixture' }))
  const services = new MmsProfileServices(MousseConfigStore.load(home), { homeDir: home, repoRoot: home, headless: true, requireOwnership: false }, null, home,
    { providerAuth: auth, domains, installationHome: home, profileId, allowLegacyProjectData: false })
  cleanup.push(() => services.stop())
  registerChatMethods(domains, () => services.platform.chats, () => services.chatNetwork)
  registerChatNetworkMethods(domains, () => services.chatNetwork)
  if (input.initialize !== false) {
    const rt = services.net.runtime()
    if (rt.identity.self() && rt.keys.state() === 'locked') await services.net.request('net.unlock', { passphrase: 'chats-candidate-fixture-protection' })
    else await services.net.request('net.init', { listen: true })
    if (input.protect !== false && !rt.keys.encryptedAtRest()) await services.net.request('net.protect', { passphrase: 'chats-candidate-fixture-protection' })
  }
  const createGroup = async () => {
    const registry = services.platform.agentDefinitions
    const settings = defaultAgentSettings({ name: 'Local agent', slug: 'local-agent', purpose: 'Local only' })
    settings.primaryModel.ref = { providerId: model.provider, modelId: model.id }
    settings.memory.scope = 'off'; settings.recovery.retryCount = 0
    const draft = registry.createDraft({ settings, systemPrompt: 'LOCAL ONLY PROMPT' })
    registry.publish(draft.id, draft.draftHash, { integrationLookup: new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write'] }) })
    return services.platform.chats.create({ kind: 'group', name: 'Publishable Group', agentIds: [draft.id] })
  }
  return { home, profileId, services, domains, contexts, createGroup, release: () => release() }
}
