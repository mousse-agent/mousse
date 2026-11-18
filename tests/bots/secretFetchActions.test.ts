import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { secretFetchAction } from '../../src/mms/bots/actions/secretFetchAction'
const homes:string[]=[];const stores:BotStore[]=[]
afterEach(()=>{stores.splice(0).forEach(s=>s.close());homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}))})
function setup(){const profileHome=mkdtempSync(join(tmpdir(),'fetch-actions-'));homes.push(profileHome);const store=new BotStore({profileHome});stores.push(store);return store}
it('records one approved/running/done row per call and masks arguments and results',async()=>{
 const store=setup();const input={botId:'b',activationId:'a',callKey:'one',secret:'KEY',service:'OpenAI',args:{path:'/v1/models'},mask:(s:string)=>s.replaceAll('private-value','[hidden]')}
 const run=()=>secretFetchAction(store,{...input,args:{path:'private-value'}},async()=>{expect(store.get("SELECT status FROM bot_actions WHERE call_key = ?",'one')?.status).toBe('running');return {text:'private-value'}})
 expect((await run()).text).not.toContain('private-value');await run()
 const rows=store.all('SELECT * FROM bot_actions');expect(rows).toHaveLength(1);expect(rows[0].status).toBe('done');expect(rows[0].target_json).toContain('OpenAI');expect(JSON.stringify(rows)).not.toContain('private-value')
})
it('refuses the 21st read per secret in a rolling hour and records failure',async()=>{
 const store=setup();let calls=0
 const run=(i:number,secret='KEY')=>secretFetchAction(store,{botId:'b',activationId:'a',callKey:String(i),secret,service:'OpenAI',args:{},mask:s=>s},async()=>{calls++;return {text:'ok'}})
 for(let i=0;i<20;i++)expect((await run(i)).isError).not.toBe(true)
 expect((await run(20)).text).toBe("You've read from OpenAI 20 times this hour; try again later or tell your owner.");expect(calls).toBe(20)
 expect((await run(21,'OTHER')).isError).not.toBe(true);expect(store.all('SELECT * FROM bot_actions')).toHaveLength(22)
})
it('enforces the per-bot daily cap across secrets',async()=>{const store=setup();for(let i=0;i<100;i++)await secretFetchAction(store,{botId:'b',activationId:'a',callKey:String(i),secret:String(i),service:'OpenAI',args:{},mask:s=>s},async()=>({text:'ok'}));expect((await secretFetchAction(store,{botId:'b',activationId:'a',callKey:'limit',secret:'new',service:'OpenAI',args:{},mask:s=>s},async()=>({text:'should not run'}))).isError).toBe(true)})
