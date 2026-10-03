import {expect,it} from 'vitest'
import {checkedTaskPage,checkedTaskRead,taskAction,taskViewDenied} from '../../src/renderer/components/chats/networkTaskState'
import type {ChatTaskRead,ChatTaskSelection} from '../../src/shared/chatsNetwork'
const task=(id='rpc_one',state:ChatTaskSelection['status']['state']='prepared'):ChatTaskSelection=>({kind:'bridge-task',chatId:'chat',taskId:id,target:'nod_target',validation:'pendingTargetValidation',status:{id,original:id,target:'nod_target',method:'bridge.dispatch',state,createdAt:1,updatedAt:1}} as ChatTaskSelection)
it('keeps prepared start separate from submitted result retrieval and gives failed tasks no effect action',()=>{
  expect(taskAction(task())).toBe('start')
  for(const state of ['unknown','completed','cancelRequested'] as const)expect(taskAction(task('rpc_one',state))).toBe('retrieve')
  expect(taskAction(task('rpc_one','failed'))).toBeUndefined()
})
it('bounds strict task-ID pages to the current Chat and validates the original cursor',()=>{
  expect(checkedTaskPage({tasks:[task('rpc_a'),task('rpc_b')],nextAfter:'rpc_b' as any},'chat').tasks).toHaveLength(2)
  for(const tasks of [[task('rpc_b'),task('rpc_a')],[task('rpc_a'),task('rpc_a')],[{...task(),chatId:'foreign'}],Array.from({length:33},(_,i)=>task(`rpc_${i}`))])expect(()=>checkedTaskPage({tasks},'chat')).toThrow()
  expect(()=>checkedTaskPage({tasks:[task('rpc_a')]},'chat','rpc_b' as any)).toThrow()
  expect(()=>checkedTaskPage({tasks:[task('rpc_a')],nextAfter:'rpc_wrong' as any},'chat')).toThrow()
})
it('accepts result presentation only after explicit retrieval for the matching verified original target',()=>{
  const read={selection:{...task('rpc_one','completed'),validation:'authorized'},result:{rpc:'rpc_one',author:{node:'nod_target'}}} as ChatTaskRead
  expect(checkedTaskRead(read,'chat','rpc_one' as any,true)).toBe(read)
  expect(()=>checkedTaskRead(read,'chat','rpc_one' as any,false)).toThrow()
  expect(()=>checkedTaskRead({...read,selection:{...read.selection,validation:'pendingTargetValidation'}},'chat','rpc_one' as any,true)).toThrow()
  expect(()=>checkedTaskRead({...read,result:{...read.result!,rpc:'rpc_other' as any}},'chat','rpc_one' as any,true)).toThrow()
  expect(()=>checkedTaskRead({...read,result:{...read.result!,author:{...read.result!.author,node:'nod_other' as any}}},'chat','rpc_one' as any,true)).toThrow()
})
it('clears scoped views on current authorization or proof denial while retaining display on transient offline errors',()=>{
  for(const code of ['forbidden','revoked','not_member','bad_delegation','bad_signature','roster_conflict','profile_mismatch','meta_stale','stream_unknown'])expect(taskViewDenied({code})).toBe(true)
  for(const code of ['peer_offline','deadline_exceeded','outcome_uncertain'])expect(taskViewDenied({code})).toBe(false)
  expect(taskViewDenied(new Error('Not permitted'))).toBe(false)
})
