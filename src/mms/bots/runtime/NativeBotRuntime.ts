import{createHash}from'node:crypto'
import{Type,type Api,type Message,type Tool,type ToolCall,type ToolResultMessage}from'@earendil-works/pi-ai'
import type{SettingsStore}from'../../settings/SettingsStore'
import type{ProviderAuthService}from'../../providers/ProviderAuthService'
import{LlmClient}from'../../orchestrator/LlmClient'
import type{BotRuntimeAdapter,BotRunRequest,BotRunEvents,BotRunResult,CompartmentStore,BotExecutionBinding}from'../../net/contracts'
import{NetError,isId,type Base64Url,type BotProfile}from'../../../shared/net'
import{canonicalJson}from'../../net/sync/codec'
import{GuardedProvider,billingMatches,nativeSdkVersion,type BillingQualification}from'./GuardedProvider'
import{NativeReader,nativeReaderQualified,type NativeReaderModule,type NativeReaderQualification}from'./NativeReader'
const readerNames=['safe_read','safe_list','safe_search']as const
export type ReaderTool=typeof readerNames[number]
export interface NativeBotDefinition{
 revision:string;systemPrompt:string;billing:BillingQualification
 readerTools:readonly ReaderTool[];approval:'always'|'never';maxModelCalls:number;maxToolCalls:number;maxElapsedMs:number
}
export interface NativeBotRuntimeOptions{
 profileId:string;installationHome:string;settings:SettingsStore;providerAuth:ProviderAuthService;sdkVersion:string;definition:NativeBotDefinition
 compartments:CompartmentStore;executionBinding(execution:BotRunRequest['execution']):BotExecutionBinding|undefined
 /** Current identity/placement/meta/grants/stop and exact private-control checks, from admission. */
 assertCurrent(request:BotRunRequest):void
 reader?:{module:NativeReaderModule;qualification:NativeReaderQualification;deniedRoots:readonly string[]}
 qualification:{active(profile:BotProfile):boolean;invalidate(code:string,evidence?:Record<string,unknown>):void}
}
export function effectiveBotPolicy(definition:NativeBotDefinition,profile:BotProfile){return{adapter:'mousse-net-native-v1',profile,definitionRevision:definition.revision,systemPrompt:definition.systemPrompt,billing:definition.billing,tools:profile==='reader'?[...definition.readerTools].sort():[],approval:definition.approval,maxModelCalls:definition.maxModelCalls,maxToolCalls:definition.maxToolCalls,maxElapsedMs:definition.maxElapsedMs,delegation:false,compaction:false,providerSession:false}}
export function effectiveBotPolicyDigest(definition:NativeBotDefinition,profile:BotProfile):Base64Url{return createHash('sha256').update(canonicalJson(effectiveBotPolicy(definition,profile))).digest('base64url')as Base64Url}
function integer(value:number,max:number){if(!Number.isSafeInteger(value)||value<1||value>max)throw new NetError('profile_unsupported')}
function digest(value:unknown):Base64Url{return createHash('sha256').update(canonicalJson(value)).digest('base64url')as Base64Url}
function checkArgs(call:ToolCall):Record<string,unknown>{const a=call.arguments as Record<string,unknown>;if(!a||typeof a!=='object'||Array.isArray(a)||canonicalJson(a).length>16384)throw new NetError('bad_request');const allowed=call.name==='safe_read'?['path','maxBytes']:call.name==='safe_list'?['path']:['query','path','maxResults'];if(Object.keys(a).some(key=>!allowed.includes(key)))throw new NetError('bad_request');if(a.path!==undefined&&typeof a.path!=='string'||call.name==='safe_read'&&typeof a.path!=='string'||call.name==='safe_search'&&typeof a.query!=='string')throw new NetError('bad_request');for(const key of ['maxBytes','maxResults'])if(a[key]!==undefined&&(!Number.isSafeInteger(a[key])||(a[key]as number)<1||(a[key]as number)>(key==='maxBytes'?262144:200)))throw new NetError('bad_request');if(call.name==='safe_search'&&(!(a.query as string)||Buffer.byteLength(a.query as string)>4096))throw new NetError('bad_request');return a}
function cancelled<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted)return Promise.reject(new NetError('cancelled'));return new Promise((resolve,reject)=>{const abort=()=>reject(new NetError('cancelled'));signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})})}
export function readerToolDefinitions(names:readonly ReaderTool[]):Tool[]{const all:Record<ReaderTool,Tool>={safe_read:{name:'safe_read',description:'Read one bounded UTF-8 file in the admitted project root.',parameters:Type.Object({path:Type.String(),maxBytes:Type.Optional(Type.Integer({minimum:1,maximum:262144}))},{additionalProperties:false})},safe_list:{name:'safe_list',description:'List one bounded directory in the admitted project root.',parameters:Type.Object({path:Type.Optional(Type.String())},{additionalProperties:false})},safe_search:{name:'safe_search',description:'Bounded literal text search within the admitted project root.',parameters:Type.Object({query:Type.String(),path:Type.Optional(Type.String()),maxResults:Type.Optional(Type.Integer({minimum:1,maximum:200}))},{additionalProperties:false})}};return names.map(name=>all[name])}
/** Only this exact reader dispatcher receives model-invented names; approvals never expand its inventory. */
export class ReaderToolPort{
 private calls=0
 constructor(private readonly reader:NativeReader,private readonly definition:NativeBotDefinition,private readonly request:BotRunRequest,private readonly events:BotRunEvents,private readonly current:()=>void,private readonly signal:AbortSignal,private readonly cancelRun?:()=>void){}
 async execute(call:ToolCall):Promise<ToolResultMessage>{
  call=structuredClone(call);if(call.namespace!==undefined)throw new NetError('forbidden');this.current();if(this.signal.aborted)throw new NetError('cancelled');if(!this.definition.readerTools.includes(call.name as ReaderTool)||!readerNames.includes(call.name as ReaderTool))throw new NetError('forbidden');if(++this.calls>this.definition.maxToolCalls){this.cancelRun?.();throw new NetError('budget_exhausted')};const args=checkArgs(call);this.reader.checkPath((args.path as string|undefined)??'',call.name!=='safe_read');const argumentDigest=digest(args),binding={stream:this.request.outputStream,compartment:this.request.compartment,...(this.request.visibilityEpoch===undefined?{}:{visibilityEpoch:this.request.visibilityEpoch})},actionHash=digest({execution:this.request.execution,tool:call.name,argumentDigest,profileDigest:this.request.profileDigest,binding})
  if(this.definition.approval==='always'){
   this.events.onWaitingApproval('Reader action requires approval.')
   const evidence=await cancelled(this.request.approvals.requestAction({tool:call.name,argumentDigest,actionHash}),this.signal)
   this.current();if(this.signal.aborted||evidence.decision!=='approved'||Date.now()>=evidence.expiresAt){this.cancelRun?.();throw new NetError('cancelled')}
   try{await this.request.approvals.consume(evidence.approval,actionHash);if(Date.now()>=evidence.expiresAt){this.cancelRun?.();throw new NetError('cancelled')}}catch(error){this.cancelRun?.();throw error}
  }
  this.current();if(this.signal.aborted)throw new NetError('cancelled')
  const value=call.name==='safe_read'?this.reader.read(args.path as string,args.maxBytes as number|undefined):call.name==='safe_list'?this.reader.list(args.path as string|undefined):this.reader.search(args.query as string,{path:args.path as string|undefined,maxResults:args.maxResults as number|undefined})
  this.current();if(this.signal.aborted)throw new NetError('cancelled');this.events.onToolSummary(call.name,'Reader action completed.')
  return{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],isError:false,timestamp:Date.now()}
 }
}
export class NativeBotRuntime implements BotRuntimeAdapter{
 readonly id='mousse'
 private readonly definition:NativeBotDefinition
 private qualified=true
 private running=new Map<string,AbortController>()
 constructor(private readonly options:NativeBotRuntimeOptions){this.definition=structuredClone(options.definition);integer(this.definition.maxModelCalls,128);integer(this.definition.maxToolCalls,1024);integer(this.definition.maxElapsedMs,3600000);if(!this.definition.revision||!this.definition.systemPrompt||Buffer.byteLength(this.definition.systemPrompt)>65536||!['always','never'].includes(this.definition.approval)||new Set(this.definition.readerTools).size!==this.definition.readerTools.length||this.definition.readerTools.some(name=>!readerNames.includes(name)))throw new NetError('profile_unsupported')}
 supports(profile:BotProfile):boolean{const d=this.definition,model=this.options.providerAuth.models.getModel(d.billing.provider,d.billing.model);if(this.options.sdkVersion!==nativeSdkVersion()||!this.qualified||!this.options.qualification.active(profile)||!billingMatches(model,d.billing,this.options.sdkVersion))return false;if(profile==='chat')return true;if(profile==='reader'){const q=this.options.reader?.qualification;return Boolean(q&&this.options.reader&&nativeReaderQualified(this.options.reader.module,q)&&this.options.reader.deniedRoots.length)}return false}
 async run(request:BotRunRequest,events:BotRunEvents):Promise<BotRunResult>{
  request=Object.freeze({...request});if(!this.supports(request.profile))throw new NetError('profile_unsupported');if(request.signal.aborted)throw new NetError('cancelled');if(this.running.has(request.execution))throw new NetError('conflict');this.validate(request)
  const abort=new AbortController(),deadline=AbortSignal.timeout(this.definition.maxElapsedMs),signal=AbortSignal.any([request.signal,deadline,abort.signal]),current=()=>{if(!this.supports(request.profile)){abort.abort();throw new NetError('profile_unsupported')}if(signal.aborted)throw new NetError('cancelled');this.validate(request);this.options.assertCurrent(request)}
  this.running.set(request.execution,abort)
  let reader:NativeReader|undefined;const guard=new GuardedProvider(this.options.providerAuth,this.definition.billing,this.options.sdkVersion,request.spend,signal,current,evidence=>this.invalidate('provider_charge_unqualified',evidence),this.definition.maxModelCalls)
  try{current();const history=this.options.compartments.history(request.compartment,100),messages:Message[]=history.map(turn=>turn.role==='user'?{role:'user',content:turn.text,timestamp:turn.ts}:{role:'assistant',content:[{type:'text',text:turn.text}],api:this.definition.billing.api,provider:this.definition.billing.provider,model:this.definition.billing.model,stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:turn.ts});messages.push({role:'user',content:request.prompt,timestamp:Date.now()})
   if(request.profile==='reader')reader=new NativeReader(this.options.reader!.module,request.projectRoot!,[this.options.installationHome,...this.options.reader!.deniedRoots],signal)
   const tools=reader?readerToolDefinitions(this.definition.readerTools):[],port=reader?new ReaderToolPort(reader,this.definition,request,events,current,signal,()=>abort.abort()):undefined,llm=new LlmClient(this.options.settings,guard.auth)
   const result=await llm.chat(messages,undefined,{llmProvider:this.definition.billing.provider,model:this.definition.billing.model,signal,threadId:request.backingThreadId,runtimeContext:{systemPrompt:this.definition.systemPrompt,tools,executeTool:async call=>{current();if(!port)throw new NetError('forbidden');return port.execute(call)}}},undefined,event=>{current();events.onProgress(event.content)})
   await guard.settled();if(guard.failure)throw guard.failure;current();if(result.aborted)throw new NetError('cancelled');return{text:result.text,spentUnits:guard.spentUnits}
  }catch(error){if(guard.failure)throw guard.failure;if(signal.aborted)throw new NetError('cancelled');throw error}finally{try{let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([guard.settled(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{this.invalidate('provider_did_not_stop');reject(new NetError('outcome_uncertain'))},5000)})]).finally(()=>{if(timer)clearTimeout(timer)})}finally{reader?.close();this.running.delete(request.execution)}}
 }
 /** Local fencing precedes persistence; even a failing journal write must stop every active run. */
 private invalidate(code:string,evidence?:Record<string,unknown>):void{
  this.qualified=false
  try{this.options.qualification.invalidate(code,evidence)}finally{for(const controller of this.running.values())controller.abort()}
 }
 private validate(request:BotRunRequest):void{
  if(!isId('execution',request.execution)||!isId('bot',request.bot)||!isId('space',request.space)||!isId('stream',request.outputStream)||!request.backingThreadId||!request.workspaceId||typeof request.prompt!=='string'||Buffer.byteLength(request.prompt)>65536||!Number.isSafeInteger(request.spendCeilingUnits)||request.spendCeilingUnits<1||request.definitionRevision!==this.definition.revision||request.profileDigest!==effectiveBotPolicyDigest(this.definition,request.profile)||request.profile==='chat'&&request.projectRoot!==undefined||request.profile==='reader'&&!request.projectRoot)throw new NetError('forbidden')
  const b=this.options.executionBinding(request.execution),c=this.options.compartments.binding(request.compartment)
  if(!b||!c||b.profileId!==this.options.profileId||c.profileId!==this.options.profileId||b.space!==request.space||c.space!==request.space||b.bot!==request.bot||c.bot!==request.bot||b.compartment!==request.compartment||b.stream!==request.outputStream||b.backingThreadId!==request.backingThreadId||b.workspaceId!==request.workspaceId||b.definitionRevision!==request.definitionRevision||b.profileDigest!==request.profileDigest||b.visibilityEpoch!==request.visibilityEpoch||c.visibilityEpoch!==request.visibilityEpoch||b.participantHash!==request.participantHash||c.participantHash!==request.participantHash||c.privateStream!==undefined&&c.privateStream!==request.outputStream||c.privateStream===undefined&&(request.visibilityEpoch!==undefined||request.participantHash!==undefined))throw new NetError('forbidden')
 }
}
