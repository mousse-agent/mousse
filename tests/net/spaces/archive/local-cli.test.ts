import {expect,it} from 'vitest'
import {parseArgs} from '../../../../src/cli/parseArgs'
import {prepareSpaceArchiveCommand,executeSpaceArchiveCommand} from '../../../../src/cli/commands/spaceArchive'
import {commandHelp} from '../../../../src/cli/help'
import {validateSpaceArchive} from '../../../../src/mms/spaces/archive/registerMethods'
import {newId} from '../../../../src/shared/net'
const space=newId('space')
it('routes actual parsed archive commands and validates bounded local-only DTOs before connection',()=>{
  expect(prepareSpaceArchiveCommand(parseArgs(['spaces','freeze',space,'Consistent cut']))).toEqual({method:'spaces.archive.freeze',params:{space,reason:'Consistent cut'}})
  expect(prepareSpaceArchiveCommand(parseArgs(['spaces','import','/private/tmp/archive','--archive-mode','move']))).toEqual({method:'spaces.archive.import',params:{path:'/private/tmp/archive',mode:'move'}})
  expect(prepareSpaceArchiveCommand(parseArgs(['spaces','archive-status','--after',space,'--limit','1']))).toEqual({method:'spaces.archive.status',params:{after:space,limit:1}})
  expect(commandHelp('spaces')).toContain('spaces activate');expect(commandHelp('spaces')).toContain('foreign controller')
  for(const args of [['freeze',space],['freeze','display','cut'],['export',space,'/tmp','--quiesced'],['activate',space,'--qualified'],['import','/tmp','--archive-mode','invalid'],['retire',space,'--provider','paid'],['activate',space,'--descriptor','caller'],['archive-status',space,'--limit','1']])expect(()=>prepareSpaceArchiveCommand(parseArgs(['spaces',...args]))).toThrow()
  for(const fields of [{path:'/tmp',mode:'restore',profileId:'substitute'},{path:'relative',mode:'restore'},{path:'/tmp',mode:'restore',terminal:true},{path:'/tmp',mode:'restore',privateKey:'secret'},{path:'/tmp',mode:'restore',recovery:{qualified:true}}])expect(()=>validateSpaceArchive('spaces.archive.import',fields)).toThrow()
})
it('forwards only validated catalog params and emits the actual durable phase',async()=>{
  const request=prepareSpaceArchiveCommand(parseArgs(['spaces','activate',space])),calls:unknown[]=[],output:unknown[]=[],receipt={space,state:'importedFrozen',digest:'a'.repeat(64)}
  await executeSpaceArchiveCommand(request,{request:async<T>(method:string,params:unknown)=>{calls.push({method,params});return receipt as T}},value=>output.push(value))
  expect(calls).toEqual([{method:'spaces.archive.activate',params:{space}}]);expect(output).toEqual([receipt])
})
