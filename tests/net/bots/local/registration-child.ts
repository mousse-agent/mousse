import { readFileSync,writeFileSync,existsSync } from 'node:fs'
import { join } from 'node:path'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { BotLocalService } from '../../../../src/mms/bots/BotLocalService'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'

const [root,mode]=process.argv.slice(2),home=join(root,'home'),file=join(root,'request.json'),passphrase='task-owned-registration-crash-protection'
const main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
try{
  if(!main.net.runtime().identity.self()){
    await main.net.request('net.init',{listen:true,port:0});await main.net.request('net.protect',{passphrase})
    const space=main.spaces.host.create({name:'Actual crash registration'})
    writeFileSync(file,JSON.stringify({id:newId('rpc'),space:space.space,name:'Crash-recovered bot',profile:'chat',policy:{steer:{kind:'owner'},visibility:'public'}}))
  }else await main.net.request('net.unlock',{passphrase})
  const input=JSON.parse(readFileSync(file,'utf8')),rt=main.net.runtime(),local=new BotLocalService(main.bots)
  const evidence=()=>{
    const journal=JSON.parse(rt.db.database.prepare('SELECT value FROM net_bot_local_registration WHERE id=?').get(input.id)!.value as string),entry=rt.outbox.get(journal.event)
    return{journal,publicKey:rt.keys.ensureBotKey(journal.bot),profileDir:main.bots.options.profileHome,rootKey:rt.keys.rootKey(),...(entry?{envelope:Buffer.from(entry.envelope).toString('base64url'),signature:Buffer.from(entry.sig).toString('base64url')}: {})}
  }
  if(mode==='key-kill')Object.defineProperty(rt.db,'fault',{value:(point:string)=>{if(point==='bots.add.keyCreated'){writeFileSync(join(root,'killed.json'),JSON.stringify(evidence()));process.kill(process.pid,'SIGKILL')}}})
  if(mode==='ack-kill')main.spaces.host.onAppend((_stream,record)=>{if(decodeEnvelope(record.envelope).envelope.type==='bot.added'){writeFileSync(join(root,'killed.json'),JSON.stringify(evidence()));process.kill(process.pid,'SIGKILL')}})
  const result=await local.request('bots.add',input)
  writeFileSync(join(root,'completed.json'),JSON.stringify({result,...evidence(),roster:rt.identity.roster(),rows:rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n,executions:rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n}))
  if(!existsSync(file))throw new Error('Missing actual durable request')
}finally{await main.stop()}
