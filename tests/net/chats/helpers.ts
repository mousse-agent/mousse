import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Provider, type StreamOptions } from '@earendil-works/pi-ai'
import { MmsProfileServices } from '../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import { StaticAgentIntegrationLookup } from '../../../src/mms/agentDefinitions/lookups'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import { registerChatMethods } from '../../../src/mms/chats/registerMethods'
import { registerChatNetworkMethods } from '../../../src/mms/chats/network/registerMethods'
import { nativeSdkVersion, type NativeBotDefinition } from '../../../src/mms/bots/space/runtime'
import { newId } from '../../../src/shared/net'
import { ScriptedBotRuntime } from '../bots/scriptedRuntime'
import { portableRepository } from '../../../src/mms/bridge/dispatch'
import { git } from '../../../src/mms/bridge/dispatch/git'
import type { ChatTaskSelectionInput } from '../../../src/shared/chatsNetwork'
import { installExactDefinitionRuntime } from '../../fixtures/agent-platform/exactDefinitionRuntime'

export const cleanup: Array<() => void | Promise<void>> = []
export async function profile(input: { home?: string; profileId?: string; initialize?: boolean; protect?: boolean; paused?: boolean; native?: boolean } = {}) {
  const home = input.home ?? realpathSync(mkdtempSync(join(tmpdir(), 'net-chats-'))), profileId = input.profileId ?? randomUUID()
  if (!input.home) cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const domains = new DomainHandlerRegistry(), contexts: Context[] = []
  let release = () => {}
  const model: Model<'anthropic-messages'> = { id: 'chats-fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'chats-fixture', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 10000, maxTokens: 1000 }
  const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: 'LOCAL ONLY ANSWER' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  // Each model request answers once released: at once, or (paused) when the test or an abort releases it.
  const next = (_context: Context, signal: AbortSignal) => new Promise<AssistantMessage>((resolve) => {
    release = () => resolve(message)
    signal.addEventListener('abort', release, { once: true })
    if (!input.paused) queueMicrotask(release)
  })
  const stream = (_model: Model<'anthropic-messages'>, context: Context, request: StreamOptions = {}) => {
    contexts.push(structuredClone(context))
    const output = createAssistantMessageEventStream()
    release = () => { output.push({ type: 'done', reason: 'stop', message }); output.end(message) }
    request.signal?.addEventListener('abort', release, { once: true })
    if (!input.paused) queueMicrotask(release)
    return output
  }
  const provider: Provider<'anthropic-messages'> = { id: model.provider, name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'deterministic-unpaid-chats-fixture' } }) } }, getModels: () => [model], stream, streamSimple: stream }
  auth.models.setProvider(provider)
  await auth.credentials.modify(provider.id, async () => ({ type: 'api_key', key: 'deterministic-unpaid-chats-fixture' }))
  const definition=(name:string):NativeBotDefinition=>({revision:`chats-${name}-v1`,systemPrompt:`NET ${name} ONLY`,billing:{provider:model.provider,model:model.id,api:model.api,modelDigest:'fixture-digest',sdkVersion:nativeSdkVersion(),platform:process.platform,nodeVersion:process.versions.node,runtimeVersion:'mousse-net-native-v1',maximumUnits:60,maxOutputTokens:50,maxRequestBytes:65536,evidence:'Deterministic zero-cost local SDK fixture only; no paid-provider qualification.'},readerTools:[],approval:'always',maxModelCalls:2,maxToolCalls:1,maxElapsedMs:30000})
  // Bots have no model path: scripted runtimes record each run's prompt and compartment history.
  const botRuns: Array<{ adapter: string; prompt: string; history: string[] }> = [], botRuntimes = new Map<string, ScriptedBotRuntime>()
  const definitions=new Map([['qa-public',definition('PUBLIC')],['qa-private',definition('PRIVATE')]])
  for (const adapter of definitions.keys()) botRuntimes.set(adapter, new ScriptedBotRuntime({ id: adapter, answer: 'LOCAL ONLY ANSWER', profiles: ['chat'], script: async ({ request }) => { botRuns.push({ adapter, prompt: request.prompt, history: services.bots.compartments.history(request.compartment, 100).map(turn => turn.text) }); return 'LOCAL ONLY ANSWER' } }))
  const services = new MmsProfileServices(MousseConfigStore.load(home), { homeDir: home, repoRoot: home, headless: true, requireOwnership: false,
    trustedQaBotAdapters:input.native?()=>botRuntimes:undefined }, null, home,
    { providerAuth: auth, domains, installationHome: home, profileId, allowLegacyProjectData: false })
  cleanup.push(() => services.stop())
  // The profile's Mousse MCP server, as far as the gateway sees it: a definition's app tools need a bearer.
  services.orchestrator.setMcpAttachment({ bearerForTurn: () => ({ url: 'http://127.0.0.1:9/mcp', token: 'fake-bearer', tokenHash: 'fake-hash' }), turnEnded: () => undefined, revokeThread: () => {} })
  // Agent turns run on the exact stand-in for Pi RPC, the profile's `pi:<provider>` instance; each request's context is recorded.
  const { harness } = installExactDefinitionRuntime({ orchestrator: services.orchestrator, providerId: model.provider, profileHome: home, captured: contexts, next })
  cleanup.push(() => harness.stop())
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
  return { home, profileId, services, domains, contexts, botRuns, botRuntimes, createGroup, definitions, release: () => release() }
}

// Two linked same-user profiles plus a published Group and a task selection for the target.
export async function linkedTaskFixture(){
  const caller=await profile(),target=await profile({initialize:false})
  const invite=await caller.services.net.request('bridge.invite',{}) as {invite:string}
  await target.services.net.request('bridge.join',{invite:invite.invite})
  await target.services.net.request('net.protect',{passphrase:'chats-candidate-fixture-protection'})
  const node=target.services.net.runtime().identity.self()!.node
  await vi.waitFor(()=>expect(caller.services.net.session(node).state()).toBe('open'),{timeout:10000})
  const group=await caller.createGroup()
  caller.services.chatNetwork.publish({chatId:group.id,publicationId:'task-group'})
  const targetGroup=await target.createGroup(),agent=targetGroup.participants.find(value=>value.kind==='agent')!
  const repo=join(target.home,'task-repository');mkdirSync(repo)
  await git(repo,['init','--template=']);writeFileSync(join(repo,'base.txt'),'actual target repository')
  await git(repo,['add','.']);await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base'])
  const portable=await portableRepository(repo),baseCommit=await git(repo,['rev-parse','HEAD'])
  const selection:ChatTaskSelectionInput={chatId:group.id,taskId:newId('rpc'),deviceId:node,input:{repoId:portable.repoId,baseCommit,agent:agent.definitionId!,prompt:'CHAT BOUND TASK ONLY',limits:{maxTurns:2,maxToolCalls:1,maxElapsedMs:15000}}}
  return{caller,target,repo,group,selection}
}
