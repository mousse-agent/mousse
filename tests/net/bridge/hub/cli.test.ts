import { expect, it } from 'vitest'
import { parseArgs } from '../../../../src/cli/parseArgs'
import { prepareBridgeHubCommand, executeBridgeHubCommand } from '../../../../src/cli/commands/bridge'
import { newId } from '../../../../src/shared/net'
import { validateBridgeHubLocal } from '../../../../src/mms/bridge/hub'

it('chooses mutation IDs before local transport and prints them with results',async()=>{
  const target=newId('node'),request=prepareBridgeHubCommand(parseArgs(['bridge','send',target,'thread-one','Prompt','--profile','work'])),calls:unknown[]=[],outputs:unknown[]=[],chosen:string[]=[]
  expect(request).toMatchObject({method:'bridge.hub.send',params:{ref:{nodeId:target,entityId:'thread-one'},content:'Prompt',options:{id:expect.stringMatching(/^rpc_/),idem:expect.stringMatching(/^rpc_/)}}})
  await executeBridgeHubCommand(request,{request:async<T>(method:string,params:unknown)=>{calls.push({method,params});expect(chosen).toHaveLength(1);return {ok:true} as T}},{emit:value=>outputs.push(value),requestChosen:id=>chosen.push(id)})
  expect(calls).toHaveLength(1);expect(outputs).toEqual([{id:chosen[0],result:{ok:true}}])
})
it('accepts explicit IDs and portable dispatch limits while denying all extra execution authority',()=>{
  const target=newId('node'),id=newId('rpc'),args=['bridge','dispatch',target,'--repo','repo_'+ 'a'.repeat(64),'--base','a'.repeat(40),'--agent','agent','--prompt','Implement','--turns','2','--tools','3','--elapsed','1000','--id',id,'--idem','portable-once']
  expect(prepareBridgeHubCommand(parseArgs(args))).toMatchObject({method:'bridge.hub.dispatch',params:{target,options:{id,idem:'portable-once'},input:{limits:{maxTurns:2,maxToolCalls:3,maxElapsedMs:1000}}}})
  for(const extra of [['--path','/tmp/escape'],['--provider','openai'],['--api-key','secret'],['--login','x'],['--deadline','0'],['--model','override']])expect(()=>prepareBridgeHubCommand(parseArgs(['bridge','send',target,'thread','Prompt',...extra]))).toThrow()
  expect(()=>prepareBridgeHubCommand(parseArgs(['bridge','send',target,'thread','Prompt','--id','forged']))).toThrow()
  expect(()=>validateBridgeHubLocal('bridge.hub.send',{ref:{nodeId:target,entityId:'thread'},content:'hello',options:{id},executionId:newId('execution')})).toThrow()
})
it('result uses original-id read-only lookup and attach subscribes before the request with explicit detach',async()=>{
  const id=newId('rpc'),result=prepareBridgeHubCommand(parseArgs(['bridge','result',id])),calls:string[]=[]
  await executeBridgeHubCommand(result,{request:async<T>(method:string)=>{calls.push(method);return {} as T}},{emit(){}})
  expect(calls).toEqual(['bridge.hub.result'])
  const target=newId('node'),attach=prepareBridgeHubCommand(parseArgs(['bridge','attach',target,'thread'])),seen:unknown[]=[]
  await executeBridgeHubCommand(attach,{request:async<T>(method:string)=>{calls.push(method);return {} as T}},{emit:value=>seen.push(value),watch:async(ref,ready,update)=>{expect(ref).toEqual({nodeId:target,entityId:'thread'});calls.push('subscribed');await ready();update({kind:'snapshot',value:{thread:{id:'thread'}}})}})
  expect(calls.slice(1)).toEqual(['subscribed','bridge.hub.attach','bridge.hub.detach']);expect(seen).toHaveLength(1)
})
it('validates every Hub local method using exact typed DTOs, including malformed options and aliases',()=>{
  const target=newId('node'),ref={nodeId:target,entityId:'thread'},run=newId('rpc')
  const valid:Record<string,unknown>={'bridge.hub.projects':{target},'bridge.hub.threads':{target},'bridge.hub.get':{ref},'bridge.hub.search':{target,query:'needle'},'bridge.hub.create':{target,name:'Thread'},'bridge.hub.send':{ref,content:'Prompt'},'bridge.hub.steer':{ref,run,text:'Continue'},'bridge.hub.abort':{ref,run},'bridge.hub.attach':{ref},'bridge.hub.detach':{ref},'bridge.hub.result':{id:run},'bridge.hub.cancel':{id:run},'bridge.hub.requests':{}}
  for(const [method,value] of Object.entries(valid)){expect(validateBridgeHubLocal(method as any,value)).toEqual(value);expect(()=>validateBridgeHubLocal(method as any,{...(value as object),secret:'no'})).toThrow()}
  expect(()=>validateBridgeHubLocal('bridge.hub.send',{ref,content:'x',options:{id:run,deadlineMs:Infinity}})).toThrow()
  expect(()=>validateBridgeHubLocal('bridge.hub.get',{ref:{...ref,path:'/tmp'}})).toThrow()
})
