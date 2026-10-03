import{createHash}from'node:crypto'
import{fileURLToPath}from'node:url'
import{readFileSync}from'node:fs'
import{dirname,join}from'node:path'
import{createAssistantMessageEventStream,type AssistantMessage,type AssistantMessageEventStream,type Api,type Context,type Model,type StreamOptions}from'@earendil-works/pi-ai'
import type{ProviderAuthService}from'../../providers/ProviderAuthService'
import type{BotSpendPort}from'../../net/contracts'
import{NetError}from'../../../shared/net'
import{canonicalJson}from'../../net/sync/codec'
export function nativeSdkVersion():string{const path=fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')),data=JSON.parse(readFileSync(join(dirname(path),'../package.json'),'utf8'));if(data.name!=='@earendil-works/pi-ai'||typeof data.version!=='string')throw new NetError('profile_unsupported');return data.version}
/** Host-reviewed billing evidence is required. Catalogue rates alone are not a maximum-charge proof. */
export interface BillingQualification{
  provider:string;model:string;api:'openai-completions'|'anthropic-messages'
  modelDigest:string;sdkVersion:string;platform:NodeJS.Platform;nodeVersion:string;runtimeVersion:'mousse-net-native-v1';maximumUnits:number;maxOutputTokens:number;maxRequestBytes:number
  /** Pinned provider/model billing policy covering input, output, caching, overhead, and failures. */
  evidence:string
}
export function modelDigest(model:Model<Api>):string{return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(model)))).digest('base64url')}
function safe(value:number,min=0):boolean{return Number.isSafeInteger(value)&&value>=min}
export function billingMatches(model:Model<Api>|undefined,qualification:BillingQualification,sdkVersion:string):boolean{return Boolean(model&&model.provider===qualification.provider&&model.id===qualification.model&&model.api===qualification.api&&modelDigest(model)===qualification.modelDigest&&sdkVersion===qualification.sdkVersion&&qualification.platform===process.platform&&qualification.nodeVersion===process.versions.node&&qualification.runtimeVersion==='mousse-net-native-v1'&&typeof qualification.evidence==='string'&&qualification.evidence.trim()&&safe(qualification.maximumUnits,1)&&safe(qualification.maxOutputTokens,1)&&qualification.maxOutputTokens<=model.maxTokens&&safe(qualification.maxRequestBytes,1)&&qualification.maxRequestBytes<=1024*1024&&!model.samplingParams&&['openai-completions','anthropic-messages'].includes(model.api))}
/** One guard per execution; every actual native model request/retry crosses this port. */
export class GuardedProvider{
  readonly auth:ProviderAuthService
  spentUnits=0
  failure?:NetError
  private tasks=new Set<Promise<void>>()
  private calls=0
  private suspended=false
  constructor(auth:ProviderAuthService,private readonly billing:BillingQualification,private readonly sdkVersion:string,private readonly spend:BotSpendPort,private readonly signal:AbortSignal,private readonly assertCurrent:()=>void,private readonly invalidate:(evidence?:Record<string,unknown>)=>void,private readonly maximumCalls=32){
    const models=new Proxy(auth.models,{get:(target,key,receiver)=>{if(key==='stream'||key==='streamSimple')return(model:Model<Api>,context:Context,options?:StreamOptions)=>this.stream(model,context,options,(m,c,o)=>Reflect.get(target,key,receiver).call(target,m,c,o));const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value}})
    this.auth=new Proxy(auth,{get:(target,key,receiver)=>{if(key==='models')return models;const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value}})
  }
  async settled():Promise<void>{await Promise.all([...this.tasks])}
  private stream(model:Model<Api>,context:Context,options:StreamOptions|undefined,start:(model:Model<Api>,context:Context,options:StreamOptions)=>AssistantMessageEventStream):AssistantMessageEventStream{
    const output=createAssistantMessageEventStream(),pinnedModel=structuredClone(model),pinnedContext=structuredClone(context);let terminal:AssistantMessage|undefined,blocked:NetError|undefined
    const task=(async()=>{let call:{id:string}|undefined,started=false;try{
      this.assertCurrent();if(this.signal.aborted||options?.signal?.aborted)throw new NetError('cancelled')
      if(this.suspended||!billingMatches(model,this.billing,this.sdkVersion))throw new NetError('profile_unsupported')
      if(++this.calls>this.maximumCalls)throw new NetError('budget_exhausted')
      if(canonicalJson(JSON.parse(JSON.stringify(context))).byteLength>this.billing.maxRequestBytes)throw new NetError('too_large')
      call=await this.spend.authorizeCall(this.billing.maximumUnits)
      this.assertCurrent();if(this.signal.aborted||options?.signal?.aborted){await this.spend.settleCall(call.id,0);throw new NetError('cancelled')}
      const bounded:StreamOptions={...options,maxTokens:this.billing.maxOutputTokens,samplingParams:undefined,maxRetries:0,sessionId:undefined,cacheRetention:'none',signal:options?.signal?AbortSignal.any([this.signal,options.signal]):this.signal}
      if(!billingMatches(model,this.billing,this.sdkVersion)||!billingMatches(pinnedModel,this.billing,this.sdkVersion))throw new NetError('profile_unsupported');started=true;const stream=start(pinnedModel,pinnedContext,bounded)
      for await(const event of stream){
        if(event.type==='done'||event.type==='error'){
          terminal=event.type==='done'?event.message:event.error
          const cost=terminal.usage?.cost?.total,tokens=terminal.usage?.totalTokens
          if(!Number.isFinite(cost)||cost<0||!safe(tokens)||tokens===0)throw new NetError('outcome_uncertain','Provider usage is not a proven charge.')
          const units=Math.ceil(cost*1000000)
          if(!safe(units)||units>this.billing.maximumUnits){this.suspended=true;this.invalidate({callId:call.id,maximumUnits:this.billing.maximumUnits,reportedUnits:units});throw new NetError('profile_unsupported','Provider charge exceeded its qualified maximum.',{details:{callId:call.id,maximumUnits:this.billing.maximumUnits,reportedUnits:units}})}
          if(!['input','output','cacheRead','cacheWrite'].every(key=>safe(terminal!.usage[key as 'input'|'output'|'cacheRead'|'cacheWrite']))||terminal.usage.output>this.billing.maxOutputTokens||terminal.usage.input+terminal.usage.cacheRead+terminal.usage.cacheWrite>pinnedModel.contextWindow){this.suspended=true;this.invalidate({callId:call.id,code:'usage_limit_exceeded'});throw new NetError('profile_unsupported')}await this.spend.settleCall(call.id,units);this.spentUnits+=units
          if(!safe(this.spentUnits)){this.invalidate();this.suspended=true;throw new NetError('profile_unsupported')}
          // Terminal accounting remains mandatory even if a sibling invalidated this runtime.
          // Recheck only after settlement so known spend is never lost to cancellation.
          if(blocked)throw blocked;this.assertCurrent();if(this.signal.aborted||options?.signal?.aborted)throw new NetError('cancelled')
          output.push(event);output.end(terminal);return
        }
        // Drain dispatched calls after cancellation to retain their eventual usage evidence.
        // No progress/tool content may escape a suspended execution.
        if(blocked||this.signal.aborted||options?.signal?.aborted)continue
        try{this.assertCurrent()}catch(error){blocked=error instanceof NetError?error:new NetError('outcome_uncertain',undefined,{cause:error});continue}
        output.push(event)
      }
      throw new NetError('outcome_uncertain','Provider ended without a terminal usage record.')
    }catch(error){let cause=error;if(call&&!started){try{await this.spend.settleCall(call.id,0)}catch(settlementError){cause=settlementError}}const failure=cause instanceof NetError?cause:new NetError('outcome_uncertain',undefined,{cause});this.failure=failure
      const failed:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:this.signal.aborted?'aborted':'error',errorMessage:failure.code,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()}
      output.push({type:'error',reason:failed.stopReason==='aborted'?'aborted':'error',error:failed});output.end(failed)
    }})();this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return output
  }
}
