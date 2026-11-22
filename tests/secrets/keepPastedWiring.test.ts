import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import type { HandlerContext } from '../../src/mms/protocol/handlers'

it('the GUI allowlist and registered profile handler keep a key in the real profile vault', async()=>{
  const {PLATFORM_REQUEST_METHODS}=await import('../../src/main/ipc/registerGuiIpc')
  expect(PLATFORM_REQUEST_METHODS.has('secrets.keepPasted')).toBe(true)
  vi.spyOn(ProviderAuthService.prototype,'init').mockResolvedValue(undefined)
  const root=mkdtempSync(join(tmpdir(),'pasted-wiring-'))
  const main=await MousseMainService.create({homeDir:join(root,'home'),repoRoot:root,requireOwnership:false,headless:true})
  try {
    const thread=main.threads.createThread('Bot home')
    // Bot grant resolution is covered with a real bot in keepPasted.test.ts; this test crosses composition and admission.
    const resolver=vi.spyOn(main.personalBots!.service,'secretHome').mockReturnValue({threadId:thread.id,allowed:true})
    const value='sk-'+'W'.repeat(48)
    const reply=await main.domains.dispatch({connection:{clientType:'gui',binding:{profileId:main.getProfileId(),epoch:1},capabilities:new Set()}} as unknown as HandlerContext,'secrets.keepPasted',{botId:'example',value,keep:'day'})
    expect(reply).toEqual({name:'OPENAI_API_KEY'})
    expect(resolver).toHaveBeenCalledWith('example')
    expect(main.secretVault.value('OPENAI_API_KEY')).toBe(value)
    expect(main.secretVault.usableIn('OPENAI_API_KEY',thread.id)).toBe(true)
    expect(JSON.stringify(reply)).not.toContain(value)
  } finally { await main.stop();vi.restoreAllMocks();rmSync(root,{recursive:true,force:true}) }
})
