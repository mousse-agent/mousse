import { expect, it, vi } from 'vitest'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import { appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { BOT_SECRET_TOOLS } from '../../src/shared/bots/personal/manifest'
it('offers a bound read only to work with a ledger and hands it to the home vault',async()=>{
 const fetch=vi.fn().mockResolvedValue({text:'safe data'}), record=vi.fn(async(_args,run)=>run())
 const host={...fakeAppToolHost(),botHomeOf:()=> 'home',secrets:()=>({fetch,masker:()=>undefined,binding:()=>({service:'OpenAI'})})}
 const tool=secretTools(host as never).find(t=>t.name==='secret_fetch')!
 expect(tool).toBeDefined();expect(BOT_SECRET_TOOLS).toContain('secret_fetch')
 const turn=appTurn({bot:{secretFetch:record,workspace:{scratch:'/run'}} as never})
 expect(tool.available!(turn)).toBe(true)
 const args={secret:'KEY',path:'/v1/models'}
 const ctx={turn,transport:'in_process',toolCallId:'call',signal:new AbortController().signal} as ToolCallContext
 expect(await tool.handler(args,ctx)).toEqual({text:'safe data'})
 expect(record).toHaveBeenCalled();expect(fetch).toHaveBeenCalledWith(expect.objectContaining({threadId:'home',folder:'/run',args}))
 const chat=appTurn({bot:{workspace:{scratch:'/run'}} as never});expect(tool.available!(chat)).not.toBe(true)
 expect((await tool.handler(args,{...ctx,turn:chat})).isError).toBe(true)
 expect(fetch).toHaveBeenCalledTimes(1)
})
