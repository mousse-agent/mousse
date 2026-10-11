import type { ChatTaskPage, ChatTaskRead, ChatTaskSelection } from '../../../shared/chatsNetwork'
import { isNetErrorCode, NET_ERRORS, type RpcId } from '../../../shared/net'

export function taskAction(task:ChatTaskSelection):'start'|'retrieve'|undefined{
  return task.status.state==='prepared'?'start':task.status.state==='failed'?undefined:'retrieve'
}
export function taskViewDenied(cause:unknown):boolean{
  const code=(cause as {code?:unknown}|null)?.code
  return isNetErrorCode(code)&&NET_ERRORS[code].category==='denied'||typeof code==='string'&&['cancelled','profile_mismatch','profile_binding_required','capability_required','roster_conflict','stream_unknown','meta_stale','space_frozen','upgrade_required','conflict'].includes(code)
}
export function checkedTask(task:ChatTaskSelection,chatId:string,id?:RpcId):ChatTaskSelection{
  if(task.chatId!==chatId||id!==undefined&&task.taskId!==id||task.status.original!==task.taskId||task.status.id!==task.taskId||task.target!==task.status.target||task.status.method!=='bridge.dispatch')throw{code:'conflict',message:'The task response does not match this selection.'}
  return task
}
export function checkedTaskPage(page:ChatTaskPage,chatId:string,after?:RpcId):ChatTaskPage{
  if(page.tasks.length>32||new Set(page.tasks.map(task=>task.taskId)).size!==page.tasks.length)throw{code:'conflict',message:'Invalid task page.'}
  let previous=after
  for(const task of page.tasks){checkedTask(task,chatId);if(previous!==undefined&&task.taskId<=previous)throw{code:'conflict',message:'Invalid task page cursor.'};previous=task.taskId}
  if(page.nextAfter!==undefined&&page.nextAfter!==page.tasks.at(-1)?.taskId)throw{code:'conflict',message:'Invalid task page cursor.'}
  return page
}
/** This is a response-scope check; the owner service verifies the signed result. */
export function checkedTaskRead(read:ChatTaskRead,chatId:string,id:RpcId,resultRequested:boolean):ChatTaskRead{
  checkedTask(read.selection,chatId,id)
  if(read.result&&(!resultRequested||read.selection.validation!=='authorized'||read.result.rpc!==id||read.result.author.node!==read.selection.target))throw{code:'conflict',message:'The result is not verified for this task.'}
  return read
}

export function canPrepareAnother(original:RpcId|undefined,selection:ChatTaskSelection|undefined):boolean{
  return original!==undefined&&selection?.taskId===original&&['completed','failed'].includes(selection.status.state)
}
