import { createHash, randomUUID } from 'node:crypto'
import type { Envelope, NodeDelegation, Roster, StreamId, StreamDescriptor, StoredRecord } from '../../../shared/net'
import { NetError, newId } from '../../../shared/net'
import type { Clock, IdentityService, KeyStore, StreamStore } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'
import { canonicalJson, encodeEnvelope } from '../../net/sync/codec'

export const THREAD_EVENT_TYPES = ['thread.message','thread.message-updated','thread.messages','queue.updated','turn.started','turn.completed','turn.interrupted','turn.aborted','turn.state','turn.steered','connection.failed','thread.metadata'] as const
export interface ThreadSourceEvent { type: typeof THREAD_EVENT_TYPES[number]; data: unknown; ephemeral?:boolean }
export interface ThreadSourcePort { snapshot(threadId: string): unknown; onThread(threadId: string, listener:(event:ThreadSourceEvent)=>void):()=>void }
export interface ThreadGenerationPort { beginNodeEpoch(stream: StreamId, epoch:number):void }
interface ActiveThread { threadId:string; stream:StreamId; descriptor:StreamDescriptor; ring:StoredRecord[]; bytes:number; dispose?:()=>void }
export interface ThreadStreamOptions {
  db:NetDatabase; store:StreamStore; generations:ThreadGenerationPort; identity:IdentityService;keys:KeyStore;clock:Clock;source:ThreadSourcePort
  bootId?:string;maxRows?:number;maxBytes?:number;maxThreads?:number
  onDelta?(stream:StreamId,data:unknown):void
  onRecord?(stream:StreamId,record:StoredRecord):void
  onError?(threadId:string,error:unknown):void
}
const SNAPSHOT_MAX=32*1024*1024,CHUNK_BYTES=32*1024
/** Display-only adapter. ThreadDataStore remains authoritative; no received wrapper can execute. */
export class ThreadStreamAdapter {
  readonly store:StreamStore
  private readonly active=new Map<StreamId,ActiveThread>()
  private readonly boot:string
  constructor(private readonly options:ThreadStreamOptions){
    this.boot=options.bootId??randomUUID()
    if(!Number.isSafeInteger(options.maxRows??512)||(options.maxRows??512)<1||!Number.isSafeInteger(options.maxBytes??1024*1024)||(options.maxBytes??1024*1024)<65536)throw new NetError('bad_request')
    options.db.transaction(()=>options.db.database.exec('CREATE TABLE IF NOT EXISTS bridge_thread_streams(thread_id TEXT PRIMARY KEY,stream TEXT NOT NULL UNIQUE,boot TEXT NOT NULL) STRICT'))
    this.store=new Proxy(options.store,{get:(target,key)=>{
      if(key==='getStream')return (stream:StreamId)=>{const row=this.options.db.database.prepare('SELECT thread_id FROM bridge_thread_streams WHERE stream=?').get(stream);if(row&&!this.active.has(stream))this.activate(String(row.thread_id));return target.getStream(stream)}
      if(key==='openSnapshot')return (stream:StreamId)=>{const thread=this.active.get(stream);if(thread)this.refreshSnapshot(thread);return target.openSnapshot(stream)}
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
    }})
  }
  activate(threadId:string):StreamDescriptor{
    if(typeof threadId!=='string'||!threadId.length||threadId.length>256)throw new NetError('bad_request')
    const known=[...this.active.values()].find(thread=>thread.threadId===threadId);if(known)return known.descriptor
    if(this.active.size>=(this.options.maxThreads??64))throw new NetError('rate_limited')
    if(this.options.db.database.isTransaction)throw new NetError('forbidden','Display generations must commit before publication.')
    // Validate the actual source exists before allocating a permanent stream identity.
    this.options.source.snapshot(threadId)
    const self=this.options.identity.self();if(!self)throw new NetError('not_enrolled')
    let descriptor!:StreamDescriptor
    this.options.db.transaction(()=>{
      const row=this.options.db.database.prepare('SELECT stream,boot FROM bridge_thread_streams WHERE thread_id=?').get(threadId)
      if(row){
        descriptor=this.options.store.getStream(row.stream as StreamId)!
        if(!descriptor||descriptor.kind!=='node.thread'||descriptor.authority!==self.node)throw new NetError('storage_corrupt')
        if(row.boot!==this.boot){this.options.generations.beginNodeEpoch(descriptor.id,this.options.store.head(descriptor.id).epoch+1);this.options.db.database.prepare('UPDATE bridge_thread_streams SET boot=? WHERE thread_id=?').run(this.boot,threadId)}
      }else{
        descriptor={id:newId('stream'),kind:'node.thread',authority:self.node,createdAt:this.options.clock.now()}
        this.options.store.createStream(descriptor,1)
        this.options.db.database.prepare('INSERT INTO bridge_thread_streams(thread_id,stream,boot) VALUES(?,?,?)').run(threadId,descriptor.id,this.boot)
      }
      this.options.db.charge(1)
    })
    const thread:ActiveThread={threadId,stream:descriptor.id,descriptor,ring:[],bytes:0}
    this.refreshSnapshot(thread)
    this.active.set(thread.stream,thread)
    thread.dispose=this.options.source.onThread(threadId,event=>{
      try{
        if(!THREAD_EVENT_TYPES.includes(event.type))throw new NetError('bad_request')
        const body={threadId,type:event.type,data:event.data}
        if(event.ephemeral){if(canonicalJson(body).byteLength<=32*1024)this.options.onDelta?.(thread.stream,body);return}
        // Oversized display events are replaced by a fresh source snapshot, never inline oversize.
        if(canonicalJson(body).byteLength>48*1024)this.refreshSnapshot(thread)
        else this.append(thread,'thread.event',body)
        this.trim(thread)
      }catch(error){this.options.onError?.(threadId,error)}
    })
    return descriptor
  }
  private append(thread:ActiveThread,type:string,body:unknown):void{
    if(this.options.db.database.isTransaction)throw new NetError('forbidden','Display records cannot escape an enclosing transaction.')
    const identity=this.options.identity,self=identity.self()!,root=identity.pinnedRootKey(self.user)!,signed=identity.roster()!
    if(identity.rosterState(self.user)!=='ok')throw new NetError('roster_conflict')
    const roster=identity.verifySigned<Roster>(signed,root)
    const delegation=roster.nodes.map(row=>identity.verifySigned<NodeDelegation>(row,root)).filter(row=>row.subject===self.node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
    if(!delegation||delegation.issuedAt>this.options.clock.now()||delegation.expiresAt<=this.options.clock.now()||roster.revoked.some(row=>row.subject===self.node&&row.throughKeyEpoch>=delegation.keyEpoch))throw new NetError('bad_delegation')
    const envelope:Envelope={v:1,minor:0,id:newId('event'),stream:thread.stream,type,crit:false,author:{user:self.user,node:self.node,keyEpoch:delegation.keyEpoch},ts:this.options.clock.now(),body}
    const bytes=encodeEnvelope(envelope),sig=this.options.keys.signAsNode(bytes)
    identity.verifyAuthor(envelope.author,bytes,sig,this.options.clock.now(),'newWork')
    const position=this.options.store.appendAsAuthority(thread.stream,{id:envelope.id,envelope:bytes,sig,recvTs:this.options.clock.now()})
    const record:StoredRecord={...position,envelope:bytes,sig}
    thread.ring.push(record);thread.bytes+=bytes.byteLength+sig.byteLength
    while(thread.ring.length>(this.options.maxRows??512)||thread.bytes>(this.options.maxBytes??1024*1024)){const dropped=thread.ring.shift()!;thread.bytes-=dropped.envelope.byteLength+dropped.sig.byteLength}
    this.options.onRecord?.(thread.stream,record)
  }
  private refreshSnapshot(thread:ActiveThread):void{
    const bytes=canonicalJson(this.options.source.snapshot(thread.threadId))
    if(bytes.byteLength>SNAPSHOT_MAX)throw new NetError('too_large','Display snapshot exceeds32MiB.')
    const snapshot=randomUUID(),sha256=createHash('sha256').update(bytes).digest('base64url'),chunks=Math.max(1,Math.ceil(bytes.length/CHUNK_BYTES)),previous=this.options.store.head(thread.stream).seq
    this.append(thread,'thread.snapshot.begin',{threadId:thread.threadId,snapshot,totalBytes:bytes.length,chunks,sha256})
    for(let index=0;index<chunks;index++)this.append(thread,'thread.snapshot.chunk',{threadId:thread.threadId,snapshot,index,data:Buffer.from(bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES)).toString('base64url')})
    this.append(thread,'thread.snapshot.end',{threadId:thread.threadId,snapshot,sha256})
    if(previous)this.options.store.truncate(thread.stream,previous)
  }
  private trim(thread:ActiveThread):void{
    if(thread.ring.length&&thread.ring[0].seq>1)this.options.store.truncate(thread.stream,thread.ring[0].seq-1)
  }
  deactivate(threadId:string):void{for(const [stream,thread]of this.active)if(thread.threadId===threadId){thread.dispose?.();this.active.delete(stream);return}}
  ringStats(stream:StreamId):{rows:number;bytes:number}{const thread=this.active.get(stream);if(!thread)throw new NetError('stream_unknown');return {rows:thread.ring.length,bytes:thread.bytes}}
  close():void{for(const thread of this.active.values())thread.dispose?.();this.active.clear()}
}
