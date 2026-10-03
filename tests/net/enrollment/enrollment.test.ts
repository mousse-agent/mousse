import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../src/mms/net/store/streams'
import { systemClock } from '../../../src/mms/net/clock'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import { EnrollmentService, EnrollmentGateway, EnrollmentQuarantine, invitationProof, invitationProofKey } from '../../../src/mms/net/enrollment'
import { memoryPair } from '../harness/MemoryTransport'
import { FakeClock } from '../harness/FakeClock'
import type { Clock, SecureChannel } from '../../../src/mms/net/contracts'
import type { NodeDelegation, Roster, RoutesRecord } from '../../../src/shared/net'
import { NetError } from '../../../src/shared/net'

const resources:Array<()=>void>=[],paths:string[]=[]
afterEach(()=>{for(const dispose of resources.splice(0).reverse())dispose();for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})})
async function profile(authority=false,clock:Clock=systemClock){
  const path=realpathSync(mkdtempSync(join(tmpdir(),'mousse-enroll-')));paths.push(path)
  const db=new NetDatabase({profileDir:path,clock});resources.push(()=>db.close())
  const keys=new FileKeyStore(path),identity=new NetIdentityService({database:db.database,keys,clock,coordinator:db})
  if(authority)await identity.bootstrapAuthority('Inviter')
  const routes=():ReturnType<NetIdentityService['signAsNode']>=>identity.signAsNode({v:1,node:identity.self()!.node,version:1,issuedAt:clock.now(),routes:[{transport:'direct',address:'127.0.0.1:4000',priority:1}]} satisfies RoutesRecord)
  const service=new EnrollmentService({db,identity,keys,clock,routes})
  return {path,db,keys,identity,service,clock,routes}
}
async function channels(a:Awaited<ReturnType<typeof profile>>,b:Awaited<ReturnType<typeof profile>>){
  const pair=memoryPair();resources.push(()=>pair.cut())
  const [server,client]=await Promise.all([
    openSecureChannel(pair.b,{role:'server',credentials:a.keys.tlsCredentials(),deadlineMs:1000}),
    openSecureChannel(pair.a,{role:'client',credentials:b.keys.tlsCredentials(),expectedPeerFingerprint:fingerprint(Buffer.from(a.keys.nodeKeys().transport,'base64url')),deadlineMs:1000})
  ])
  resources.push(()=>server.close(),()=>client.close());return {server,client,pair}
}
function reopen(p:Awaited<ReturnType<typeof profile>>){
  p.db.close();const db=new NetDatabase({profileDir:p.path,clock:p.clock});resources.push(()=>db.close())
  const keys=new FileKeyStore(p.path),identity=new NetIdentityService({database:db.database,keys,clock:p.clock,coordinator:db})
  const routes=()=>identity.signAsNode({v:1,node:identity.self()!.node,version:1,issuedAt:p.clock.now(),routes:[{transport:'direct',address:'127.0.0.1:4000',priority:1}]} satisfies RoutesRecord)
  return {...p,db,keys,identity,routes,service:new EnrollmentService({db,identity,keys,clock:p.clock,routes})}
}
async function prepared(clock:Clock=systemClock){const a=await profile(true,clock),b=await profile(false,clock),invite=a.service.issueNodeInvite();await b.service.prepareNodeJoin(invite.text,'Follower');return {a,b,invite}}

describe('P2 real exporter-bound atomic node enrollment',()=>{
  it('joins via one real TLS mux quarantine then reopens both profiles and uses the normal gateway',async()=>{
    let {a,b}=await prepared();const c=await channels(a,b)
    const server=new EnrollmentGateway({channel:c.server,service:a.service}),client=new EnrollmentQuarantine({channel:c.client,service:b.service,role:'joiner'})
    resources.push(()=>server.close(),()=>client.close())
    const joined=await client.completed;await server.completed
    expect(joined.state).toBe('enrolled');expect(b.identity.self()).toMatchObject({user:a.identity.self()!.user,node:joined.node,isAuthority:false})
    a=reopen(a);b=reopen(b)
    const normal=await channels(a,b),aStore=new SqliteStreamStore(a.db),bStore=new SqliteStreamStore(b.db)
    let served:NetSyncSession|undefined
    const gateway=new EnrollmentGateway({channel:normal.server,service:a.service,normalSession:(channel,mux,context)=>{served=new NetSyncSession({channel,mux,...context,identity:a.identity,store:aStore});return served}})
    const follower=new NetSyncSession({channel:normal.client,identity:b.identity,store:bStore})
    resources.push(()=>gateway.close(),()=>follower.close(),()=>aStore.close(),()=>bStore.close())
    await Promise.all([gateway.completed,follower.opened])
    expect(served!.state()).toBe('open');expect(follower.state()).toBe('open')
    a.identity.revoke(joined.node)
    await vi.waitFor(()=>{expect(served!.state()).toBe('closed');expect(follower.state()).toBe('closed')})
  })

  it('reconciles lost response after both restarts with a fresh exporter, exact original result, and expired invite',async()=>{
    const fake=new FakeClock(1700000000000);let {a,b,invite}=await prepared(fake)
    const first=await channels(a,b),request=b.service.nodeJoinRequest(first.client),result=a.service.redeemNode(request,first.server),version=a.identity.verifySigned<Roster>(result.roster,a.keys.rootKey()!).version
    first.pair.cut();a=reopen(a);b=reopen(b);fake.advance(600001)
    const retry=await channels(a,b),fresh=b.service.nodeJoinRequest(retry.client)
    expect(fresh.proof).not.toBe(request.proof)
    expect(()=>a.service.redeemNode(request,retry.server)).toThrow(expect.objectContaining({code:'invite_invalid'}))
    expect(a.service.redeemNode(fresh,retry.server)).toEqual(result)
    b.service.verifyAuthorityHello(a.service.authorityHello(),retry.client)
    b.service.acceptNodeJoin(result,retry.client)
    expect(a.identity.verifySigned<Roster>(a.identity.roster()!,a.keys.rootKey()!).version).toBe(version)
    expect(a.db.database.prepare('SELECT state FROM net_enrollment_invites WHERE id=?').get(invite.invite)!.state).toBe('consumed')
  })

  it('binds all claims and actual certificate before a token can mint a delegation or steal a known node ID',async()=>{
    const {a,b}=await prepared(),c=await channels(a,b),request=b.service.nodeJoinRequest(c.client),before=a.identity.roster()!
    expect(()=>a.service.redeemNode({...request,name:'Altered'},c.server)).toThrow(expect.objectContaining({code:'invite_invalid'}))
    const outsider=await profile(true);const substituted={...request,keys:outsider.keys.nodeKeys()}
    expect(()=>a.service.redeemNode(substituted,c.server)).toThrow(expect.objectContaining({code:'peer_key_mismatch'}))
    const token=Buffer.from(JSON.parse(Buffer.from(a.service.issueNodeInvite().text.slice(4),'base64url').toString()).token,'base64url')
    // A valid token still cannot rebind the authority's published identifier.
    const ownInvite=a.service.issueNodeInvite(),outer=JSON.parse(Buffer.from(ownInvite.text.slice(4),'base64url').toString()),stable={...request,invite:ownInvite.invite,node:a.identity.self()!.node}
    const proof=invitationProof(invitationProofKey(Buffer.from(outer.token,'base64url'),'node'),c.client.exporter('EXPORTER-mousse-net-enroll',32),stable)
    expect(()=>a.service.redeemNode({...stable,proof},c.server)).toThrow(expect.objectContaining({code:'invite_invalid'}))
    expect(a.identity.roster()).toEqual(before);expect(a.identity.self()?.isAuthority).toBe(true);token.fill(0)
  })

  it('serializes two real redeem attempts so only one keyset consumes the invite',async()=>{
    const a=await profile(true),b=await profile(),other=await profile(),invite=a.service.issueNodeInvite()
    await Promise.all([b.service.prepareNodeJoin(invite.text,'First'),other.service.prepareNodeJoin(invite.text,'Second')])
    const [left,right]=await Promise.all([channels(a,b),channels(a,other)])
    const results=await Promise.allSettled([Promise.resolve().then(()=>a.service.redeemNode(b.service.nodeJoinRequest(left.client),left.server)),Promise.resolve().then(()=>a.service.redeemNode(other.service.nodeJoinRequest(right.client),right.server))])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'invite_invalid'}})
    expect(a.identity.verifySigned<Roster>(a.identity.roster()!,a.keys.rootKey()!).nodes).toHaveLength(2)
  })

  it('rolls back invite receipt and signed roster together on a concrete pre-commit failure',async()=>{
    const {a,b,invite}=await prepared(),c=await channels(a,b),request=b.service.nodeJoinRequest(c.client),before=a.identity.roster()!
    const faulted=new EnrollmentService({db:a.db,identity:a.identity,keys:a.keys,clock:a.clock,routes:a.routes,fault(){throw new NetError('storage_full')}})
    expect(()=>faulted.redeemNode(request,c.server)).toThrow(expect.objectContaining({code:'storage_full'}))
    expect(a.identity.roster()).toEqual(before);expect(a.db.database.prepare('SELECT state FROM net_enrollment_invites WHERE id=?').get(invite.invite)!.state).toBe('active')
    // The NetDatabase correctly enters read-only recovery after storage_full. Reopen before retry.
    const healthy=reopen(a)
    expect(healthy.service.redeemNode(request,c.server)).toHaveProperty('delegation')
  })

  it('bounds issued bearer containers before secrets/receipts and roundtrips a near-limit real signed invitation',async()=>{
    const a=await profile(true)
    let last:string|undefined,rejected=false
    for(let count=8;count<24;count++){
      const routes=()=>a.identity.signAsNode({v:1,node:a.identity.self()!.node,version:count,issuedAt:a.clock.now(),routes:Array.from({length:count},(_,index)=>({transport:'relay',address:'wss://example.invalid/'+String(index)+'/'+ 'q'.repeat(1950),priority:index}))} satisfies RoutesRecord)
      const service=new EnrollmentService({db:a.db,identity:a.identity,keys:a.keys,clock:a.clock,routes})
      const before=readFileSync(join(a.path,'net','keys.json')),rows=a.db.database.prepare('SELECT COUNT(*) AS n FROM net_enrollment_invites').get()!.n
      try{last=service.issueNodeInvite().text;expect(Buffer.byteLength(last)).toBeLessThanOrEqual(64*1024)}
      catch(error){expect(error).toMatchObject({code:'too_large'});expect(readFileSync(join(a.path,'net','keys.json'))).toEqual(before);expect(a.db.database.prepare('SELECT COUNT(*) AS n FROM net_enrollment_invites').get()!.n).toBe(rows);rejected=true;break}
    }
    expect(rejected).toBe(true);expect(Buffer.byteLength(last!)).toBeGreaterThan(56*1024)
    const b=await profile();expect((await b.service.prepareNodeJoin(last!)).state).toBe('prepared')
  })

  it('renames a delegated node without changing keys, epoch, capabilities, or lease lifetime',async()=>{
    const {a,b}=await prepared(),c=await channels(a,b),result=a.service.redeemNode(b.service.nodeJoinRequest(c.client),c.server),original=a.identity.verifySigned<NodeDelegation>(result.delegation,a.keys.rootKey()!)
    const renamed=a.identity.renameNode(original.subject,'Renamed')
    const roster=a.identity.verifySigned<Roster>(renamed,a.keys.rootKey()!),current=roster.nodes.map(row=>a.identity.verifySigned<NodeDelegation>(row,a.keys.rootKey()!)).find(row=>row.subject===original.subject)!
    expect(current).toEqual({...original,name:'Renamed'})
  })
})
