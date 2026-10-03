/** Fixed test-only owner entry. No received DTO selects code, credentials, tools,
 * qualification, or filesystem roots. The ordinary CLI entry never imports it. */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessageEventStream, type Model, type Provider, type AssistantMessage, type Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../src/mms/protocol'
import { effectiveBotPolicyDigest, loadNativeReader, modelDigest, nativeSdkVersion, type NativeBotDefinition } from '../../../src/mms/bots/runtime'
import { publishOwnRuntimeRecord, removeOwnRuntimeRecord, readStopRequest, clearStopRequest } from '../../../src/cli/mmsRuntime'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { isId, type StreamId } from '../../../src/shared/net'

const [homeArg, projectArg, role] = process.argv.slice(2)
if (!homeArg || !projectArg || !['host', 'executor', 'sender'].includes(role)) throw Error('Fixed QA owner requires home, project, and one enumerated role')
const home = realpathSync(homeArg), project = realpathSync(projectArg)
const reportPath = join(home, 'reader-qa-report.json'), callsPath = join(home, 'reader-qa-calls.jsonl')
const artifact = resolve(dirname(fileURLToPath(import.meta.url)), '../net-native', `${process.platform}-${process.arch}`, 'reader.node')
const qualification = { platform: process.platform as 'darwin'|'linux', napi: 8, artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'), packaged: true }
const native = loadNativeReader(artifact, qualification)
const model: Model<'anthropic-messages'> = { id: 'fixed-reader', name: 'Deterministic QA reader', api: 'anthropic-messages', provider: 'fixed-reader-qa', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 10000, maxTokens: 1000 }
const definition: NativeBotDefinition = { revision: 'immutable-reader-qa-v1', systemPrompt: 'Use only the supplied reader compartment and enumerated safe tools.', billing: { provider: model.provider, model: model.id, api: model.api, modelDigest: modelDigest(model), sdkVersion: nativeSdkVersion(), platform: process.platform, nodeVersion: process.versions.node, runtimeVersion: 'mousse-net-native-v1', maximumUnits: 60, maxOutputTokens: 50, maxRequestBytes: 65536, evidence: 'Local deterministic SDK fixture: measured 10 units/call. Paid-provider qualification is false.' }, readerTools: ['safe_read','safe_list','safe_search'], approval: 'always', maxModelCalls: 2, maxToolCalls: 16, maxElapsedMs: 180000 }
let callCount = 0
const stream = (_model: Model<'anthropic-messages'>, context: Context) => {
  callCount++
  appendFileSync(callsPath, JSON.stringify({ call: callCount, at: Date.now(), systemPrompt: context.systemPrompt, tools: context.tools?.map(tool => tool.name), toolResults: context.messages.filter(message => message.role === 'toolResult') }) + '\n', { mode: 0o600 })
  const result = createAssistantMessageEventStream(), hasResults = context.messages.some(message => message.role === 'toolResult')
  const actions = [
    { name: 'safe_read', arguments: { path: 'allowed.txt' } },
    { name: 'safe_list', arguments: { path: '' } },
    { name: 'safe_search', arguments: { query: 'SAFE_READER_MARKER', path: '' } },
    { name: 'safe_read', arguments: { path: '../sensitive/secret.txt' } },
    { name: 'safe_read', arguments: { path: 'secret-link' } },
    { name: 'safe_read', arguments: { path: 'secret-hardlink' } },
    { name: 'bash', arguments: { command: 'cat ../sensitive/secret.txt' } },
    { name: 'mcp_secret', arguments: {} },
    { name: 'write', arguments: { path: 'mutated.txt', content: 'denied' } }
  ]
  const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: hasResults ? [{ type: 'text', text: 'Reader QA finished.' }] : actions.map((action, index) => ({ type: 'toolCall', id: `reader-${index}`, ...action })), stopReason: hasResults ? 'stop' : 'toolUse', timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 10/1000000 } } }
  queueMicrotask(() => { result.push({ type: 'done', reason: hasResults ? 'stop' : 'toolUse', message }); result.end(message) })
  return result
}
const provider: Provider<'anthropic-messages'> = { id: model.provider, name: 'Fixed local QA', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixed-test-only-value' } }) } }, getModels: () => [model], stream, streamSimple: stream }
const mms = await MousseMainService.create({ homeDir: home, repoRoot: project, headless: true, ownerKind: 'daemon', requireOwnership: true,
  nativeBotAdapters: role === 'executor' ? ({ services }) => new Map([['mousse', { settings: services.settings, providerAuth: services.providerAuth, sdkVersion: nativeSdkVersion(), definition, qualification: { active: profile => profile === 'reader', invalidate: () => {} }, reader: { module: native, qualification, deniedRoots: [home, join(dirname(project), 'sensitive')] } }]]) : undefined })
await mms.providerAuth.init()
mms.providerAuth.models.setProvider(provider)
await mms.providerAuth.credentials.modify(provider.id, async () => ({ type: 'api_key', key: 'fixed-test-only-value' }))
await mms.start()
const projectId = mms.projects.openProject(project).id
const admissionErrors:Array<{id:string;code:string;recvTs:number;at:number;stack:string}>=[]
const receiveStored=mms.bots.receiveStored.bind(mms.bots)
mms.bots.receiveStored=(...args)=>{const tasks=receiveStored(...args);for(const task of tasks)void task.catch(error=>{admissionErrors.push({id:decodeEnvelope(args[0].envelope).envelope.id,code:String((error as {code?:string}).code??'internal_error'),recvTs:args[0].recvTs,at:Date.now(),stack:String((error as Error).stack).split('\n').slice(0,8).join('\n')});if(admissionErrors.length>32)admissionErrors.shift()});return tasks}
const token = mms.getOwnerLease()!.owner.token
const server = new MmsProtocolServer({ mms, commandRouter: mms.browserCommandRouter, ownerToken: token })
const endpoint = await server.start()
if (!mms.getOwnerLease()!.setEndpoint(endpoint)) throw Error('Owner endpoint publication failed')
publishOwnRuntimeRecord(home, { ownerToken: token, startedAt: new Date().toISOString(), ownerKind: 'daemon' })
let closing: Promise<void>|undefined
const subscribed = new Set<StreamId>(), pendingSubscriptions = new Map<StreamId,Promise<void>>()
const subscriptionErrors: Array<{stream:StreamId;code:string}> = []
const observedSessions = new WeakSet<object>(), appendErrors:Array<{id:string;stream:string;code:string;at:number}>=[]
// This fixed QA policy represents a reader viewing locally discovered threads.
// Every unknown descriptor goes through signed parent discovery and current
// participant checks. A Host ACK alone never substitutes for subscriber data.
const subscribe = (stream:StreamId, discoverSpace?:import('../../../src/shared/net').SpaceId) => {
  if (subscribed.has(stream)||pendingSubscriptions.has(stream)||pendingSubscriptions.size>=4||subscribed.size>=64) return
  const job=(async()=>{if(discoverSpace&&!mms.spaces.store.getStream(stream))await mms.spaces.discover(discoverSpace,stream);if(mms.spaces.store.getStream(stream)?.authority===mms.net.runtime().identity.self()?.node){subscribed.add(stream);return}await mms.spaces.client.subscribe(stream);subscribed.add(stream)})()
  pendingSubscriptions.set(stream,job)
  void job.catch(error=>{subscriptionErrors.push({stream,code:String((error as {code?:string}).code??'internal_error')});if(subscriptionErrors.length>32)subscriptionErrors.shift()}).finally(()=>pendingSubscriptions.delete(stream))
}
const snapshot = () => {
  try {
    const rt = mms.net.runtime(), store = mms.spaces.store
    const permissions = rt.db.database.prepare('SELECT row FROM net_bot_permissions ORDER BY request LIMIT 64').all().map(row => {
      const permission = JSON.parse(row.row as string), record = store.getById(permission.stream, permission.request)
      return { ...permission, committed: Boolean(record), originalHash: record && createHash('sha256').update(record.envelope).digest('base64url'), originalSignature: record && Buffer.from(record.sig).toString('base64url') }
    })
    const channels = store.listStreams({ kind: 'space.channel' }).slice(0,32)
    for(const channel of channels){const session=mms.spaces.session(channel.space!);if(session&&!observedSessions.has(session)){observedSessions.add(session);const append=session.append.bind(session);session.append=async(...args)=>{try{return await append(...args)}catch(error){appendErrors.push({stream:args[0],id:args[1],code:String((error as {code?:string}).code??'internal_error'),at:Date.now()});if(appendErrors.length>32)appendErrors.shift();throw error}}}}
    if(rt.keys.state()==='unlocked'&&!closing){
      for(const permission of permissions){const descriptor=store.getStream(permission.stream),execution=rt.executions.get(permission.execution);if(descriptor?.kind==='space.private'&&execution?.binding?.space===descriptor.space&&mms.spaces.private.state(descriptor.id)?.control.participants.includes(rt.identity.self()!.user))subscribe(descriptor.id)}
      for(const channel of channels){
        const head=store.head(channel.id),records=store.read(channel.id,{epoch:head.epoch,seq:0},head.seq,1024*1024).records
        for(const record of records.slice(-64)){const envelope=decodeEnvelope(record.envelope).envelope,body=envelope.body as {stream?:unknown}|undefined;if(envelope.type==='thread.opened'&&isId('stream',body?.stream))subscribe(body!.stream as StreamId,channel.space)}
      }
    }
    const bots = channels.flatMap(channel => [...(mms.spaces.meta.state(channel.space!)?.bots.keys() ?? [])].map(bot => ({ stream: channel.id, bot, view: mms.bots.presenceReceiver.view(channel.id, bot) })))
    const report = { pid: process.pid, at: Date.now(), role, paidProviderQualified: false, artifact: qualification, readerSupported: mms.bots.nativeRuntimes.get('mousse')?.supports('reader') ?? false, definitionRevision: definition.revision, profileDigest: effectiveBotPolicyDigest(definition,'reader'), profileId: mms.profileId, projectId, callCount, self: rt.identity.self(), protected: rt.keys.encryptedAtRest(), permissions, subscriptions:[...subscribed],subscriptionErrors,appendErrors,admissionErrors, rates:rt.db.database.prepare('SELECT principal,id,created_at,units FROM net_rate_charges ORDER BY created_at DESC LIMIT 128').all(), executions: rt.db.database.prepare('SELECT id FROM net_executions ORDER BY id LIMIT 64').all().map(row => rt.executions.get(row.id as never)), budgets: rt.db.database.prepare('SELECT execution,maximum,spent FROM net_budget_calls LIMIT 128').all(), counters: rt.db.database.prepare('SELECT * FROM net_bot_presence_seen LIMIT 64').all(), presence: bots, channels:channels.map(channel=>({descriptor:channel,head:store.head(channel.id),session:mms.spaces.session(channel.space!)?.state(),clock:mms.spaces.session(channel.space!)?.clockEstimate(),members:[...(mms.spaces.meta.state(channel.space!)?.members.keys()??[])].slice(0,16).map(user=>({user,globallyPinned:!!rt.identity.pinnedRootKey(user)}))})), outbox: store.listStreams().slice(0,64).map(channel => ({ stream: channel.id, entries: rt.outbox.list(channel.id).slice(-64).map(entry => ({ id: entry.id, state: entry.state,error:entry.error,attempts:entry.attempts })) })) }
    writeFileSync(reportPath+'.tmp', JSON.stringify(report), { mode: 0o600 }); renameSync(reportPath+'.tmp',reportPath)
  } catch (error) { process.stderr.write(`QA observation: ${(error as Error).message}\n`) }
}
const shutdown = () => closing ??= (async () => {
  clearInterval(timer)
  await Promise.allSettled([...pendingSubscriptions.values()])
  await server.stop()
  // Keep the real owner and stores if a drain fails; never publish a false stop.
  await mms.stop()
  removeOwnRuntimeRecord(home, token); clearStopRequest(home)
})()
const timer = setInterval(() => { snapshot(); if (readStopRequest(home)?.token === token) void shutdown().catch(error => process.stderr.write(String(error)+'\n')) }, 100)
snapshot()
process.on('SIGTERM', () => { void shutdown().catch(error => process.stderr.write(String(error)+'\n')) })
process.on('SIGINT', () => { void shutdown().catch(error => process.stderr.write(String(error)+'\n')) })
