import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatTaskDispatchResult, ChatTaskPage, ChatTaskRead, ChatTaskSelection, ChatTaskSelectionInput, ChatTaskVerifiedResult } from '../../../shared/chatsNetwork'
import { newId, type NodeId, type RpcId } from '../../../shared/net'
import { canPrepareAnother, checkedTask, checkedTaskPage, checkedTaskRead, taskAction, taskViewDenied } from './networkTaskState'

type Device={node:NodeId;name:string;self:boolean;revoked:boolean;caps:string[];state:string}
export function NetworkTaskPicker({ chatId, readonly }: { chatId: string; readonly: boolean }) {
  const [devices,setDevices]=useState<Device[]>([])
  const [device,setDevice]=useState<NodeId>(),[repo,setRepo]=useState(''),[commit,setCommit]=useState(''),[agent,setAgent]=useState(''),[prompt,setPrompt]=useState('')
  const [prepared,setPrepared]=useState<ChatTaskSelectionInput>(),original=useRef<ChatTaskSelectionInput|undefined>(undefined)
  const [tasks,setTasks]=useState<ChatTaskSelection[]>([]),[nextAfter,setNextAfter]=useState<RpcId>(),[selection,setSelection]=useState<ChatTaskSelection>(),[result,setResult]=useState<ChatTaskVerifiedResult>()
  const [busy,setBusy]=useState(false),[loadingList,setLoadingList]=useState(false),[error,setError]=useState(''),[denied,setDenied]=useState(false)
  const scope=useRef({active:true}),working=useRef(false)
  const fail=useCallback((cause:unknown,owner:{active:boolean})=>{
    if(!owner.active)return
    if(taskViewDenied(cause)){setDenied(true);setTasks([]);setNextAfter(undefined);setSelection(undefined);setResult(undefined);setDevices([])}
    setError(String((cause as {message?:unknown}|null)?.message??cause))
  },[])
  useEffect(()=>{
    const owner={active:true};scope.current=owner;working.current=false;original.current=undefined
    setPrepared(undefined);setSelection(undefined);setResult(undefined);setTasks([]);setNextAfter(undefined);setDevices([]);setDevice(undefined);setRepo('');setCommit('');setAgent('');setPrompt('');setBusy(false);setError('');setDenied(false);setLoadingList(true)
    void window.mousse.platformRequest.request<{nodes:Device[]}>('bridge.nodes',{}).then(value=>{
      if(owner.active)setDevices(value.nodes.filter(node=>!node.self&&!node.revoked&&node.caps.includes('write')))
    },cause=>fail(cause,owner))
    void window.mousse.platformRequest.request<ChatTaskPage>('chats.tasks',{chatId,limit:32}).then(value=>{
      if(!owner.active)return
      const page=checkedTaskPage(value,chatId);setTasks(page.tasks);setNextAfter(page.nextAfter);setDenied(false)
    }).catch(cause=>fail(cause,owner)).finally(()=>{if(owner.active)setLoadingList(false)})
    return()=>{owner.active=false}
  },[chatId,fail])
  const loadTasks=async(after?:RpcId)=>{
    if(working.current||loadingList)return
    const owner=scope.current;working.current=true;setLoadingList(true);setError('');setSelection(undefined);setResult(undefined)
    try{
      const value=await window.mousse.platformRequest.request<ChatTaskPage>('chats.tasks',{chatId,limit:32,...(after?{after}:{})})
      if(owner.active){const page=checkedTaskPage(value,chatId,after);setTasks(page.tasks);setNextAfter(page.nextAfter);setDenied(false)}
    }catch(cause){fail(cause,owner)}finally{if(owner.active){working.current=false;setLoadingList(false)}}
  }
  const applyRead=(value:ChatTaskRead,taskId:RpcId,resultRequested:boolean)=>{
    const read=checkedTaskRead(value,chatId,taskId,resultRequested)
    setDenied(false);setSelection(read.selection);setResult(read.result);setTasks(previous=>previous.map(task=>task.taskId===taskId?read.selection:task))
  }
  const readTask=async(task:ChatTaskSelection,wantResult=false)=>{
    if(working.current||wantResult&&taskAction(task)!=='retrieve')return
    const owner=scope.current;working.current=true;setBusy(true);setError('');setResult(undefined)
    try{
      const value=await window.mousse.platformRequest.request<ChatTaskRead>('chats.task.get',{chatId,taskId:task.taskId,...(wantResult?{result:true}:{})})
      if(owner.active)applyRead(value,task.taskId,wantResult)
    }catch(cause){fail(cause,owner)}finally{if(owner.active){working.current=false;setBusy(false)}}
  }
  const prepare=async()=>{
    if(working.current||readonly||!device)return
    const owner=scope.current,input=original.current??={chatId,taskId:newId('rpc'),deviceId:device,input:{repoId:repo.trim(),baseCommit:commit.trim(),agent:agent.trim(),prompt,limits:{maxTurns:4,maxToolCalls:16,maxElapsedMs:300000}}}
    setPrepared(input);working.current=true;setBusy(true);setError('');setResult(undefined)
    try{
      const value=await window.mousse.platformRequest.request<ChatTaskSelection>('chats.assignDevice',structuredClone(input))
      if(owner.active){setSelection(checkedTask(value,chatId,input.taskId));setDenied(false)}
    }catch(cause){fail(cause,owner)}finally{if(owner.active){working.current=false;setBusy(false)}}
  }
  const start=async()=>{
    if(working.current||readonly||!selection||taskAction(selection)!=='start')return
    const owner=scope.current,taskId=selection.taskId;working.current=true;setBusy(true);setError('');setResult(undefined)
    // Until the owner journal answers, only reads of this original are safe.
    const attempted:ChatTaskSelection={...selection,validation:'pendingTargetValidation',status:{...selection.status,state:'unknown'}}
    setSelection(attempted);setTasks(previous=>previous.map(task=>task.taskId===taskId?attempted:task))
    try{
      const value=await window.mousse.platformRequest.request<ChatTaskDispatchResult>('chats.dispatch',{chatId,taskId})
      if(owner.active)applyRead(value,taskId,true)
    }catch(cause){fail(cause,owner)}finally{if(owner.active){working.current=false;setBusy(false)}}
  }
  const prepareAnother=()=>{
    if(working.current||!canPrepareAnother(original.current?.taskId,selection))return
    original.current=undefined;setPrepared(undefined);setSelection(undefined);setResult(undefined);setError('');setDevice(undefined);setRepo('');setCommit('');setAgent('');setPrompt('')
  }
  const selectedOutsidePage=selection&&!tasks.some(task=>task.taskId===selection.taskId)
  return <details className="chat-network-task"><summary>Tasks on my devices</summary>
    <label>Saved task<select aria-label="Saved task" value={selection?.taskId??''} disabled={busy||loadingList} onChange={event=>{
      const task=tasks.find(row=>row.taskId===event.target.value)??(selection?.taskId===event.target.value?selection:undefined)
      setSelection(task);setResult(undefined);if(task)void readTask(task)
    }}><option value="">Choose a saved task</option>{tasks.map(task=><option key={task.taskId} value={task.taskId}>{task.taskId} · {task.status.state}</option>)}{selectedOutsidePage&&<option value={selection.taskId}>{selection.taskId} · {selection.status.state}</option>}</select></label>
    <button type="button" disabled={busy||loadingList} onClick={()=>void loadTasks()}>Refresh saved tasks</button>
    {nextAfter&&<button type="button" disabled={busy||loadingList} onClick={()=>void loadTasks(nextAfter)}>Next tasks</button>}
    {loadingList&&<p role="status">Loading saved tasks…</p>}
    {selection&&<>
      <p role="status">{selection.validation==='authorized'?'Verified result available':selection.validation==='rejected'?'Rejected':'Awaiting target validation'} · {selection.status.state}</p>
      <p>Task <code>{selection.taskId}</code> on {devices.find(node=>node.node===selection.target)?.name??selection.target}</p>
      <button type="button" disabled={busy||loadingList} onClick={()=>void readTask(selection)}>Refresh task status</button>
      {taskAction(selection)==='start'&&<button type="button" disabled={busy||readonly||loadingList} onClick={()=>void start()}>Start task on selected device</button>}
      {taskAction(selection)==='retrieve'&&<button type="button" disabled={busy||loadingList} onClick={()=>void readTask(selection,true)}>Retrieve original result</button>}
    </>}
    {result&&<p>Verified result · commit <code>{result.headCommit}</code><span>Thread {result.threadId}</span></p>}
    {!denied&&(!selection||prepared)&&<>
      <p>The selected device checks its repository and agent before starting. Limits: 4 turns, 16 tool calls, 5 minutes.</p>
      <fieldset disabled={busy||readonly||!!prepared}>
        <label>Device<select aria-label="Task device" value={device??''} onChange={event=>setDevice(event.target.value as NodeId)}><option value="">Select a device</option>{devices.map(node=><option key={node.node} value={node.node}>{node.name} · {node.state==='open'?'Online':'Offline'}</option>)}</select></label>
        <label>Authorized repository ID<input value={repo} onChange={event=>setRepo(event.target.value)}/></label>
        <label>Base commit<input value={commit} onChange={event=>setCommit(event.target.value)}/></label>
        <label>Published agent ID on that device<input value={agent} onChange={event=>setAgent(event.target.value)}/></label>
        <label>Task<textarea value={prompt} onChange={event=>setPrompt(event.target.value)}/></label>
      </fieldset>
      {(!selection||prepared?.taskId!==selection.taskId)&&<button type="button" disabled={busy||readonly||!device||!repo.trim()||!commit.trim()||!agent.trim()||!prompt.trim()} onClick={()=>void prepare()}>{prepared?'Retry original preparation':'Prepare task'}</button>}
    </>}
    {!denied&&canPrepareAnother(prepared?.taskId,selection)&&<button type="button" disabled={busy||loadingList} onClick={prepareAnother}>Prepare another task</button>}
    {prepared&&!denied&&<p className="chat-network-delivery">Original preparation <code>{prepared.taskId}</code>. Its input and ID stay fixed while the reply is being checked.</p>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
  </details>
}
