import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream, type Model, type Provider, type AssistantMessage, type Context, type StreamOptions } from '@earendil-works/pi-ai'
import { MmsProfileServices } from '../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../src/mms/bridge/BridgeProfileService'
import { effectiveBotPolicyDigest, nativeSdkVersion, modelDigest, type NativeBotDefinition } from '../../../src/mms/bots/runtime'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { newId, spaceMetaStream, type StreamId, type BotPermissionRequest } from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

import {loadNativeReader,type NativeReaderModule,type NativeReaderQualification} from '../../../src/mms/bots/runtime/NativeReader'
let nativeReader:NativeReaderModule,readerQualification:NativeReaderQualification
beforeAll(async()=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'reader-approval-native-')));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}))
 let headers=process.env.NODE_HEADERS;for(const cache of[join(homedir(),'Library/Caches/node-gyp'),join(homedir(),'.cache/node-gyp')]){if(headers||!existsSync(cache))continue;headers=readdirSync(cache).filter(version=>version.startsWith('24.')).map(version=>join(cache,version,'include/node')).find(path=>existsSync(join(path,'node_api.h')))}
 if(!headers)throw Error('Node headers unavailable; actual reader qualification cannot run')
 const {buildNativeReader}=await import(new URL('../../../src/mms/bots/runtime/buildNativeReader.mjs',import.meta.url).href),artifact=buildNativeReader({headers,outfile:join(directory,'reader.node')})
 readerQualification={platform:process.platform as'darwin'|'linux',napi:8,artifactSha256:createHash('sha256').update(readFileSync(artifact)).digest('hex'),packaged:true};nativeReader=loadNativeReader(artifact,readerQualification)
})
async function profile(options: { native?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bot-central-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(MousseConfigStore.load(home), { homeDir: home, repoRoot: home, headless: true, requireOwnership: false }, null, home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false })
  cleanup.push(() => services.stop())
  const contexts: Context[] = [], signals: AbortSignal[] = []
  let release = () => {}
  const model: Model<'anthropic-messages'> = { id: 'central-fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'central-fixture', baseUrl: 'https://invalid.test', reasoning: false,
    input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 10000, maxTokens: 1000 }
  const stream = (_model: Model<'anthropic-messages'>, context: Context, request: StreamOptions = {}) => {
    contexts.push(structuredClone(context)); signals.push(request.signal!)
    const result = createAssistantMessageEventStream()
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: contexts.length===1?[{type:'toolCall',id:'bounded-read',name:'safe_read',arguments:{path:'canary.txt'}}]:[{type:'text',text:'Approved reader exact answer'}], stopReason: contexts.length===1?'toolUse':'stop', timestamp: Date.now(),
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 / 1000000 } } }
    release = () => { result.push({ type: 'done', reason: message.stopReason==='toolUse'?'toolUse':'stop', message }); result.end(message) }
    request.signal?.addEventListener('abort', release, { once: true });queueMicrotask(release)
    return result
  }
  const provider: Provider<'anthropic-messages'> = { id: model.provider, name: 'Fixture', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'deterministic-central-fixture' } }) } }, getModels: () => [model], stream, streamSimple: stream }
  auth.models.setProvider(provider)
  await auth.credentials.modify(provider.id, async () => ({ type: 'api_key', key: 'deterministic-central-fixture' }))
  const definition: NativeBotDefinition = { revision: 'central-v1', systemPrompt: 'Only the central bot compartment.', billing: { provider: model.provider, model: model.id, api: model.api,
    modelDigest: modelDigest(model), sdkVersion: nativeSdkVersion(), platform: process.platform, nodeVersion: process.versions.node, runtimeVersion: 'mousse-net-native-v1', maximumUnits: 60,
    maxOutputTokens: 50, maxRequestBytes: 65536, evidence: 'Deterministic local charge10 fixture only; no paid-provider qualification.' }, readerTools: ['safe_read'], approval: 'always', maxModelCalls: 2, maxToolCalls: 1, maxElapsedMs: 60000 }
  let bridge!: BridgeProfileService
  const net = new NetService({ profileDir: home, composeRuntime: runtime => {
    bridge = new BridgeProfileService({ services, runtime, net, nativeAdapters: options.native ? new Map([['mousse', { settings: services.settings, providerAuth: auth,
      sdkVersion: nativeSdkVersion(), definition, reader:{module:nativeReader,qualification:readerQualification,deniedRoots:[home]},qualification: { active: profile => profile === 'reader', invalidate: () => {} } }]]) : undefined })
    return bridge.composition()
  } })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { listen: true }); await net.request('net.protect', { passphrase: 'central-fixture-protection' })
  const projectRoot=realpathSync(mkdtempSync(join(tmpdir(),'owner-reader-project-')));cleanup.push(()=>rmSync(projectRoot,{recursive:true,force:true}));writeFileSync(join(projectRoot,'canary.txt'),'APPROVED READER CANARY');const project=services.projects.openProject(projectRoot)
  const chats=new ChatNetworkBindingService({profileId:services.profileId,profileHome:home,chats:services.platform.chats,runtime:()=>net.runtime(),spaces:()=>bridge.spaces,hub:()=>bridge.hub,preparePrivateAudience:(...args)=>bridge.currentIdentity.preparePrivateAudience(...args)})
  cleanup.push(()=>chats.close())
  return { chats,project,projectRoot,home, services, auth, net, get bridge() { return bridge }, contexts, signals, definition, release: () => release() }
}


import { ChatNetworkBindingService } from '../../../src/mms/chats/network/ChatNetworkBindingService'
import { BotLocalService } from '../../../src/mms/bots/BotLocalService'
import { defaultAgentSettings } from '../../../src/shared/agents/defaults'
import { StaticAgentIntegrationLookup } from '../../../src/mms/agentDefinitions/lookups'

it('projects a genuine foreign-reader approval through the bound Chat and continues only through the existing owner-local grant',async()=>{
 const host=await profile(),executor=await profile({native:true}),sender=await profile()
 const definitions=host.services.platform.agentDefinitions,settings=defaultAgentSettings({name:'Local Group only',slug:'local-group'}),draft=definitions.createDraft({settings,systemPrompt:'No history copy'})
 definitions.publish(draft.id,draft.draftHash,{integrationLookup:new StaticAgentIntegrationLookup({builtinToolIds:['read','write']})})
 const group=await host.services.platform.chats.create({kind:'group',name:'Chat-bound approval',agentIds:[draft.id]}),binding=host.chats.publish({chatId:group.id,publicationId:'reader-approval'})
 const space=binding.space,channel=binding.channel
 await executor.bridge.spaces.client.join(executor.bridge.spaces.client.prepareJoin(host.bridge.spaces.host.invite(space).text));await executor.bridge.spaces.client.connect(space)
 const executorChat=await executor.chats.bind({bindingId:'executor-approval',space,channel})
 const rt=executor.net.runtime(),self=rt.identity.self()!,bot=newId('bot'),key=rt.keys.createBotKey(bot),delegation=rt.identity.issueBotDelegation({bot,key,name:'Approval reader',hostNode:self.node})
 await vi.waitFor(()=>expect(JSON.parse(Buffer.from(host.net.runtime().identity.roster(self.user)!.payload,'base64url').toString()).bots).toHaveLength(1))
 executor.bridge.spaces.client.queue(spaceMetaStream(space),'bot.added',{record:{bot,owner:self.user,delegation,displayName:'Approval reader',profile:'reader',policy:{visibility:'public',steer:{kind:'everyone'}}}})
 await executor.bridge.spaces.flush(space)
 await sender.bridge.spaces.client.join(sender.bridge.spaces.client.prepareJoin(host.bridge.spaces.host.invite(space).text));await sender.bridge.spaces.client.connect(space)
 const senderChat=await sender.chats.bind({bindingId:'sender-approval',space,channel})
 await vi.waitFor(()=>expect(executor.bridge.spaces.meta.member(space,sender.net.runtime().identity.self()!.user)).toBeDefined())
 await vi.waitFor(()=>expect(executor.bridge.spaces.session(space)?.clockEstimate()).toBeDefined(),{timeout:25000})
 const config={space,bot,adapter:'mousse',profile:'reader' as const,projectId:executor.project.id,definitionRevision:executor.definition.revision,profileDigest:effectiveBotPolicyDigest(executor.definition,'reader'),dailyBudgetUnits:1000,runCeilingUnits:120,maxConcurrent:2,runsPerMemberHour:20}
 executor.bridge.bots.configure(config);executor.bridge.bots.qualify(config)
 const sent=await sender.chats.send({chatId:senderChat.id,text:'Read after owner consent',clientMessageId:'reader-trigger',mentions:[bot]}),trigger=sent.network!.delivery!.id
 await vi.waitFor(()=>expect(rt.executions.find({scope:space,target:bot,trigger})?.state).toBe('waitingApproval'),{timeout:10000})
 let permission:StreamId|undefined
 await vi.waitFor(()=>{permission=(executor.chats.get(executorChat.id).network!.records.find(row=>row.envelope.type==='thread.opened'&&(row.envelope.body as {private?:boolean})?.private===true)?.envelope.body as {stream?:StreamId})?.stream;expect(permission).toBeDefined()},{timeout:10000})
 let projected!:Awaited<ReturnType<typeof executor.chats.work>>
 await vi.waitFor(async()=>{projected=await executor.chats.work({chatId:executorChat.id,stream:permission!});expect(projected.records.some(row=>row.envelope.type==='bot.permission.requested')).toBe(true)},{timeout:10000})
 const request=projected.records.find(row=>row.envelope.type==='bot.permission.requested')!
 expect(request).toBeDefined();const body=request.privateBody as Extract<BotPermissionRequest,{kind:'runtimeAction'}>
 expect(body).toMatchObject({kind:'runtimeAction',bot,requester:sender.net.runtime().identity.self()!.user,trigger})
 expect(projected.private).toBe(true);expect(request.envelope.author.bot).toBe(bot);expect(executor.contexts).toHaveLength(1)
 expect(JSON.stringify(executor.contexts)).not.toContain('APPROVED READER CANARY')
 expect(JSON.stringify(host.chats.get(group.id))).not.toContain(body.summary)
 expect(rt.identity.roster(body.requester)).toBeUndefined()
 await expect(new BotLocalService(sender.bridge.bots).request('bots.grant',{stream:permission!,request:request.envelope.id,approved:true})).rejects.toThrow()
 const delivery=await new BotLocalService(executor.bridge.bots).request('bots.grant',{stream:permission!,request:request.envelope.id,approved:true})
 expect(delivery.state).toBe('sent')
 await vi.waitFor(()=>expect(rt.executions.find({scope:space,target:bot,trigger})?.state).toBe('completed'),{timeout:10000});await executor.bridge.bots.drain()
 expect(executor.contexts).toHaveLength(2);expect(JSON.stringify(executor.contexts[1])).toContain('APPROVED READER CANARY')
 const retry=await new BotLocalService(executor.bridge.bots).request('bots.grant',{stream:permission!,request:request.envelope.id,approved:true})
 expect(retry.id).toBe(delivery.id);expect(executor.contexts).toHaveLength(2)
 await expect(new BotLocalService(executor.bridge.bots).request('bots.grant',{stream:permission!,request:request.envelope.id,approved:false})).rejects.toMatchObject({code:'conflict'})
 expect(rt.identity.roster(body.requester)).toBeUndefined();expect(host.contexts).toHaveLength(0);expect(sender.contexts).toHaveLength(0)
},45000)
