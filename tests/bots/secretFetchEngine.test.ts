import { afterEach, expect, it } from 'vitest'
import { botFixture, createBot, start, type BotFixture } from './botFixture'
let f:BotFixture
afterEach(()=>f?.close())
it('supplies the ledger only for work, and service reads never become held calls',async()=>{
 f=botFixture();const {botId}=await createBot(f,{name:'Reader',reply:'Hello.'})
 await f.bots.service.chatSend({botId,text:'Read models',clientRequestId:'chat'})
 const chat=f.store.laneActivations(botId,'chat',['running'])[0]!
 expect((await start(f,chat.id)).prepared.authority.secretFetch).toBeUndefined()
 // A durable work activation, as the chat's work tool creates it.
 const work=await f.bots.tools.work.start(botId,chat.id,{title:'Models',brief:'Read models',key:'work'})
 const started=await start(f,work.workId)
 expect(started.prepared.authority.secretFetch).toBeTypeOf('function')
 await started.prepared.authority.secretFetch!({callKey:'read',secret:'KEY',service:'OpenAI',args:{path:'/v1/models'},mask:s=>s},async()=>({text:'data'}))
 expect(f.store.get("SELECT status FROM bot_actions WHERE activation_id = ?",work.workId)?.status).toBe('done')
 expect(f.bots.actions.forWork(work.workId)).toBeUndefined()
})
