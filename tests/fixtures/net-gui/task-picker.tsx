import React from 'react'
import { createRoot } from 'react-dom/client'
import { NetworkTaskPicker } from '../../../src/renderer/components/chats/NetworkTaskPicker'
import type { ChatTaskSelection } from '../../../src/shared/chatsNetwork'
import type { MousseAPI } from '../../../src/preload'

// React/DOM behavior fixture only. Backend crypto, TLS and restart qualification
// belongs to tests/net/chats/tasks.test.ts; this fixture never starts a daemon.
const node='nod_fixture',durable='rpc_durable'
let chatId='chat-fixture',readonly=false,calls:Array<{method:string;params:any}>=[],saved=new Map<string,ChatTaskSelection>(),original:any,deny=false,hold=false,release:(()=>void)|undefined
const selection=(id=durable,state:ChatTaskSelection['status']['state']='prepared'):ChatTaskSelection=>({kind:'bridge-task',chatId,taskId:id,target:node,validation:state==='completed'?'authorized':state==='failed'?'rejected':'pendingTargetValidation',status:{id,original:id,target:node,method:'bridge.dispatch',state,createdAt:1,updatedAt:1}} as ChatTaskSelection)
function seed(){saved=new Map([[durable,selection()],[ 'rpc_failed',selection('rpc_failed','failed')]])}
seed()
window.mousse={platformRequest:{request:async(method:string,params:any)=>{
  calls.push({method,params:structuredClone(params)})
  if(method==='bridge.nodes')return{nodes:[{node,name:'Fixture device',self:false,revoked:false,caps:['read','write'],state:'open'}]}
  if(method==='chats.tasks'){
    const tasks=[...saved.values()].filter(task=>!params.after||task.taskId>params.after).sort((a,b)=>a.taskId.localeCompare(b.taskId))
    return{tasks:tasks.slice(0,1),...(tasks.length>1?{nextAfter:tasks[0].taskId}:{})}
  }
  if(method==='chats.assignDevice'){
    if(!original){original=structuredClone(params);saved.set(params.taskId,selection(params.taskId));throw{code:'deadline_exceeded',message:'Lost preparation reply'}}
    if(JSON.stringify(params)!==JSON.stringify(original))throw{code:'conflict',message:'Changed original preparation'}
    return saved.get(params.taskId)
  }
  if(method==='chats.dispatch'){
    saved.set(params.taskId,selection(params.taskId,'unknown'));throw{code:'deadline_exceeded',message:'Lost Start reply'}
  }
  if(method==='chats.task.get'){
    if(deny){deny=false;throw{code:'not_member',message:'Current membership denied'}}
    const captured=structuredClone(saved.get(params.taskId))
    if(hold){hold=false;await new Promise<void>(done=>{release=done})}
    if(!params.result)return{selection:captured}
    const complete=selection(params.taskId,'completed');saved.set(params.taskId,complete)
    return{selection:complete,result:{rpc:params.taskId,author:{node},headCommit:'verified-commit',threadId:'verified-thread'}}
  }
  throw new Error('Unexpected effect '+method)
}}} as unknown as MousseAPI
let root=createRoot(document.getElementById('root')!)
const render=()=>root.render(<NetworkTaskPicker chatId={chatId} readonly={readonly}/> )
render()
;(window as any).taskFixture={
  calls:()=>calls,
  reset(mode:string,nextChat='chat-fixture',preserve=false){root.unmount();root=createRoot(document.getElementById('root')!);chatId=nextChat;readonly=false;calls=[];if(!preserve){saved=new Map();original=undefined;if(mode==='durable')seed()}render()},
  readonly(value:boolean){readonly=value;render()},
  deny(){deny=true},hold(){hold=true},release(){release?.();release=undefined},
  set(label:string,value:string){const element=[...document.querySelectorAll('label')].find(e=>e.textContent?.startsWith(label))?.querySelector('input,textarea,select') as HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;if(!element)throw new Error('Missing field '+label);const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}))},
  click(text:string){const button=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!button||button.disabled)throw new Error('Missing/enabled button '+text);button.click()},
  hasButton(text:string){return [...document.querySelectorAll('button')].some(button=>button.textContent===text)},
  prepared:()=>original
}
