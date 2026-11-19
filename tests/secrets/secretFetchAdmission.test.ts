import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { secretFetchAction } from '../../src/mms/bots/actions/secretFetchAction'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { publicFetch } from '../../src/mms/net-public/publicFetch'
vi.mock('../../src/mms/net-public/publicFetch', async importOriginal => ({ ...await importOriginal<object>(), publicFetch: vi.fn() }))
const cleanups:Array<()=>void>=[]
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.restoreAllMocks()})
function fixture(value='sk-test-private/a+B0123456789'){
 const home=mkdtempSync(join(tmpdir(),'fetch-admission-')),store=new BotStore({profileHome:home})
 cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true})})
 const vault=new SecretVault({profileRoot:home,threadAlive:()=>true})
 vault.store('KEY',value,{threadId:'owner',keep:'saved',binding:resolveSecretBinding({service:'openai'})})
 vault.store('UNBOUND','other-private-value0123456789',{threadId:'owner',keep:'saved'})
 const secrets=createSecretToolHost({vault,requests:new SecretRequests(vault),scratchRoot:home})
 const host={...fakeAppToolHost().host,secrets:()=>secrets,botHomeOf:(id:string)=>id}
 const tool=secretTools(host).find(t=>t.name==='secret_fetch')!
 vi.mocked(publicFetch).mockClear().mockResolvedValue({status:200,headers:{'content-type':'text/plain'},body:Buffer.from('ok')})
 let call=0
 const invoke=(botId:string,args:Record<string,unknown>)=>{
  const secretFetch:NonNullable<BotAuthority['secretFetch']>=(input,send)=>secretFetchAction(store,{...input,botId,activationId:botId},send)
  const turn=appTurn({threadId:botId,runId:'run',bot:{secretFetch,appTools:new Set(['secret_fetch']),role:'activation',workspace:{scratch:home}} as never})
  return tool.handler(args,{turn,transport:'in_process',toolCallId:String(call++),signal:new AbortController().signal} as ToolCallContext)
 }
 return {store,invoke}
}
it('keeps the whole allowance after another bot makes 20 refused calls on the key',async()=>{
 const {store,invoke}=fixture()
 for(let i=0;i<20;i++)expect((await invoke('intruder',{secret:'KEY',path:'/v1/models'})).text).toContain('cannot use')
 const refused=store.all("SELECT * FROM bot_actions WHERE bot_id = 'intruder'")
 expect(refused).toHaveLength(20);expect(JSON.stringify(refused)).not.toContain('OpenAI')
 expect(refused.every(row=>row.ran_at===null)).toBe(true)
 for(let i=0;i<20;i++)expect((await invoke('owner',{secret:'KEY',path:'/v1/models'})).isError).not.toBe(true)
 expect((await invoke('owner',{secret:'KEY',path:'/v1/models'})).text).toContain('20 times this hour')
 expect(publicFetch).toHaveBeenCalledTimes(20)
})
it.each([
 {secret:'UNBOUND'}, {method:'POST'}, {path:'/outside'}, {path:'/v1/models/../files'},
 {headers:{Authorization:'ghp_abcdefghijklmnopqrstuvwxyz'}}, {headers:{Accept:'line\r\nbreak'}}, {headers:{Accept:'bad\x01value'}}, {headers:{Accept:'🔐'}},
 {headers:{Accept:'ghp_abcdefghijklmnopqrstuvwxyz'}}, {query:{q:'ghp_abcdefghijklmnopqrstuvwxyz'}}
])('validates %j before reserving any allowance',async patch=>{
 const {store,invoke}=fixture()
 expect((await invoke('owner',{secret:'KEY',path:'/v1/models',...patch})).isError).toBe(true)
 expect(store.get('SELECT ran_at FROM bot_actions')?.ran_at).toBeNull()
 expect(publicFetch).not.toHaveBeenCalled()
 if(patch.headers){const args=JSON.parse(String(store.get('SELECT args_json FROM bot_actions')?.args_json));expect(args.headers).toEqual(Object.keys(patch.headers));expect(JSON.stringify(args)).not.toContain('ghp_')}
})

it.each(['bad\x01key0123456789','bad🔐key0123456789','bad\rkey0123456789','bad\nkey0123456789'])('refuses a key that cannot form an HTTP header before counting it',async value=>{
 const {store,invoke}=fixture(value)
 expect((await invoke('owner',{secret:'KEY',path:'/v1/models'})).isError).toBe(true)
 expect(store.get('SELECT ran_at FROM bot_actions')?.ran_at).toBeNull();expect(publicFetch).not.toHaveBeenCalled()
})

it.each(['foreign-credential', ['foreign-credential'], null])('keeps malformed header values out of refused action history: %#', async headers => {
  const { store, invoke } = fixture()
  expect((await invoke('owner', { secret: 'KEY', path: '/v1/models', headers })).isError).toBe(true)
  const row = store.get('SELECT args_json, ran_at FROM bot_actions')!
  expect(row.ran_at).toBeNull()
  expect(JSON.parse(String(row.args_json)).headers).toEqual([])
  expect(String(row.args_json)).not.toContain('foreign-credential')
  expect(publicFetch).not.toHaveBeenCalled()
})
