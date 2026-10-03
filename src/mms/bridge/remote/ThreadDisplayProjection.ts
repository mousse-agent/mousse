import { createHash } from 'node:crypto'
import type { Envelope } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import { decodeBase64 } from '../../net/identity/crypto'
import { parseProtocolJson } from '../../net/sync/codec'
import { THREAD_EVENT_TYPES } from './ThreadStreamAdapter'

export type ThreadDisplayUpdate={kind:'snapshot';value:unknown}|{kind:'event';type:string;data:unknown}
/** Consumes already signature-verified display envelopes. It never touches ThreadDataStore/runs. */
export class ThreadDisplayProjection {
  private pending?:{id:string;bytes:number;chunks:number;hash:string;parts:Uint8Array[];received:number}
  constructor(private readonly threadId:string){}
  accept(envelope:Envelope):ThreadDisplayUpdate|undefined{
    const b=envelope.body as Record<string,unknown>
    if(!b||typeof b!=='object'||Array.isArray(b)||b.threadId!==this.threadId||envelope.crit||envelope.sealed)throw new NetError('bad_request')
    const exact=(keys:string[]):void=>{if(Object.keys(b).sort().join(',')!==keys.sort().join(','))throw new NetError('bad_request')}
    if(envelope.type==='thread.snapshot.begin'){
      exact(['threadId','snapshot','totalBytes','chunks','sha256'])
      if(typeof b.snapshot!=='string'||!/^[0-9a-f-]{36}$/.test(b.snapshot)||!Number.isSafeInteger(b.totalBytes)||Number(b.totalBytes)<1||Number(b.totalBytes)>32*1024*1024||!Number.isSafeInteger(b.chunks)||Number(b.chunks)!==Math.ceil(Number(b.totalBytes)/(32*1024)))throw new NetError('bad_request')
      decodeBase64(b.sha256 as string,32)
      this.pending={id:b.snapshot,bytes:Number(b.totalBytes),chunks:Number(b.chunks),hash:b.sha256 as string,parts:[],received:0};return
    }
    if(envelope.type==='thread.snapshot.chunk'){
      exact(['threadId','snapshot','index','data']);const held=this.pending
      if(!held||b.snapshot!==held.id||b.index!==held.parts.length||held.parts.length>=held.chunks)throw new NetError('bad_request')
      const bytes=decodeBase64(b.data as string),expected=Math.min(32*1024,held.bytes-held.received)
      if(bytes.length!==expected)throw new NetError('bad_request')
      held.parts.push(bytes);held.received+=bytes.length;return
    }
    if(envelope.type==='thread.snapshot.end'){
      exact(['threadId','snapshot','sha256']);const held=this.pending
      if(!held||b.snapshot!==held.id||b.sha256!==held.hash||held.received!==held.bytes||held.parts.length!==held.chunks)throw new NetError('bad_request')
      const bytes=Buffer.concat(held.parts)
      if(createHash('sha256').update(bytes).digest('base64url')!==held.hash)throw new NetError('bad_request')
      const value=parseProtocolJson(bytes);this.pending=undefined;return {kind:'snapshot',value}
    }
    if(envelope.type==='thread.event'){
      exact(['threadId','type','data'])
      if(this.pending||!THREAD_EVENT_TYPES.includes(b.type as never))throw new NetError('bad_request')
      return {kind:'event',type:b.type as string,data:b.data}
    }
    throw new NetError('bad_request','Unknown display frame.')
  }
  reset():void{this.pending=undefined}
}
