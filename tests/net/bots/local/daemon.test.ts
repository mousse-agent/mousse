import { spawn,type ChildProcess } from 'node:child_process'
import { mkdtempSync,readFileSync,realpathSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { newId } from '../../../../src/shared/net'

const entry=resolve('out/cli/index.js')
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await closed}
it.skipIf(process.platform==='win32')('uses the emitted CLI and actual daemon owner profile to control an existing signed inactive bot',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bots-daemon-cli-'))),home=join(root,'home'),children:ChildProcess[]=[]
  let seed:MousseMainService|undefined
  const cli=(args:string[],input?:string)=>new Promise<{code:number|null;output:string;error:string;value?:any}>((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,'--home',home,'--json',...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:root,NO_COLOR:'1'}});children.push(child)
    let output='',error='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Actual bot CLI timed out'))},20000)
    child.stdout!.on('data',bytes=>{output+=bytes});child.stderr!.on('data',bytes=>{error+=bytes});child.on('error',reason=>{clearTimeout(timer);reject(reason)})
    child.on('exit',code=>{clearTimeout(timer);let value;try{value=JSON.parse(code===0?output:error)}catch{}resolve({code,output,error,value})});child.stdin!.end(input)
  })
  try{
    seed=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
    await seed.net.request('net.init',{listen:true,port:0});await seed.net.request('net.protect',{passphrase:'task-owned-cli-protection'})
    const rt=seed.net.runtime(),self=rt.identity.self()!,space=seed.spaces.host.create({name:'Emitted local bot CLI'}),channel=seed.spaces.host.createChannel(space.space,'general'),bot=newId('bot'),key=rt.keys.createBotKey(bot),delegation=rt.identity.issueBotDelegation({bot,key,name:'Owner fixture',hostNode:self.node}),digest=Buffer.alloc(32,2).toString('base64url')
    seed.spaces.host.postMeta(space.space,'bot.added',{record:{bot,owner:self.user,delegation,displayName:'Owner fixture',profile:'chat',policy:{steer:{kind:'everyone'},visibility:'public'}}})
    await seed.stop();seed=undefined
    let logs=''
    const daemon=spawn(process.execPath,[entry,'--home',home,'service','run'],{stdio:['ignore','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:root,NO_COLOR:'1'}});children.push(daemon)
    daemon.stdout!.on('data',bytes=>{logs=(logs+bytes).slice(-8000)});daemon.stderr!.on('data',bytes=>{logs=(logs+bytes).slice(-8000)})
    const deadline=Date.now()+40000
    for(;;){if(daemon.exitCode!==null||daemon.signalCode!==null)throw new Error('Task-owned daemon exited: '+logs);let ready=false;try{ready=JSON.parse(readFileSync(join(home,'mms.runtime.json'),'utf8')).pid===daemon.pid}catch{}if(ready)break;if(Date.now()>=deadline)throw new Error('Task-owned daemon readiness timed out');await new Promise(resolve=>setTimeout(resolve,40))}
    expect((await cli(['bots','--help'])).output).toContain('default production native adapter is inactive')
    expect((await cli(['net','unlock'],'task-owned-cli-protection')).code).toBe(0)
    const configured=await cli(['bots','configure',space.space,bot,'--adapter','mousse','--profile-kind','chat','--definition-revision','unqualified','--profile-digest',digest,'--daily-budget','1000','--run-ceiling','60','--max-concurrent','2','--runs-per-member-hour','20'])
    expect(configured.code,configured.error).toBe(0);expect(configured.value).toMatchObject({bot,owner:self.user,qualified:false})
    const qualification=await cli(['bots','qualify',space.space,bot,'--definition-revision','unqualified','--profile-digest',digest])
    expect(qualification.code).not.toBe(0);expect(qualification.value).toMatchObject({code:'profile_unsupported'})
    expect((await cli(['bots','stop',space.space,bot])).value).toMatchObject({stopped:true,qualified:false})
    expect((await cli(['bots','resume',space.space,bot])).value).toMatchObject({stopped:false,qualified:false})
    const listed=await cli(['bots','list','--limit','1']);expect(listed.code,listed.error).toBe(0);expect(listed.value.bots).toHaveLength(1)
    expect((await cli(['bots','presence',space.space,bot,channel])).value).toMatchObject({state:'offline'})
    const posted=await cli(['spaces','post',channel,'Actual emitted human mention','--mentions',bot]);expect(posted.code,posted.error).toBe(0);expect(posted.value.state).toBe('sent')
    const tail=await cli(['spaces','tail',channel]);expect(tail.value.records[0].envelope.refs).toEqual({mentions:[bot]})
    const rejected=await cli(['bots','configure',space.space,bot,'--definition','untrusted']);expect(rejected.code).not.toBe(0);expect(rejected.value).toMatchObject({code:'bad_request'})
    expect([logs,configured.output,qualification.error,tail.output].join('\n')).not.toContain('task-owned-cli-protection')
  }finally{if(seed)await seed.stop();await Promise.all(children.map(stop));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
},90000)
