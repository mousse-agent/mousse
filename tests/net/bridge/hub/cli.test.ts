import { expect, it } from 'vitest'
import { parseArgs } from '../../../../src/cli/parseArgs'
import { prepareBridgeHubCommand, executeBridgeHubCommand, watchBridgeHubDisplay, type BridgeHubDisplayConnection } from '../../../../src/cli/commands/bridge'
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

it('watches only connection display events, validates chunks before output and releases close listeners', async () => {
  const { bridgeDisplayParts } = await import('../../../../src/mms/bridge/hub/displayEvents')
  const { BRIDGE_HUB_THREAD_EVENT } = await import('../../../../src/shared/bridge')
  const ref={nodeId:newId('node'),entityId:'thread'},stream=newId('stream'),abort=new AbortController(),seen:unknown[]=[]
  let handler:((event:{type:string;profileId:string;profileEpoch:number;data:unknown})=>void)|undefined,closed:((error:Error)=>void)|undefined
  const connection:BridgeHubDisplayConnection={connected:true,onConnectionEvent(fn){handler=fn;return()=>{handler=undefined}},onConnectionClosed(fn){closed=fn;return()=>{closed=undefined}}}
  const watch=watchBridgeHubDisplay(connection,ref,async()=>{
    expect(handler).toBeTypeOf('function');expect(closed).toBeTypeOf('function')
    for await(const data of bridgeDisplayParts({ref,stream,epoch:1,seq:1,update:{kind:'snapshot',value:{message:'x'.repeat(100000)}}}))handler!({type:BRIDGE_HUB_THREAD_EVENT,profileId:'work',profileEpoch:1,data})
  },value=>{seen.push(value);abort.abort()},abort.signal)
  await watch
  expect(seen).toEqual([{kind:'snapshot',value:{message:'x'.repeat(100000)}}]);expect(handler).toBeUndefined();expect(closed).toBeUndefined()
})
it('fails and resets an incomplete display generation when the daemon closes or its profile binding changes', async () => {
  const { bridgeDisplayParts } = await import('../../../../src/mms/bridge/hub/displayEvents')
  const { BRIDGE_HUB_THREAD_EVENT } = await import('../../../../src/shared/bridge')
  for(const fail of ['close','rebind'] as const){
    const ref={nodeId:newId('node'),entityId:'thread'},stream=newId('stream'),seen:unknown[]=[]
    let handler:((event:{type:string;profileId:string;profileEpoch:number;data:unknown})=>void)|undefined,closed:((error:Error)=>void)|undefined
    const connection:BridgeHubDisplayConnection={connected:true,onConnectionEvent(fn){handler=fn;return()=>{handler=undefined}},onConnectionClosed(fn){closed=fn;return()=>{closed=undefined}}}
    await expect(watchBridgeHubDisplay(connection,ref,async()=>{
      const parts=bridgeDisplayParts({ref,stream,epoch:1,seq:1,update:{kind:'snapshot',value:{message:'x'.repeat(100000)}}})
      const begin=(await parts.next()).value
      handler!({type:BRIDGE_HUB_THREAD_EVENT,profileId:'work',profileEpoch:1,data:begin})
      if(fail==='close')closed!(new Error('Disconnected'))
      else handler!({type:BRIDGE_HUB_THREAD_EVENT,profileId:'other',profileEpoch:2,data:begin})
      await parts.return(undefined)
    },value=>seen.push(value),new AbortController().signal)).rejects.toMatchObject({code:fail==='close'?'peer_offline':'forbidden'})
    expect(seen).toEqual([]);expect(handler).toBeUndefined();expect(closed).toBeUndefined()
  }
})

it('cancels an attach watch even while its local request has not replied', async () => {
  const abort=new AbortController(),ref={nodeId:newId('node'),entityId:'thread'}
  let off=0
  const connection:BridgeHubDisplayConnection={connected:true,onConnectionEvent(){return()=>{off++}},onConnectionClosed(){return()=>{off++}}}
  const watching=watchBridgeHubDisplay(connection,ref,async()=>{abort.abort();return await new Promise(()=>{})},()=>{throw new Error('No display')},abort.signal)
  await watching
  expect(off).toBe(2)
})

it('preserves the display failure when detach also fails after a disconnected daemon', async()=>{
  const target=newId('node'),request=prepareBridgeHubCommand(parseArgs(['bridge','attach',target,'thread']))
  await expect(executeBridgeHubCommand(request,{request:async()=>{throw new Error('Not connected')}},{emit(){},watch:async()=>{throw Object.assign(new Error('Daemon closed'),{code:'peer_offline'})}})).rejects.toMatchObject({code:'peer_offline'})
})
