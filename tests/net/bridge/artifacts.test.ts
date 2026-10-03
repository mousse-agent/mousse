import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { newId, NetError, type BlobId, type NodeCapability, type RpcId, type StreamDescriptor } from '../../../src/shared/net'
import { BridgeArtifacts, type BridgeArtifactResult } from '../../../src/mms/bridge/artifacts'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { systemClock } from '../../../src/mms/net/clock'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../src/mms/net/store/streams'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import { FileBlobStore } from '../../../src/mms/net/store/blobs'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { DurableRpcDispatcher } from '../../../src/mms/net/sync/rpcDispatcher'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import { encodeEnvelope } from '../../../src/mms/net/sync/codec'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { memoryPair } from '../harness/MemoryTransport'
import { makeTempDir } from '../harness/tmp'

const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0).reverse()) close() })
async function fixture(caps: NodeCapability[] = ['read','chat','write']) {
  let failPublication = false, effects = 0
  const targetPath = makeTempDir('artifacts-target-').path, callerPath = makeTempDir('artifacts-caller-').path
  const targetDb = new NetDatabase({ profileDir: targetPath, fault: point => { if (failPublication && point === 'streams.append.beforeCursorCommit') throw new Error('injected publication rollback') } }), callerDb = new NetDatabase({ profileDir: callerPath })
  closers.push(() => targetDb.close(), () => callerDb.close())
  const targetKeys = new FileKeyStore(targetPath), callerKeys = new FileKeyStore(callerPath)
  const targetIdentity = new NetIdentityService({ database: targetDb.database, keys: targetKeys, clock: systemClock, coordinator: targetDb })
  await targetIdentity.bootstrapAuthority('Target'); await callerKeys.initialize({ asAuthority: false })
  const user = targetIdentity.self()!.user, node = newId('node')
  targetIdentity.issueNodeDelegation({ node, keys: callerKeys.nodeKeys(), name: 'Caller', caps })
  const callerIdentity = new NetIdentityService({ database: callerDb.database, keys: callerKeys, clock: systemClock, coordinator: callerDb, self: { user, node } })
  callerIdentity.pinUser(user, targetKeys.rootKey()!); callerIdentity.acceptRoster(targetIdentity.roster()!, targetKeys.rootKey()!)
  const targetStore = new SqliteStreamStore(targetDb), callerStore = new SqliteStreamStore(callerDb), targetBlobs = new FileBlobStore(targetDb), callerBlobs = new FileBlobStore(callerDb)
  closers.push(() => targetBlobs.close(), () => callerBlobs.close())
  const targetExecutions = new SqliteExecutionLedger(targetDb), callerExecutions = new SqliteExecutionLedger(callerDb)
  const targetRpc = new DurableRpcDispatcher({ db: targetDb, executions: targetExecutions, identity: targetIdentity, clock: systemClock }), callerRpc = new DurableRpcDispatcher({ db: callerDb, executions: callerExecutions, identity: callerIdentity, clock: systemClock })
  const original = newId('rpc'), alias = newId('rpc'), requests = new Map<RpcId,RpcId>([[original,original],[alias,original]])
  let targetArtifacts!: BridgeArtifacts
  targetRpc.register({ method: 'chat.upload', capability: 'chat', mutating: true, uploadEnabled: true, handle: async (params, context) => {
    effects++
    if (params && (params as any).artifact) return { text: Buffer.from(targetArtifacts.input((params as any).artifact, context, 'chat.upload')).toString() }
    return { text: 'result '.repeat(30_000) }
  } })
  callerRpc.register({ method: 'chat.upload', capability: 'chat', mutating: true, uploadEnabled: true, handle: async () => { throw new Error('never local') } })
  targetArtifacts = new BridgeArtifacts({ db: targetDb, identity: targetIdentity, keys: targetKeys, store: targetStore, blobs: targetBlobs, rpc: targetRpc, clock: systemClock, fallback: new NodeStreamAuthority(targetIdentity,targetStore,targetBlobs,systemClock) })
  const callerArtifacts = new BridgeArtifacts({ db: callerDb, identity: callerIdentity, keys: callerKeys, store: callerStore, blobs: callerBlobs, rpc: callerRpc, clock: systemClock, fallback: new NodeStreamAuthority(callerIdentity,callerStore,callerBlobs,systemClock), ownsRequest: (rpc, method, target) => requests.has(rpc) && method === 'chat.upload' && target === targetIdentity.self()!.node, canonicalRequest: rpc => requests.get(rpc) })
  const pair = memoryPair()
  const [targetChannel, callerChannel] = await Promise.all([
    openSecureChannel(pair.b,{role:'server',credentials:targetKeys.tlsCredentials(),deadlineMs:2000}),
    openSecureChannel(pair.a,{role:'client',credentials:callerKeys.tlsCredentials(),expectedPeerFingerprint:fingerprint(Buffer.from(targetKeys.nodeKeys().transport,'base64url')),deadlineMs:2000})
  ])
  const target = new NetSyncSession({ channel: targetChannel, identity:targetIdentity,store:targetStore,blobs:targetBlobs,rpc:targetRpc,authority:targetArtifacts })
  const caller = new NetSyncSession({ channel: callerChannel, identity:callerIdentity,store:callerStore,blobs:callerBlobs,rpc:callerRpc,authority:callerArtifacts,canReceive:(descriptor,peer)=>callerArtifacts.canReceive(descriptor,peer),verifyRecord:(record,descriptor)=>callerArtifacts.verifyRecord(record,descriptor) })
  closers.push(()=>target.close(),()=>caller.close())
  await Promise.all([target.opened,caller.opened])
  return { targetDb, targetStore, targetIdentity, targetKeys, targetExecutions, targetRpc, targetBlobs, callerIdentity, callerKeys, callerStore, caller, targetArtifacts, callerArtifacts, original, alias, effects:()=>effects, fail:()=>{failPublication=true} }
}

it('publishes a large result atomically and resolves known original/alias refs over actual TLS', async () => {
  const f = await fixture(['chat'])
  const result = await f.caller.rpc('chat.upload',{}, {id:f.original,idem:'large-result',deadlineMs:5000}) as BridgeArtifactResult
  expect(result.kind).toBe('bridge.artifact.result.v1')
  expect(f.targetExecutions.find({scope:f.callerIdentity.self()!.node,target:'chat.upload',trigger:'large-result'})).toMatchObject({state:'completed',result})
  expect(f.targetStore.getById(result.artifact.stream,result.artifact.event)).toBeDefined()
  expect(f.targetBlobs.isReferenced(result.artifact.blob,result.artifact.stream)).toBe(true)
  const repeated = await f.caller.rpc('chat.upload',{}, {id:f.alias,idem:'large-result',deadlineMs:5000})
  expect(repeated).toEqual(result); expect(f.effects()).toBe(1)
  expect(await f.callerArtifacts.resolveResult(repeated,f.caller,f.alias,'chat.upload')).toEqual({text:'result '.repeat(30_000)})
  expect(await f.caller.rpcResult(f.alias,{deadlineMs:5000})).toEqual(result)
  await expect(f.callerArtifacts.resolveResult(result,f.caller,newId('rpc'),'chat.upload')).rejects.toMatchObject({code:'forbidden'})
  const forged = structuredClone(result); forged.artifact.blob = `blb_${'a'.repeat(64)}` as BlobId
  await expect(f.callerArtifacts.resolveResult(forged,f.caller,f.original,'chat.upload')).rejects.toMatchObject({code:'forbidden'})
  f.targetIdentity.revoke(f.callerIdentity.self()!.node)
  expect(f.targetArtifacts.canRead(result.artifact.stream,f.caller.peer)).toBe(false)
})

it('opens/uploads under the planned chat capability and denies uncommitted/cross-request inputs', async () => {
  const f = await fixture(['chat']), descriptor = await f.caller.rpc('bridge.artifacts.open',{forRpcId:f.original,forMethod:'chat.upload'},{id:newId('rpc'),idem:'open',deadlineMs:5000}) as StreamDescriptor
  f.callerStore.createStream(descriptor,1)
  const bytes = Buffer.from('request-owned input'), blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId
  await f.caller.putBlob(descriptor.id,blob,bytes,false)
  const event = newId('event'), self = f.callerIdentity.self()!
  const envelope = encodeEnvelope({v:1,minor:0,id:event,stream:descriptor.id,type:'artifact.published',crit:false,author:{user:self.user,node:self.node,keyEpoch:1},ts:systemClock.now(),body:{rpc:f.original,purpose:'input'},blobs:[{id:blob,bytes:bytes.length,mime:'text/plain'}]})
  await f.caller.append(descriptor.id,event,envelope,f.callerKeys.signAsNode(envelope))
  const otherRpc = newId('rpc'), other = await f.caller.rpc('bridge.artifacts.open',{forRpcId:otherRpc,forMethod:'chat.upload'},{id:newId('rpc'),idem:'other-open',deadlineMs:5000}) as StreamDescriptor
  const guessedEvent = newId('event'), guessed = encodeEnvelope({v:1,minor:0,id:guessedEvent,stream:other.id,type:'artifact.published',crit:false,author:{user:self.user,node:self.node,keyEpoch:1},ts:systemClock.now(),body:{rpc:otherRpc,purpose:'input'},blobs:[{id:blob,bytes:bytes.length,mime:'text/plain'}]})
  await expect(f.caller.append(other.id,guessedEvent,guessed,f.callerKeys.signAsNode(guessed))).rejects.toMatchObject({code:'forbidden'})
  expect(f.targetStore.getById(other.id,guessedEvent)).toBeUndefined()
  expect(f.targetBlobs.isReferenced(blob,other.id)).toBe(false)
  expect(await f.caller.rpc('chat.upload',{artifact:{stream:descriptor.id,event,blob}},{id:f.original,idem:'input',deadlineMs:5000})).toEqual({text:'request-owned input'})
  await expect(f.caller.rpc('chat.upload',{artifact:{stream:descriptor.id,event,blob}},{id:newId('rpc'),idem:'cross-request',deadlineMs:5000})).rejects.toMatchObject({code:'outcome_uncertain'})
  await expect(f.caller.rpc('bridge.artifacts.open',{forRpcId:newId('rpc'),forMethod:'unknown.method'},{id:newId('rpc'),idem:'forbidden',deadlineMs:5000})).rejects.toMatchObject({code:'forbidden'})
})

it('rejects cached-result cancellation and releases both real TLS transfer slots on mid-download abort', async () => {
  const f = await fixture()
  const result = await f.caller.rpc('chat.upload',{}, {id:f.original,idem:'cancel',deadlineMs:5000}) as BridgeArtifactResult
  await f.callerArtifacts.resolveResult(result,f.caller,f.original,'chat.upload')
  const preAborted = new AbortController(); preAborted.abort()
  await expect(f.callerArtifacts.resolveResult(result,f.caller,f.original,'chat.upload',preAborted.signal)).rejects.toMatchObject({code:'cancelled'})
  expect(f.caller.state()).toBe('open')
  const controller = new AbortController(), read = f.targetBlobs.read.bind(f.targetBlobs); let reads = 0
  f.targetBlobs.read = (blob,offset,length) => { reads++; queueMicrotask(()=>controller.abort()); return read(blob,offset,length) }
  await expect(f.callerArtifacts.resolveResult(result,f.caller,f.original,'chat.upload',controller.signal)).rejects.toMatchObject({code:'cancelled'})
  expect(reads).toBeGreaterThan(0)
  expect(f.caller.state()).toBe('closed')
  expect((f.caller as any).downloads.size).toBe(0)
})

it('rolls back the publication and terminal result together without replaying an effect', async () => {
  const f = await fixture(); f.fail()
  await expect(f.caller.rpc('chat.upload',{}, {id:f.original,idem:'rollback',deadlineMs:5000})).rejects.toMatchObject({code:'outcome_uncertain'})
  const streams = f.targetStore.listStreams({kind:'node.artifact'})
  expect(streams).toHaveLength(1); expect(f.targetStore.head(streams[0].id).seq).toBe(0)
  expect(f.targetDb.database.prepare('SELECT count(*) AS n FROM net_blob_refs').get()!.n).toBe(0)
  expect(f.targetExecutions.find({scope:f.callerIdentity.self()!.node,target:'chat.upload',trigger:'rollback'})).toMatchObject({state:'uncertain'})
  await expect(f.caller.rpc('chat.upload',{}, {id:f.alias,idem:'rollback',deadlineMs:5000})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.effects()).toBe(1)
})

it('commits a prepared bundle and domain receipt with the terminal RPC transaction', async () => {
  const f = await fixture(), id = newId('rpc'), bytes = Buffer.from('verified bundle payload')
  f.targetDb.database.exec("CREATE TABLE domain_bundle_receipt(id TEXT PRIMARY KEY,phase TEXT NOT NULL)")
  f.targetRpc.register({method:'bundle.make',capability:'write',mutating:true,handle:async(_params,context)=>{
    f.targetDb.transaction(()=>f.targetDb.database.prepare("INSERT INTO domain_bundle_receipt VALUES(?,'publishing')").run(context.id))
    const publication = f.targetArtifacts.preparePublication(bytes,'application/x-git-bundle',context,'bundle.make')
    context.onTerminalCommit!(()=>{publication.commit();f.targetDb.charge(1);f.targetDb.database.prepare("UPDATE domain_bundle_receipt SET phase='completed' WHERE id=?").run(context.id)})
    return {descriptor:publication.descriptor,artifact:publication.ref}
  }})
  const result = await f.caller.rpc('bundle.make',{}, {id,idem:'bundle-complete',deadlineMs:5000}) as {descriptor:StreamDescriptor;artifact:BridgeArtifactResult['artifact']}
  expect(f.targetDb.database.prepare('SELECT phase FROM domain_bundle_receipt WHERE id=?').get(id)?.phase).toBe('completed')
  expect(f.targetStore.getById(result.artifact.stream,result.artifact.event)).toBeDefined()
  expect(f.targetBlobs.isReferenced(result.artifact.blob,result.artifact.stream)).toBe(true)
  f.fail(); const failed = newId('rpc')
  await expect(f.caller.rpc('bundle.make',{}, {id:failed,idem:'bundle-rollback',deadlineMs:5000})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.targetDb.database.prepare('SELECT phase FROM domain_bundle_receipt WHERE id=?').get(failed)?.phase).toBe('publishing')
  const descriptor = f.targetStore.listStreams({kind:'node.artifact'}).find(row=>row.artifact!.rpc===failed)!
  expect(f.targetStore.head(descriptor.id).seq).toBe(0)
  expect(f.targetExecutions.find({scope:f.callerIdentity.self()!.node,target:'bundle.make',trigger:'bundle-rollback'})).toMatchObject({state:'uncertain'})
})
