import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { newId } from '../../../../src/shared/net'

import { buildTestCli } from '../../helpers/build'

let fixture: Awaited<ReturnType<typeof buildTestCli>> | undefined
let entry: string
let cliEntry: string

beforeAll(async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return
  fixture = await buildTestCli({ nativeReader: true })
  cliEntry = fixture.entry
  entry = await fixture.buildEntry('scripts/net/qa/native-reader-daemon.ts', 'net-qa/native-reader-daemon.js')
}, 60000)
afterAll(() => fixture?.cleanup())
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function wait<T>(get: () => T|undefined, label: string, timeout = 40000): Promise<T> {
  const end = Date.now()+timeout
  for (;;) { const value = get(); if (value !== undefined) return value; if (Date.now()>=end) throw Error(`Actual daemon ${label} timed out`); await sleep(50) }
}
function read(home: string): any { try { return JSON.parse(readFileSync(join(home,'reader-qa-report.json'),'utf8')) } catch { return undefined } }
async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (child.exitCode!==null || child.signalCode!==null) return
  const ended = new Promise<void>(resolve => child.once('exit',()=>resolve()))
  child.kill(signal); await ended
}
function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'reader-three-daemons-'))), project=join(root,'project'), sensitive=join(root,'sensitive'), children:ChildProcess[]=[],ownerLogs:Array<{role:string;pid:number|undefined;log:string}>=[]
  mkdirSync(project); mkdirSync(sensitive); writeFileSync(join(project,'allowed.txt'),'SAFE_READER_MARKER\n'); writeFileSync(join(sensitive,'secret.txt'),'QA_PRIVATE_DENIED_MARKER\n')
  symlinkSync(join(sensitive,'secret.txt'),join(project,'secret-link'));linkSync(join(sensitive,'secret.txt'),join(project,'secret-hardlink'))
  const start=async(role:'host'|'executor'|'sender')=>{
    const home=join(root,role);mkdirSync(home,{recursive:true});let logs=''
    const child=spawn(process.execPath,[entry,home,project,role],{stdio:['ignore','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:project,NO_COLOR:'1'}});children.push(child)
    const evidence={role,pid:child.pid,log:''};ownerLogs.push(evidence)
    const capture=(bytes:Buffer)=>{logs=(logs+bytes).slice(-16000);evidence.log=logs}
    child.stdout!.on('data',capture);child.stderr!.on('data',capture)
    await wait(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`Actual ${role} owner exited: ${logs}`);const report=read(home);return report?.pid===child.pid?report:undefined},role+' owner readiness')
    return {role,home,child,report:()=>read(home),logs:()=>logs}
  }
  const cli=(home:string,args:string[],input?:string)=>new Promise<{code:number|null;value:any;output:string;error:string;durationMs:number}>((resolve,reject)=>{
    const started=Date.now()
    const child=spawn(process.execPath,[cliEntry,'--home',home,'--json',...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,MOUSSE_REPO_ROOT:project,NO_COLOR:'1'}});children.push(child)
    let output='',error='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Actual reader owner CLI timed out'))},30000)
    child.stdout!.on('data',bytes=>{output+=bytes});child.stderr!.on('data',bytes=>{error+=bytes});child.once('error',reason=>{clearTimeout(timer);reject(reason)});child.once('exit',code=>{clearTimeout(timer);let value;try{value=JSON.parse(code===0?output:error)}catch{}resolve({code,value,output,error,durationMs:Date.now()-started})});child.stdin!.end(input)
  })
  return {root,project,sensitive,start,cli,ownerLogs,async close(){await Promise.all(children.map(child=>kill(child)));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}}
}

it.skipIf(!['darwin','linux'].includes(process.platform))('loads the exact hashed packaged reader only through trusted owner code, preserving protected keys and ordinary local IPC across restart',async()=>{
  const qa=harness()
  try {
    const owner=await qa.start('executor'), inactive=await qa.start('host')
    expect(owner.report()).toMatchObject({readerSupported:true,paidProviderQualified:false,callCount:0,artifact:{napi:8,packaged:true}})
    expect(inactive.report()).toMatchObject({readerSupported:false,callCount:0})
    expect((await qa.cli(owner.home,['net','init','--listen'])).code).toBe(0)
    expect((await qa.cli(owner.home,['net','protect'],'fixed-reader-owned-protection')).code).toBe(0)
    const original=await wait(()=>owner.report()?.protected?owner.report():undefined,'protected reader keys')
    expect(original.self.user).toBeDefined()
    const stopped=await qa.cli(owner.home,['service','stop']);expect(stopped.code,stopped.error).toBe(0)
    await wait(()=>owner.child.exitCode!==null?true:undefined,'cooperative owner exit')
    const restarted=await qa.start('executor')
    expect(restarted.report().self).toMatchObject({user:original.self.user,node:original.self.node,isAuthority:false})
    expect((await qa.cli(restarted.home,['net','unlock'],'fixed-reader-owned-protection')).code).toBe(0)
    await wait(()=>restarted.report()?.self?.isAuthority===true?true:undefined,'unlocked authority proof')
    expect(restarted.report().self).toEqual(original.self)
    expect(restarted.report().paidProviderQualified).toBe(false)
    expect(restarted.report().callCount).toBe(0)
    expect((await qa.cli(restarted.home,['bots','list'])).value).toEqual({bots:[]})
    expect([owner.logs(),restarted.logs()].join('\n')).not.toContain('fixed-reader-owned-protection')
  } finally { await qa.close() }
},90000)

it.skipIf(!['darwin','linux'].includes(process.platform))('uses three emitted protected owners for approved reader containment, real presence expiry, and original Host receipt replay windows',async()=>{
  const qa=harness(), transcript:Array<Record<string,unknown>>=[], artifact=join(tmpdir(),`mousse-reader-three-qualification-${process.pid}-${Date.now()}.json`)
  let qualified=false
  const command=async(home:string,args:string[],input?:string)=>{const result=await qa.cli(home,args,input);expect(result.code,`${basename(home)} ${args[0]} ${args[1]} (${result.durationMs}ms): ${result.error}`).toBe(0);return result.value}
  const currentPresence=(owner:Awaited<ReturnType<typeof qa.start>>,bot:string)=>owner.report()?.presence.find((row:any)=>row.bot===bot)?.view.state
  try {
    const host=await qa.start('host'), executor=await qa.start('executor'), sender=await qa.start('sender')
    for(const owner of [host,executor,sender]){await command(owner.home,['net','init','--listen','--port','0']);await command(owner.home,['net','protect'],'fixed-reader-owned-protection')}
    const space=await command(host.home,['spaces','create','Actual emitted reader'])
    for(const owner of [executor,sender]){const invite=await command(host.home,['spaces','invite',space.space]);await command(owner.home,['spaces','join'],invite.invite);await command(owner.home,['spaces','tail',space.channel])}
    const addArgs=['bots','add',space.space,'Immutable reader','--id',newId('rpc'),'--profile-kind','reader','--steer','everyone']
    let added=await command(executor.home,addArgs)
    transcript.push({gate:'registration-first-result',result:added})
    const registrationDeadline=Date.now()+15000
    while(added.state==='unknown'&&added.delivery?.state==='sent'&&Date.now()<registrationDeadline){await sleep(100);added=await command(executor.home,addArgs)}
    expect(added.state).toBe('registered');const bot=added.bot, config=executor.report()
    await wait(()=>executor.report()?.channels.some((channel:any)=>channel.clock)?true:undefined,'actual correlated Host clock')
    await command(executor.home,['bots','configure',space.space,bot,'--adapter','mousse','--profile-kind','reader','--definition-revision',config.definitionRevision,'--profile-digest',config.profileDigest,'--project-id',config.projectId,'--daily-budget','1000','--run-ceiling','100','--max-concurrent','1','--runs-per-member-hour','20'])
    await command(executor.home,['bots','qualify',space.space,bot,'--definition-revision',config.definitionRevision,'--profile-digest',config.profileDigest])
    const original=await command(sender.home,['spaces','post',space.channel,'Read the fixed project safely','--mentions',bot])
    expect(original.state).toBe('sent')
    const grantAll=async(owner:typeof executor,trigger:string)=>{
      const deadline=Date.now()+120000, granted=new Set<string>()
      for(;;){
        const report=owner.report(),execution=report?.executions.find((row:any)=>row.key?.trigger===trigger||row.trigger===trigger)
        for(const permission of report?.permissions??[]){if(permission.body.trigger!==trigger||permission.phase!=='pending'||!permission.committed||granted.has(permission.request))continue;expect(permission.originalHash).toBe(permission.hash);expect(permission.originalSignature).toBeDefined();const grant=await command(owner.home,['bots','grant',permission.stream,permission.request,'--approve']);transcript.push({gate:'original-owner-grant',grant});granted.add(permission.request);await wait(()=>owner.report()?.permissions.find((row:any)=>row.request===permission.request)?.phase==='consumed'?true:undefined,'original signed grant HostACK and consume',10000)}
        if(execution?.state==='completed')return {execution,granted:[...granted],report}
        if(execution&&['failed','cancelled','uncertain','expired'].includes(execution.state))throw Error('Actual reader terminal state '+JSON.stringify(execution))
        if(Date.now()>=deadline)throw Error('Actual reader approvals timed out: '+JSON.stringify(report));await sleep(100)
      }
    }
    const completed=await grantAll(executor,original.id)
    expect(completed.granted).toHaveLength(5);expect(completed.report.callCount).toBe(2)
    expect(completed.report.permissions.filter((row:any)=>row.body.trigger===original.id).every((row:any)=>row.phase==='consumed')).toBe(true)
    expect(completed.report.budgets.filter((row:any)=>row.execution===completed.execution.id).map((row:any)=>row.spent)).toEqual([10,10])
    const calls=readFileSync(join(executor.home,'reader-qa-calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)), results=calls[1].toolResults
    expect(calls[0].tools).toEqual(['safe_read','safe_list','safe_search']);expect(calls.every((call:any)=>call.systemPrompt==='Use only the supplied reader compartment and enumerated safe tools.')).toBe(true)
    expect(results).toHaveLength(9);expect(results.slice(0,3).every((row:any)=>!row.isError)).toBe(true);expect(results.slice(3).every((row:any)=>row.isError)).toBe(true)
    expect(JSON.stringify(calls)).toContain('SAFE_READER_MARKER');expect(JSON.stringify(calls)).not.toContain('QA_PRIVATE_DENIED_MARKER');expect(existsSync(join(qa.project,'mutated.txt'))).toBe(false)
    expect(host.report().callCount).toBe(0);expect(sender.report().callCount).toBe(0)
    expect(executor.report().channels[0].members.find((row:any)=>row.user===sender.report().self.user).globallyPinned).toBe(false)
    await wait(()=>currentPresence(sender,bot)==='idle'?true:undefined,'original signed idle presence')
    const beforeCounter=sender.report().counters.find((row:any)=>row.bot===bot).counter, killedAt=Date.now()
    await kill(executor.child)
    const old=await command(sender.home,['spaces','post',space.channel,'Expired original Host receipt','--mentions',bot]), oldTail=await command(host.home,['spaces','tail',space.channel])
    const oldRecord=oldTail.records.find((row:any)=>row.envelope.id===old.id);expect(oldRecord).toBeDefined()
    await wait(()=>currentPresence(sender,bot)==='reconnecting'?true:undefined,'real45s signed evidence disappearance',55000)
    transcript.push({gate:'reconnecting',elapsed:Date.now()-killedAt,counter:sender.report().counters.find((row:any)=>row.bot===bot).counter})
    await wait(()=>currentPresence(sender,bot)==='offline'?true:undefined,'real90s signed evidence disappearance',55000)
    expect(sender.report().counters.find((row:any)=>row.bot===bot).counter).toBe(beforeCounter)
    transcript.push({gate:'offline',elapsed:Date.now()-killedAt,originalHostReceipt:oldRecord.recvTs})
    const fresh=await command(sender.home,['spaces','post',space.channel,'Fresh original Host receipt','--mentions',bot]), resumed=await qa.start('executor')
    const freshTail=await command(host.home,['spaces','tail',space.channel]),freshRecord=freshTail.records.find((row:any)=>row.envelope.id===fresh.id)
    expect(freshRecord).toBeDefined()
    await command(resumed.home,['net','unlock'],'fixed-reader-owned-protection')
    const freshCompletion=await grantAll(resumed,fresh.id)
    expect(Date.now()-oldRecord.recvTs).toBeGreaterThan(30000)
    const expired=await wait(()=>resumed.report()?.executions.find((row:any)=>(row.key?.trigger===old.id||row.trigger===old.id)&&row.state==='expired'),'old receipt durable expiry')
    expect(freshCompletion.execution.startedAt-freshRecord.recvTs).toBeGreaterThanOrEqual(0)
    expect(freshCompletion.execution.startedAt-freshRecord.recvTs).toBeLessThanOrEqual(30000)
    const markerDeadline=Date.now()+10000
    let expiredMarkers:any[]=[]
    while(Date.now()<markerDeadline){const tail=await command(host.home,['spaces','tail',space.channel]);expiredMarkers=tail.records.filter((row:any)=>row.envelope.type==='bot.run.expired'&&row.envelope.refs?.subject===old.id);if(expiredMarkers.length)break;await sleep(100)}
    expect(expiredMarkers).toHaveLength(1);expect(expiredMarkers[0].envelope.author.bot).toBe(bot);expect(expiredMarkers[0].envelope.refs.execution).toBe(expired.id)
    expect(resumed.report().callCount).toBe(2)
    expect(resumed.report().executions.filter((row:any)=>row.key?.trigger===original.id||row.trigger===original.id)).toHaveLength(1)
    expect(resumed.report().executions.filter((row:any)=>row.key?.trigger===fresh.id||row.trigger===fresh.id)).toHaveLength(1)
    await wait(()=>sender.report()?.counters.find((row:any)=>row.bot===bot)?.counter>beforeCounter?true:undefined,'restart original signing-key counter increase')
    transcript.push({gate:'restart',expired,expiredMarker:expiredMarkers[0],fresh:freshCompletion.execution,freshHostReceipt:freshRecord.recvTs,original:completed.execution,counter:sender.report().counters.find((row:any)=>row.bot===bot).counter})
    for(const owner of [host,resumed,sender]){expect(owner.report().protected).toBe(true);expect(owner.report().paidProviderQualified).toBe(false)}
    qualified=true
  }finally{
    const reports=['host','executor','sender'].map(role=>({role,report:read(join(qa.root,role)),calls:existsSync(join(qa.root,role,'reader-qa-calls.jsonl'))?readFileSync(join(qa.root,role,'reader-qa-calls.jsonl'),'utf8'):''}))
    writeFileSync(artifact,JSON.stringify({v:1,qualified,paidProviderQualified:false,platform:process.platform,node:process.versions.node,emittedHashes:{cli:createHash('sha256').update(readFileSync(cliEntry)).digest('hex'),owner:createHash('sha256').update(readFileSync(entry)).digest('hex')},transcript,reports,ownerLogs:qa.ownerLogs},null,2),{mode:0o600});process.stdout.write(`Reader actual qualification evidence: ${artifact}\n`);await qa.close()
  }
},300000)

it.skipIf(!['darwin','linux'].includes(process.platform))('reconsiders original Host receipts with an actual fresh clock after a protected reader owner restart',async()=>{
  const qa=harness(),artifact=join(tmpdir(),`mousse-reader-restart-${process.pid}-${Date.now()}.json`)
  const command=async(home:string,args:string[],input?:string)=>{const result=await qa.cli(home,args,input);expect(result.code,result.error).toBe(0);return result.value}
  let old:any,fresh:any,hostReceipts:any
  try {
    const host=await qa.start('host'),executor=await qa.start('executor'),sender=await qa.start('sender')
    for(const owner of [host,executor,sender]){await command(owner.home,['net','init','--listen','--port','0']);await command(owner.home,['net','protect'],'fixed-reader-owned-protection')}
    const space=await command(host.home,['spaces','create','Restart real clock'])
    for(const owner of [executor,sender]){const invite=await command(host.home,['spaces','invite',space.space]);await command(owner.home,['spaces','join'],invite.invite);await command(owner.home,['spaces','tail',space.channel])}
    const addArgs=['bots','add',space.space,'Restart reader','--id',newId('rpc'),'--profile-kind','reader','--steer','everyone']
    let added=await command(executor.home,addArgs);const end=Date.now()+15000
    while(added.state==='unknown'&&added.delivery?.state==='sent'&&Date.now()<end){await sleep(100);added=await command(executor.home,addArgs)}
    expect(added.state).toBe('registered')
    await wait(()=>executor.report()?.channels.some((channel:any)=>channel.clock)?true:undefined,'initial actual Host clock')
    const definition=executor.report(),bot=added.bot
    await command(executor.home,['bots','configure',space.space,bot,'--adapter','mousse','--profile-kind','reader','--definition-revision',definition.definitionRevision,'--profile-digest',definition.profileDigest,'--project-id',definition.projectId,'--daily-budget','1000','--run-ceiling','100','--max-concurrent','1','--runs-per-member-hour','20'])
    await command(executor.home,['bots','qualify',space.space,bot,'--definition-revision',definition.definitionRevision,'--profile-digest',definition.profileDigest])
    await kill(executor.child)
    old=await command(sender.home,['spaces','post',space.channel,'Old signed original','--mentions',bot]);expect(old.state).toBe('sent')
    await sleep(31000)
    fresh=await command(sender.home,['spaces','post',space.channel,'Fresh signed original','--mentions',bot]);expect(fresh.state).toBe('sent')
    const hostTail=await command(host.home,['spaces','tail',space.channel])
    hostReceipts={old:hostTail.records.find((row:any)=>row.envelope.id===old.id),fresh:hostTail.records.find((row:any)=>row.envelope.id===fresh.id)}
    expect(hostReceipts.old).toBeDefined();expect(hostReceipts.fresh).toBeDefined()
    const restarted=await qa.start('executor');await command(restarted.home,['net','unlock'],'fixed-reader-owned-protection')
    await wait(()=>{
      const report=restarted.report(),errors=report?.admissionErrors?.filter((row:any)=>[old.id,fresh.id].includes(row.id))
      if(errors?.length)throw Error('Actual original receipt admission failures: '+JSON.stringify(errors))
      const freshExecution=report?.executions.find((row:any)=>row.trigger===fresh.id),oldExecution=report?.executions.find((row:any)=>row.trigger===old.id)
      return freshExecution?.state==='waitingApproval'&&oldExecution?.state==='expired'?report:undefined
    },'fresh reader admission and old expiry after restart',35000)
    const freshExecution=restarted.report().executions.find((row:any)=>row.trigger===fresh.id),oldExecution=restarted.report().executions.find((row:any)=>row.trigger===old.id)
    expect(oldExecution.startedAt-hostReceipts.old.recvTs).toBeGreaterThan(30000)
    expect(freshExecution.startedAt-hostReceipts.fresh.recvTs).toBeGreaterThanOrEqual(0)
    expect(freshExecution.startedAt-hostReceipts.fresh.recvTs).toBeLessThanOrEqual(30000)
    expect(restarted.report().callCount).toBe(1)
    await wait(()=>sender.report()?.counters.some((row:any)=>row.bot===bot)?true:undefined,'original signed working counter after restart')
    await wait(()=>sender.report()?.presence.some((row:any)=>row.bot===bot&&row.view.state==='working')?true:undefined,'receiver working display after accepted restart packet',10000)
    const displayUntil=Date.now()+3000
    while(Date.now()<displayUntil){expect(sender.report()?.presence.find((row:any)=>row.bot===bot)?.view.state,'actual accepted restarted packet display').toBe('working');await sleep(100)}
    await command(restarted.home,['bots','stop',space.space,bot])
  }finally{writeFileSync(artifact,JSON.stringify({v:1,paidProviderQualified:false,old,fresh,hostReceipts,reports:['host','executor','sender'].map(role=>({role,report:read(join(qa.root,role))}))},null,2),{mode:0o600});process.stdout.write(`Reader restart evidence: ${artifact}\n`);await qa.close()}
},150000)
