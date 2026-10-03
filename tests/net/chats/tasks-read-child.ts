import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { profile } from './helpers'
import { NetError, type RpcId } from '../../../src/shared/net'

const [home,profileId,chatId,taskId]=process.argv.slice(2)
const p=await profile({home,profileId}),service=p.services.chatNetwork
const task=service.listTasks({chatId}).tasks.find(row=>row.taskId===taskId)
if(!task)throw new Error('Original task was not rediscovered')
const deadline=Date.now()+15000
const opened=()=>{try{return p.services.net.session(task.target).state()==='open'}catch(error){if(error instanceof NetError&&error.code==='peer_offline')return false;throw error}}
while(!opened()){
  if(Date.now()>=deadline)throw new Error('Original target did not reconnect')
  await setTimeout(50)
}
const rt=p.services.net.runtime(),checkpoint=rt.db.checkpoint.bind(rt.db)
rt.db.checkpoint=point=>{
  if(point==='chats.task.validation.beforeCommit'){
    const status=p.services.bridge.hub.status(task.taskId)
    writeFileSync(join(home,'chats-task-read-crash.json'),JSON.stringify({chatId,taskId,original:status.original,state:status.state}))
    process.kill(process.pid,'SIGKILL')
  }
  checkpoint(point)
}
await service.getTask({chatId,taskId:taskId as RpcId,result:true})
throw new Error('Fixture did not reach the validation crash point')
