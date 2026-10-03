import { afterEach, expect, it,vi } from 'vitest'
import { mkdtempSync,realpathSync,rmSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanup,disposers,peer,profile,trust,type Profile } from '../host/helpers'
import { SpaceArchiveHost } from '../../../../src/mms/spaces/archive/SpaceArchiveHost'
import { SpaceImportCoordinator } from '../../../../src/mms/spaces/archive/ImportCoordinator'
import { SpaceImportStage } from '../../../../src/mms/spaces/archive/ImportStage'
import { readVerifiedSpaceArchive } from '../../../../src/mms/spaces/archive/verify'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore,NetIdentityService,SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { FileBlobStore } from '../../../../src/mms/net/store/blobs'
import { SqliteQuotaRateLedger } from '../../../../src/mms/net/store/limits'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { MetaProjection,SpaceHostService } from '../../../../src/mms/spaces/host'
import { RosterEvidence } from '../../../../src/mms/spaces/RosterEvidence'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private/service'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { decodeBase64,signedDocument } from '../../../../src/mms/net/identity/crypto'
import { canonicalJson,decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { privateContentAAD } from '../../../../src/mms/spaces/private/service'
import { DEFAULT_NODE_CAPABILITIES,NetError,newId,type RoutesRecord,type SpaceDescriptor,type Signed } from '../../../../src/shared/net'
import { retireSpaceAuthority,verifySpaceRetirement } from '../../../../src/mms/spaces/archive/retirement'

afterEach(cleanup)
async function destination(source:Profile,directory?:string) {
  const path=directory??realpathSync(mkdtempSync(join(tmpdir(),'space-archive-destination-')))
  if(!directory)disposers.push(()=>rmSync(path,{recursive:true,force:true}))
  const db=new NetDatabase({profileDir:path,clock:source.clock});disposers.push(()=>db.close())
  const keys=new FileKeyStore(path,{passphrase:'archive-destination-test'})
  if(directory)await keys.unlock('archive-destination-test');else await keys.initialize({asAuthority:false})
  const ids=directory?undefined:{user:peer(source).user,node:newId('node')}
  if(ids)source.identity.issueNodeDelegation({node:ids.node,keys:keys.nodeKeys(),name:'Destination',caps:[...DEFAULT_NODE_CAPABILITIES]})
  const identity=new NetIdentityService({database:db.database,keys,clock:source.clock,coordinator:db,...(ids?{self:ids}:{})})
  identity.pinUser(peer(source).user,source.keys.rootKey()!);identity.acceptRoster(source.identity.roster()!,source.keys.rootKey()!)
  const evidence=new RosterEvidence(db)
  let projection:MetaProjection
  const store=new SqliteStreamStore(db,{maxRecordsPerAppend:64,append:(...args)=>projection.append(...args),finish:(...args)=>projection.finish(...args)});disposers.push(()=>store.close())
  projection=new MetaProjection({db,identity,store,historyRoster:(author,at,root)=>evidence.forAuthor(author,at,root),activatePins:roots=>identity.pinUsers(roots)})
  const limits=new SqliteQuotaRateLedger(db),blobs=new FileBlobStore(db),routes=()=>identity.signAsNode({v:1,node:identity.self()!.node,version:1,issuedAt:source.clock.now(),routes:[{transport:'direct',address:'127.0.0.1:4001',priority:1}]} satisfies RoutesRecord)
  const host=new SpaceHostService({db,identity,keys,store,projection,limits,blobs,routes,clock:source.clock})
  return {path,db,keys,identity,evidence,store,projection,limits,blobs,routes,host,clock:source.clock}
}
async function fixture() {
  const a=await profile(),b=await destination(a),space=a.host.create({name:'Move selected'}),channel=a.host.createChannel(space.space,'general')
  a.host.post(channel,'original before move')
  const archive=new SpaceArchiveHost({host:a.host,quiesce:async()=>{expect(a.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)}})
  a.host.options.archiveAccess=(s,action)=>archive.journal.allows(s,action)
  archive.freeze(space.space,'archive cut');const directory=join(a.path,'archive');await archive.export(space.space,directory,new AbortController().signal)
  const verified=readVerifiedSpaceArchive(directory,{owner:{user:peer(a).user,rootKey:a.keys.rootKey()!}});disposers.push(()=>verified.close())
  const recovery={rows:0,bytes:0,commit:()=>{expect(new SqliteExecutionLedger(b.db).exportFor(newId('bot'))).toHaveLength(0)}}
  const coordinator=new SpaceImportCoordinator({host:b.host,store:b.store,quiesce:async()=>{
    expect(b.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)
    expect(b.db.database.prepare("SELECT count(*) AS n FROM net_executions WHERE state IN ('accepted','running','waitingApproval')").get()!.n).toBe(0)
  },prepareRecovery:async()=>recovery})
  b.host.options.archiveAccess=(s,action)=>coordinator.journal.allows(s,action)
  const destinationNode=b.identity.self()!.node,transport=b.keys.nodeKeys().transport,routes=b.routes()
  const descriptor=(epoch=2):Signed=>signedDocument({v:1,space:space.space,owner:peer(a).user,hostNode:destinationNode,hostTransportKey:transport,routes,epoch,issuedAt:a.clock.now()} satisfies SpaceDescriptor,bytes=>a.keys.signAsRoot(bytes))
  return {a,b,space,channel,archive,verified,coordinator,descriptor,recovery}
}
it('keeps imported streams hidden and commits original history, higher epoch descriptor seq1 and domain journal together',async()=>{
  const f=await fixture();await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  expect(f.b.store.listStreams()).toEqual([]);expect(f.b.store.getStream(f.channel)).toBeUndefined()
  expect(()=>f.b.store.head(f.channel)).toThrow(expect.objectContaining({code:'stream_unknown'}))
  expect(()=>f.b.store.openSnapshot(f.channel)).toThrow(expect.objectContaining({code:'stream_unknown'}))
  expect(f.b.projection.position(f.space.space)).toBeUndefined()
  const record=await f.coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)
  expect(record).toMatchObject({epoch:2,seq:1});expect(decodeEnvelope(record.envelope).envelope.type).toBe('space.descriptor')
  expect(f.coordinator.journal.forSpace(f.space.space)?.state).toBe('activeNew')
  expect(f.b.store.getStream(f.channel)?.authority).toBe(f.b.identity.self()!.node)
  expect(f.b.projection.position(f.space.space)).toMatchObject({status:'active',epoch:2,seq:1})
  const original=[...f.verified.records(f.channel)][0],id=decodeEnvelope(original.envelope).envelope.id
  expect(f.b.store.getById(f.channel,id)).toEqual(original)
  f.b.host.post(f.channel,'after activation');expect(f.b.store.head(f.channel)).toEqual({epoch:2,seq:1})
  expect(new SqliteExecutionLedger(f.b.db).exportFor(newId('bot'))).toEqual([])
})
it('preserves hidden held stages and verified projection carry across an actual ledger restart',async()=>{
  const f=await fixture();await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  f.b.store.close();f.b.db.close();const b=await destination(f.a,f.b.path)
  const coordinator=new SpaceImportCoordinator({host:b.host,store:b.store,quiesce:async()=>{expect(b.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)},prepareRecovery:async()=>({rows:0,bytes:0,commit:()=>{expect(b.db.database.prepare("SELECT count(*) AS n FROM net_executions WHERE state IN ('accepted','running','waitingApproval')").get()!.n).toBe(0)}})})
  b.host.options.archiveAccess=(s,action)=>coordinator.journal.allows(s,action)
  expect(b.store.listStreams()).toEqual([]);expect(coordinator.journal.forSpace(f.space.space)?.state).toBe('importedFrozen')
  await coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)
  expect(b.projection.position(f.space.space)).toMatchObject({status:'active',epoch:2,seq:1})
})
it('rolls every visible pointer and descriptor back when recovery underdeclares its actual transaction charge',async()=>{
  const f=await fixture();await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  f.recovery.commit=()=>{f.b.db.charge(1,1)}
  await expect(f.coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)).rejects.toMatchObject({code:'too_large'})
  expect(f.b.store.listStreams()).toEqual([]);expect(f.b.projection.position(f.space.space)).toBeUndefined()
  expect(f.coordinator.journal.forSpace(f.space.space)?.state).toBe('importedFrozen')
  f.recovery.commit=()=>{expect(f.b.db.inTransaction).toBe(true);expect(f.b.db.transactionUsage.bytes).toBeGreaterThanOrEqual(Buffer.byteLength(f.b.db.database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value as string))}
  await f.coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)
  expect(f.b.projection.position(f.space.space)?.epoch).toBe(2)
})
it('requires owner signature, increasing epoch, explicit recovery and retirement proof for a move',async()=>{
  const f=await fixture()
  await expect(f.coordinator.import(f.verified,'move',new AbortController().signal)).rejects.toMatchObject({code:'forbidden'})
  expect(()=>new SpaceImportCoordinator({host:f.b.host,store:f.b.store,quiesce:async()=>{}} as never)).toThrow(expect.objectContaining({code:'forbidden'}))
  await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  await expect(f.coordinator.activate(f.space.space,f.descriptor(1),new AbortController().signal)).rejects.toMatchObject({code:'conflict'})
  const corrupt={...f.descriptor(),sig:Buffer.alloc(64).toString('base64url')}
  await expect(f.coordinator.activate(f.space.space,corrupt,new AbortController().signal)).rejects.toMatchObject({code:'bad_signature'})
  expect(f.b.store.listStreams()).toHaveLength(0)
})
it('refuses collisions without damaging unrelated data and refuses unverified synthetic archives',async()=>{
  const f=await fixture();const unrelated=f.a.host.create({name:'Destination data'}),stream=f.a.host.createChannel(unrelated.space,'keep');f.a.host.post(stream,'keep exact')
  for(const descriptor of f.a.store.listStreams({space:unrelated.space})){f.b.store.createStream(descriptor,1);const page=f.a.store.read(descriptor.id,{epoch:1,seq:0},f.a.store.head(descriptor.id).seq,65536);f.b.store.applyFromAuthority(descriptor.id,page.records)}
  await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  expect(f.b.store.listStreams({space:unrelated.space})).toHaveLength(2);expect(f.b.store.head(stream)).toEqual({epoch:1,seq:1})
  await expect(f.coordinator.import(f.verified,'restore',new AbortController().signal)).rejects.toMatchObject({code:'conflict'})
  expect(()=>SpaceImportStage.prepare(f.b.db,{...f.verified},'synthetic','restore')).toThrow(expect.objectContaining({code:'forbidden'}))
  expect(()=>f.b.db.transactionUsage).toThrow(expect.objectContaining({code:'forbidden'}))
  f.b.db.transaction(()=>{expect(f.b.db.transactionUsage).toEqual({rows:0,bytes:0});f.b.db.charge(2,3);expect(f.b.db.transactionUsage).toEqual({rows:2,bytes:3})})
})
it('retires only the selected authority, keeps signed evidence outside it and moves through an authenticated higher-epoch activation',async()=>{
  const f=await fixture(),unrelated=f.a.host.create({name:'Keep local authority'}),keep=f.a.host.createChannel(unrelated.space,'keep');f.a.host.post(keep,'retirement must preserve')
  const evidence=await retireSpaceAuthority(f.archive,f.verified,new AbortController().signal)
  verifySpaceRetirement(f.verified,evidence)
  expect(f.archive.journal.forSpace(f.space.space)?.state).toBe('retired')
  expect(f.a.store.listStreams({space:f.space.space})).toEqual([])
  expect(f.a.host.canRead(f.channel,peer(f.a))).toBe(false)
  expect(f.a.store.head(keep)).toEqual({epoch:1,seq:1});f.a.host.post(keep,'still authoritative')
  expect(f.a.db.database.prepare('SELECT digest FROM net_space_archive_retirements WHERE space=?').get(f.space.space)!.digest).toBe(f.verified.digest)
  const coordinator=new SpaceImportCoordinator({...f.coordinator.options,verifyRetirement:verifySpaceRetirement})
  await coordinator.import(f.verified,'move',new AbortController().signal,evidence)
  await coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)
  expect(f.b.projection.position(f.space.space)).toMatchObject({status:'active',epoch:2,seq:1})
  expect(await retireSpaceAuthority(f.archive,f.verified,new AbortController().signal)).toEqual(evidence)
})
it('retains local abandoned events when restoring an older backup and refuses an epoch below any locally held epoch',async()=>{
  const f=await fixture(),local=new SpaceImportCoordinator({host:f.a.host,store:f.a.store,quiesce:async()=>{expect(f.a.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)},prepareRecovery:async()=>({rows:0,bytes:0,commit:()=>{expect(f.a.db.database.prepare("SELECT count(*) AS n FROM net_executions WHERE state IN ('accepted','running','waitingApproval')").get()!.n).toBe(0)}})})
  const descriptor=(epoch:number)=>signedDocument({v:1,space:f.space.space,owner:peer(f.a).user,hostNode:peer(f.a).node,hostTransportKey:f.a.keys.nodeKeys().transport,routes:f.a.routes(),epoch,issuedAt:f.a.clock.now()} satisfies SpaceDescriptor,bytes=>f.a.keys.signAsRoot(bytes))
  await local.import(f.verified,'restore',new AbortController().signal)
  await local.activate(f.space.space,descriptor(3),new AbortController().signal)
  f.a.host.post(f.channel,'local abandoned event')
  const abandoned=f.a.store.read(f.channel,{epoch:3,seq:0},1,65536).records[0],id=decodeEnvelope(abandoned.envelope).envelope.id
  const newerBoundary=new SpaceArchiveHost({host:f.a.host,quiesce:async()=>{expect(f.a.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)}})
  newerBoundary.freeze(f.space.space,'restore older backup')
  await local.import(f.verified,'restore',new AbortController().signal)
  await expect(local.activate(f.space.space,descriptor(2),new AbortController().signal)).rejects.toMatchObject({code:'conflict'})
  await local.activate(f.space.space,descriptor(4),new AbortController().signal)
  const retained=f.a.db.database.prepare("SELECT r.id FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=? AND g.state='archived' AND r.id=?").get(f.channel,id)
  expect(retained?.id).toBe(id);expect(f.a.store.head(f.channel)).toEqual({epoch:4,seq:0})
})
it('verifies original private ciphertext without adopting an old key and refuses activation without an actual fresh controller control',async()=>{
  const a=await profile(),b=await destination(a),space=a.host.create({name:'Sealed archive'}),parent=a.host.createChannel(space.space,'general'),outbox=new SqliteOutbox(a.db)
  const participant=await profile(a.clock,'Historical participant');trust(a,participant)
  a.host.postMeta(space.space,'member.joined',{member:{user:peer(participant).user,rootKey:participant.keys.rootKey()!,role:'member',displayName:'Historical participant'}})
  const privateService=new PrivateSpaceService({db:a.db,identity:a.identity,keys:a.keys,store:a.store,meta:a.projection,outbox,clock:a.clock,privateKeys:new SqlPrivateStreamKeys({database:a.db.database,keys:a.keys,node:peer(a).node,user:peer(a).user,spaceForStream:id=>a.store.getStream(id)!.space!,transaction:work=>a.db.transaction(work)})})
  a.host.options.privateAuthorization=privateService
  const prepared=privateService.prepareCreation(space.space,parent,[peer(a).user,peer(participant).user])
  a.host.appendLocal(parent,prepared.parentEvent.id,prepared.parentEvent.envelope,prepared.parentEvent.sig)
  a.host.appendLocal(prepared.descriptor.id,prepared.event.id,prepared.event.envelope,prepared.event.sig)
  const envelope={v:1 as const,minor:0,id:newId('event'),stream:prepared.descriptor.id,type:'message.posted',crit:false,author:{user:peer(a).user,node:peer(a).node,keyEpoch:peer(a).delegation.keyEpoch},ts:a.clock.now(),auth:{metaEpoch:1,metaSeq:1}}
  const sealedBody=privateService.options.privateKeys.seal(prepared.descriptor.id,canonicalJson({text:'private plaintext must not archive'}),privateContentAAD(envelope))
  const bytes=canonicalJson({...envelope,sealed:sealedBody}),sealed={id:envelope.id,envelope:bytes,sig:a.keys.signAsNode(bytes)}
  a.host.appendLocal(prepared.descriptor.id,sealed.id,sealed.envelope,sealed.sig)
  a.host.postMeta(space.space,'member.removed',{user:peer(participant).user})
  expect(a.projection.member(space.space,peer(participant).user)).toBeUndefined()
  const archive=new SpaceArchiveHost({host:a.host,quiesce:async()=>{expect(a.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)}})
  archive.freeze(space.space,'private cut');const directory=join(a.path,'private-archive');await archive.export(space.space,directory,new AbortController().signal)
  expect(readFileSync(join(directory,'space.db')).includes(Buffer.from('private plaintext must not archive'))).toBe(false)
  const verified=readVerifiedSpaceArchive(directory,{owner:{user:peer(a).user,rootKey:a.keys.rootKey()!}});disposers.push(()=>verified.close())
  expect([...verified.rosters()].some(signed=>JSON.parse(decodeBase64(signed.payload).toString()).owner===peer(participant).user)).toBe(true)
  const coordinator=new SpaceImportCoordinator({host:b.host,store:b.store,quiesce:async()=>{expect(b.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)},prepareRecovery:async()=>({rows:0,bytes:0,commit:()=>{expect(b.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)}})})
  await coordinator.import(verified,'restore',new AbortController().signal)
  expect(b.identity.pinnedRootKey(peer(participant).user)).toBeUndefined()
  expect(b.keys.getSecret(`private/${prepared.descriptor.id}/1`)).toBeUndefined()
  const descriptor=signedDocument({v:1,space:space.space,owner:peer(a).user,hostNode:b.identity.self()!.node,hostTransportKey:b.keys.nodeKeys().transport,routes:b.routes(),epoch:2,issuedAt:a.clock.now()} satisfies SpaceDescriptor,bytes=>a.keys.signAsRoot(bytes))
  await expect(coordinator.activate(space.space,descriptor,new AbortController().signal)).rejects.toMatchObject({code:'forbidden'})
  expect(b.store.getStream(prepared.descriptor.id)).toBeUndefined();expect(b.keys.getSecret(`private/${prepared.descriptor.id}/1`)).toBeUndefined()
})
it('rejects an excessive prepared budget before starting any visibility commit',async()=>{
  const f=await fixture();await f.coordinator.import(f.verified,'restore',new AbortController().signal)
  f.recovery.rows=500;f.recovery.commit=()=>{throw new Error('Must not execute')}
  await expect(f.coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)).rejects.toMatchObject({code:'too_large'})
  expect(f.coordinator.journal.forSpace(f.space.space)?.state).toBe('importedFrozen');expect(f.b.store.listStreams()).toEqual([])
})
it('re-imports an interrupted hidden materialization only on an explicit request for the same verified archive',async()=>{
  const f=await fixture(),op=f.coordinator.journal.create(f.space.space,f.verified.manifest.frozen,'importing','restore',f.verified.digest)
  SpaceImportStage.prepare(f.b.db,f.verified,op.id,'restore')
  f.b.db.database.prepare("UPDATE net_space_archive_imports SET value=json_set(value,'$.complete',json('false')) WHERE operation=?").run(op.id)
  f.b.store.close();f.b.db.close();const b=await destination(f.a,f.b.path)
  const coordinator=new SpaceImportCoordinator({host:b.host,store:b.store,quiesce:async()=>{expect(b.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)},prepareRecovery:async()=>({rows:0,bytes:0,commit:()=>{expect(b.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)}})})
  expect(coordinator.journal.forSpace(f.space.space)?.state).toBe('importing');expect(b.store.listStreams()).toEqual([])
  await coordinator.import(f.verified,'restore',new AbortController().signal)
  await coordinator.activate(f.space.space,f.descriptor(),new AbortController().signal)
  expect(b.projection.position(f.space.space)?.epoch).toBe(2)
})
it('resumes fenced retirement cleanup after an actual restart without losing evidence or reopening old authority',async()=>{
  const f=await fixture(),fault=vi.spyOn(f.a.db,'checkpoint').mockImplementation(point=>{if(point==='spaces.archive.retirement.beforeCommit')throw new NetError('cancelled')})
  await expect(retireSpaceAuthority(f.archive,f.verified,new AbortController().signal)).rejects.toMatchObject({code:'cancelled'});fault.mockRestore()
  expect(f.archive.journal.forSpace(f.space.space)?.state).toBe('retiring');expect(f.a.host.canRead(f.channel,peer(f.a))).toBe(false)
  f.a.store.close();f.a.db.close();const a=await profile(f.a.clock,'Owner',f.a.path),archive=new SpaceArchiveHost({host:a.host,quiesce:async()=>{expect(a.store.listStreams({space:f.space.space})).toEqual([])}})
  const evidence=await retireSpaceAuthority(archive,f.verified,new AbortController().signal)
  verifySpaceRetirement(f.verified,evidence);expect(archive.journal.forSpace(f.space.space)?.state).toBe('retired');expect(a.store.listStreams({space:f.space.space})).toEqual([])
})
