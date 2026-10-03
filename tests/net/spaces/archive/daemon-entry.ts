/** Code-only task-owned physical fault fixture; not imported by production. */
import {writeFileSync,realpathSync} from 'node:fs'
import {basename,dirname,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {MousseMainService} from '../../../../src/mms/MousseMainService'
const create=MousseMainService.create.bind(MousseMainService),qaRoot=process.env.MOUSSE_ARCHIVE_QA_ROOT
if(qaRoot){
  const root=realpathSync(qaRoot)
  if(dirname(root)!==realpathSync(tmpdir())||!basename(root).startsWith('archive-daemons-'))throw Error('Archive QA requires a task-owned temporary root')
  MousseMainService.create=async options=>{
    if(!options.homeDir||!realpathSync(options.homeDir).startsWith(root+sep))throw Error('Archive QA refuses another home')
    const main=await create(options),db=main.net.runtime().db,checkpoint=db.checkpoint.bind(db)
    const archive=main.bridge.archives,request=archive.request.bind(archive)
    archive.request=(method,params)=>request(method,params).catch(error=>{process.stderr.write(String(error?.stack??'Archive QA error')+'\n');throw error})
    db.checkpoint=point=>{
      checkpoint(point)
      if(point===process.env.MOUSSE_ARCHIVE_QA_FAULT){writeFileSync(root+'/physical-fault.json',JSON.stringify({point}),{mode:0o600});process.kill(process.pid,'SIGKILL')}
    }
    return main
  }
}
await import('../../../../src/cli/index')
