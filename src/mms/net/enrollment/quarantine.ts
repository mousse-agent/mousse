import type { EnrollRequestMessage, HelloMessage, SpaceJoinRequestMessage, WireMessage } from '../../../shared/net'
import { NET_ERRORS, NET_PROTO_MAJOR, NET_PROTO_MINOR, PREAUTH_DEADLINE_MS, PREAUTH_MAX_BYTES, SESSION_CAPABILITIES, NetError } from '../../../shared/net'
import type { Clock, Mux, MuxMessage, SecureChannel, SyncSession } from '../contracts'
import { systemClock } from '../clock'
import { createMux } from '../link/mux'
import type { EnrollmentService, PreparedNodeJoin } from './service'

export interface GatewayNormalContext { initialHello: MuxMessage; initialPreauthBytes: number; preauthDeadlineMs: number; muxHasPreauthObserver: true }
export type GatewayNormalSession = SyncSession & { readonly opened: Promise<void>; recordPreauthBytes(count: number): void }
/** P5 supplies its actual atomic member admission service; this seam never fabricates membership. */
export interface SpaceJoinAdmissionPort { redeem(request: SpaceJoinRequestMessage, channel: SecureChannel): Promise<MuxMessage> | MuxMessage }
export interface EnrollmentGatewayOptions {
  channel: SecureChannel; service: EnrollmentService; clock?: Clock
  normalSession?(channel: SecureChannel, mux: Mux, context: GatewayNormalContext): GatewayNormalSession
  spaceJoin?: SpaceJoinAdmissionPort
  onEnrolled?(): void
}
const helloValid = (header: HelloMessage): boolean => header.protoMajor === NET_PROTO_MAJOR && header.protoMinor >= 0 && header.caps.includes('enroll.v1')
const enrollmentOnly = (header: HelloMessage): boolean => header.caps.filter(cap => SESSION_CAPABILITIES.includes(cap)).every(cap => cap === 'enroll.v1') && header.caps.includes('enroll.v1')
const ackValid = (header: Extract<WireMessage,{t:'helloAck'}>, minor: number): boolean => header.protoMinor === minor && header.caps.length === 1 && header.caps[0] === 'enroll.v1'
const errorResult = (error: unknown): Extract<WireMessage,{t:'enroll.result'}> => {
  const code = error instanceof NetError ? error.code : 'internal'
  return { t:'enroll.result',error:{code,message:NET_ERRORS[code].message,retryable:NET_ERRORS[code].retryable} }
}

/** One bounded front door and exactly one mux. Normal hello is handed off once without consuming it. */
export class EnrollmentGateway {
  readonly completed: Promise<void>
  private resolve!: () => void
  private reject!: (error: unknown) => void
  private readonly mux: Mux
  private readonly clock: Clock
  private bytes = 0
  private normal?: GatewayNormalSession
  private hello?: HelloMessage
  private ackReceived = false
  private ackSent = false
  private requestStarted = false
  private handingOff = false
  private done = false
  private timer: {cancel():void}
  private listeners: Array<()=>void> = []
  private deadline: number
  constructor(private readonly options: EnrollmentGatewayOptions) {
    this.clock = options.clock ?? systemClock; this.deadline = this.clock.monotonic()+PREAUTH_DEADLINE_MS
    this.completed = new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject}); void this.completed.catch(()=>{})
    this.timer = this.clock.setTimeout(()=>this.fail(new NetError('deadline_exceeded')),PREAUTH_DEADLINE_MS)
    this.mux = createMux(options.channel.stream,{clock:this.clock,onBytesReceived:count=>{
      if (this.normal) { this.normal.recordPreauthBytes(count); return }
      if (this.done) return
      this.bytes += count
      if (this.bytes > PREAUTH_MAX_BYTES) throw new NetError('too_large')
    }})
    this.listeners.push(this.mux.onClose(error=>{if(!this.done)this.fail(error??new NetError('peer_offline'))}))
    this.listeners.push(this.mux.onMessage((lane,message)=>{
      if(this.done)return
      if(lane!=='control'||message.parts.length||this.handingOff){this.fail(new NetError('forbidden'));return}
      void this.receive(message).catch(error=>this.fail(error))
    }))
  }
  private async send(header: WireMessage, parts: Uint8Array[]=[]): Promise<void> { await this.mux.send('control',{header,parts}) }
  private async receive(message: MuxMessage): Promise<void> {
    const h=message.header
    if(!this.hello){
      if(h.t!=='hello'||h.protoMajor!==NET_PROTO_MAJOR)throw new NetError('incompatible_peer')
      const enrollment=enrollmentOnly(h)
      if(!enrollment){
        if(!h.delegation||!h.roster||!this.options.normalSession)throw new NetError('bad_delegation')
        this.handingOff=true
        // Set iteration must finish before a new session registers listeners on this mux.
        queueMicrotask(()=>{
          if(this.done)return
          try{
            const remaining=Math.floor(this.deadline-this.clock.monotonic());if(remaining<=0)throw new NetError('deadline_exceeded')
            this.removeListeners();this.timer.cancel()
            this.normal=this.options.normalSession!(this.options.channel,this.mux,{initialHello:message,initialPreauthBytes:this.bytes,preauthDeadlineMs:remaining,muxHasPreauthObserver:true})
            this.normal.onClosed(error=>{if(!this.done)this.fail(error??new NetError('peer_offline'))})
            void this.normal.opened.then(()=>{if(!this.done){this.done=true;this.resolve()}},error=>this.fail(error))
          }catch(error){this.fail(error)}
        })
        return
      }
      if(!helloValid(h))throw new NetError('incompatible_peer')
      this.hello=h
      if((h.delegation||h.roster)&&(!h.delegation||!h.roster||!this.options.spaceJoin))throw new NetError('forbidden')
      await this.send(h.delegation?this.options.service.localHello():this.options.service.authorityHello())
      await this.send({t:'helloAck',protoMinor:Math.min(NET_PROTO_MINOR,h.protoMinor),caps:['enroll.v1'],now:this.clock.now()})
      this.ackSent=true
      return
    }
    if(h.t==='helloAck'){
      if(this.ackReceived||!ackValid(h,Math.min(NET_PROTO_MINOR,this.hello.protoMinor)))throw new NetError('incompatible_peer')
      this.ackReceived=true;return
    }
    if(!this.ackSent||!this.ackReceived||this.requestStarted)throw new NetError('forbidden')
    this.requestStarted=true
    if(h.t==='enroll.request'){
      if(h.node!==this.hello.node||this.hello.delegation||this.hello.roster)throw new NetError('bad_delegation')
      let response:Extract<WireMessage,{t:'enroll.result'}>
      try{const result=this.options.service.redeemNode(h,this.options.channel);response={t:'enroll.result',...result};this.options.onEnrolled?.()}
      catch(error){response=errorResult(error)}
      await this.send(response)
      this.finish();return
    }
    if(h.t==='space.join.request'&&this.options.spaceJoin){
      if(h.node!==this.hello.node||!this.hello.delegation||!this.hello.roster)throw new NetError('bad_delegation')
      const response=await this.options.spaceJoin.redeem(h,this.options.channel)
      if(response.header.t!=='space.join.result')throw new NetError('internal')
      await this.send(response.header,response.parts);if(!('error' in response.header))this.options.onEnrolled?.()
      this.finish();return
    }
    throw new NetError('forbidden')
  }
  private removeListeners():void{for(const stop of this.listeners.splice(0))stop()}
  private finish():void{if(this.done)return;this.done=true;this.timer.cancel();this.removeListeners();this.resolve();this.options.channel.stream.end()}
  private fail(error:unknown):void{if(this.done)return;this.done=true;this.timer.cancel();this.removeListeners();this.mux.close(error instanceof Error?error:new NetError('internal'));this.options.channel.close();this.reject(error)}
  close():void{if(this.normal){this.normal.close('cancelled');return}if(this.done){this.mux.close();this.options.channel.close();return}this.fail(new NetError('cancelled'))}
}

export interface EnrollmentQuarantineOptions { channel:SecureChannel; service:EnrollmentService; role:'joiner'; clock?:Clock }
/** Joining a node uses this connection only for enrollment; success reconnects on the normal front door. */
export class EnrollmentQuarantine {
  readonly completed:Promise<PreparedNodeJoin>
  private resolve!:(result:PreparedNodeJoin)=>void
  private reject!:(error:unknown)=>void
  private mux:Mux
  private clock:Clock
  private bytes=0
  private hello?:HelloMessage
  private ackReceived=false
  private ackSent=false
  private sent=false
  private result?:PreparedNodeJoin
  private done=false
  private timer:{cancel():void}
  private listeners:Array<()=>void>=[]
  constructor(private readonly options:EnrollmentQuarantineOptions){
    this.clock=options.clock??systemClock
    this.completed=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject});void this.completed.catch(()=>{})
    this.timer=this.clock.setTimeout(()=>this.fail(new NetError('deadline_exceeded')),PREAUTH_DEADLINE_MS)
    this.mux=createMux(options.channel.stream,{clock:this.clock,onBytesReceived:count=>{
      if(this.done||this.sent)return
      this.bytes+=count;if(this.bytes>PREAUTH_MAX_BYTES)throw new NetError('too_large')
    }})
    this.listeners.push(this.mux.onClose(error=>{if(this.done)return;if(this.result){this.complete(this.result);return}this.fail(error??new NetError('peer_offline'))}))
    this.listeners.push(this.mux.onMessage((lane,message)=>{if(this.done)return;if(lane!=='control'||message.parts.length){this.fail(new NetError('forbidden'));return}void this.receive(message.header).catch(error=>this.fail(error))}))
    const prepared=options.service.preparedNodeJoin()
    if(!prepared){this.fail(new NetError('not_enrolled'));return}
    void this.send({t:'hello',protoMajor:NET_PROTO_MAJOR,protoMinor:NET_PROTO_MINOR,caps:['enroll.v1'],node:prepared.node,now:this.clock.now()}).catch(error=>this.fail(error))
  }
  private async send(header:WireMessage):Promise<void>{await this.mux.send('control',{header,parts:[]})}
  private async maybeRequest():Promise<void>{if(!this.hello||!this.ackReceived||!this.ackSent||this.sent)return;this.sent=true;await this.send(this.options.service.nodeJoinRequest(this.options.channel))}
  private async receive(h:WireMessage):Promise<void>{
    if(h.t==='hello'){
      if(this.hello||!helloValid(h)||!enrollmentOnly(h))throw new NetError('incompatible_peer')
      this.options.service.verifyAuthorityHello(h,this.options.channel);this.hello=h
      await this.send({t:'helloAck',protoMinor:Math.min(NET_PROTO_MINOR,h.protoMinor),caps:['enroll.v1'],now:this.clock.now()});this.ackSent=true
      await this.maybeRequest();return
    }
    if(h.t==='helloAck'){
      if(!this.hello||this.ackReceived||!ackValid(h,Math.min(NET_PROTO_MINOR,this.hello.protoMinor)))throw new NetError('incompatible_peer')
      this.ackReceived=true;await this.maybeRequest();return
    }
    if(h.t==='enroll.result'&&this.sent){
      if('error' in h)throw new NetError(h.error.code)
      const enrolled=this.options.service.acceptNodeJoin({delegation:h.delegation,roster:h.roster},this.options.channel)
      this.result=enrolled;return
    }
    throw new NetError('forbidden')
  }
  private complete(result:PreparedNodeJoin):void{this.done=true;this.timer.cancel();for(const stop of this.listeners.splice(0))stop();this.resolve(result);this.options.channel.close()}
  private fail(error:unknown):void{if(this.done)return;this.done=true;this.timer.cancel();for(const stop of this.listeners.splice(0))stop();this.mux.close(error instanceof Error?error:new NetError('internal'));this.options.channel.close();this.reject(error)}
  close():void{if(this.done){this.mux.close();this.options.channel.close();return}this.fail(new NetError('cancelled'))}
}
