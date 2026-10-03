import { AppError } from '../../shared/errors'
import { BOT_PROFILES,isId,NetError,NET_ERRORS } from '../../shared/net'
import { BOTS_LOCAL_CAPABILITY,BOTS_LOCAL_METHODS,type BotsLocalMethod,type BotsLocalParams } from '../../shared/bots/local'
import { DomainHandlerRegistry,domainObject } from '../protocol/domainRegistry'

export interface BotsLocalPort {request<K extends BotsLocalMethod>(method:K,params:BotsLocalParams[K]):unknown|Promise<unknown>}
const selection=['space','bot'] as const
const fields:Record<BotsLocalMethod,readonly string[]>={
  'bots.list':['after','limit'],
  'bots.configure':[...selection,'adapter','profile','definitionRevision','profileDigest','dailyBudgetUnits','runCeilingUnits','maxConcurrent','runsPerMemberHour','projectId'],
  'bots.qualify':[...selection,'definitionRevision','profileDigest'],
  'bots.stop':selection,'bots.resume':selection,'bots.grant':['stream','request','approved'],'bots.presence':[...selection,'stream']
}
const invalid=():never=>{throw new NetError('bad_request')}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{try{return domainObject(value,keys)}catch{return invalid()}}
function text(value:unknown,max:number):value is string{return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=max&&Buffer.from(value).toString()===value&&!/[\x00-\x1f\x7f]/.test(value)}
function selected(value:Record<string,unknown>):void{if(!isId('space',value.space)||!isId('bot',value.bot))invalid()}
function integer(value:unknown,max=Number.MAX_SAFE_INTEGER):void{if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>max)invalid()}
export function validateBotsLocal<K extends BotsLocalMethod>(method:K,value:unknown):BotsLocalParams[K]{
  const row=object(value??{},fields[method])
  if(!['bots.list','bots.grant'].includes(method))selected(row)
  if(method==='bots.list'){
    if(row.after!==undefined)selected(object(row.after,selection))
    if(row.limit!==undefined)integer(row.limit,128)
  }
  if(method==='bots.configure'||method==='bots.qualify'){
    if(!text(row.definitionRevision,256)||typeof row.profileDigest!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(row.profileDigest)||Buffer.from(row.profileDigest,'base64url').toString('base64url')!==row.profileDigest)invalid()
  }
  if(method==='bots.configure'){
    if(typeof row.adapter!=='string'||!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(row.adapter)||!BOT_PROFILES.includes(row.profile as any))invalid()
    for(const field of ['dailyBudgetUnits','runCeilingUnits'])integer(row[field])
    integer(row.maxConcurrent,32);integer(row.runsPerMemberHour,1000)
    if(Number(row.runCeilingUnits)>Number(row.dailyBudgetUnits)||row.profile==='chat'&&row.projectId!==undefined||row.profile==='reader'&&row.projectId===undefined)invalid()
    if(row.projectId!==undefined&&(typeof row.projectId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.projectId)))invalid()
  }
  if(method==='bots.presence'||method==='bots.grant')if(!isId('stream',row.stream))invalid()
  if(method==='bots.grant'&&(!isId('event',row.request)||typeof row.approved!=='boolean'))invalid()
  return row as unknown as BotsLocalParams[K]
}
function publicError(error:unknown):AppError{const code=error instanceof NetError?error.code:'internal',info=NET_ERRORS[code];return new AppError({code,message:info.message,errorInfo:{category:info.category,retryable:info.retryable}},error)}
export function registerBotMethods(registry:DomainHandlerRegistry,forProfile:(id:string)=>BotsLocalPort|Promise<BotsLocalPort>):void{
  for(const method of BOTS_LOCAL_METHODS)registry.register({method,scope:'profile',capability:BOTS_LOCAL_CAPABILITY,requiredCapabilities:[BOTS_LOCAL_CAPABILITY],validate:value=>{try{return validateBotsLocal(method,value)}catch(error){throw publicError(error)}},handle:async(_ctx,params,binding)=>{try{return await(await forProfile(binding!.profileId)).request(method,params)}catch(error){throw publicError(error)}}})
}
