import {spawn} from 'node:child_process'
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'
import {build} from 'esbuild'
import electron from 'electron'
import {expect,it,vi} from 'vitest'
import {MousseMainService} from '../../../src/mms/MousseMainService'
import {encodeFrame} from '../../../src/mms/protocol/framing'
import {MmsProtocolServer} from '../../../src/mms/protocol/server'

it('delivers genuine multipart same-user Bridge snapshots and events only to its owning preload window',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gui-bridge-display-'))),home=join(root,'home'),main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,ownerKind:'test'})
  const host=main.getInstallationHost()!,ids=[host.getDefaultProfileId(),host.manager.create({displayName:'Foreign',slug:'foreign'}).id,host.manager.create({displayName:'Device',slug:'device'}).id],services=await Promise.all(ids.map(id=>main.getProfileServices(id))),device=services[2],message='GUI_BRIDGE_DISPLAY_FIXTURE_'.repeat(110000),calls=vi.spyOn(main.providerAuth.models,'streamSimple')
  await main.start();const server=new MmsProtocolServer({mms:main,ownerToken:main.getOwnerLease()!.owner.token,version:'gui-bridge-display-fixture'}),endpoint=await server.start()
  const concrete=server as unknown as {sendRaw(session:unknown,message:any):boolean;emitConnectionEvent(...args:any[]):Promise<void>},send=concrete.sendRaw.bind(server)
  let seeded=false,emitted=0,captured:any,staleInjected=false
  const replayTrigger=join(root,'replay-stale'),replayDone=join(root,'replay-done')
  const seed=vi.spyOn(concrete,'sendRaw').mockImplementation((session,result)=>{if(!seeded&&result.kind==='res'&&result.ok&&result.result?.thread?.name==='GUI remote original thread'){seeded=true;const id=result.result.thread.id;device.threads.mutateThreadData(id,()=>({messages:[{id:'actual-owned-display',role:'assistant',content:message,timestamp:new Date().toISOString()}]}));device.orchestrator.getOrCreateSession(id).messages=device.threads.loadThreadData(id).messages}return send(session,result)})
  const emit=concrete.emitConnectionEvent.bind(server),frames=vi.spyOn(concrete,'emitConnectionEvent').mockImplementation((...args)=>{emitted++;if(!captured)captured={session:args[0],binding:{...args[1]},type:args[3],data:args[4]};return emit(...args)})
  const staleTimer=setInterval(()=>{if(!staleInjected&&captured&&existsSync(replayTrigger)){const {session,binding,type,data}=captured;if(session.binding.profileId!==binding.profileId||session.binding.epoch===binding.epoch)throw new Error('A→B→A stale replay setup did not change actual binding epoch');session.socket.write(encodeFrame({kind:'connection_event',type,profileId:binding.profileId,profileEpoch:binding.epoch,data}));staleInjected=true;writeFileSync(replayDone,'done')}},20)
  try{
    const mainBundle=join(root,'electron-main.cjs'),preload=join(root,'preload.cjs'),evidence=join(root,'evidence.json'),config=join(root,'config.json'),renderer=join(root,'renderer.js'),html=join(root,'renderer.html');writeFileSync(html,'<!doctype html><html>Actual owned Bridge preload renderer</html>');symlinkSync(resolve('node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir')
    await build({entryPoints:[resolve('tests/fixtures/repository-upgrades/electron-bridge-display.ts')],outfile:mainBundle,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'})
    await build({entryPoints:[resolve('src/preload/index.ts')],outfile:preload,bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'})
    await build({entryPoints:[resolve('tests/fixtures/repository-upgrades/electron-bridge-display-renderer.ts')],outfile:renderer,bundle:true,platform:'browser',format:'iife',logLevel:'silent'})
    writeFileSync(config,JSON.stringify({html,renderer,replayTrigger,replayDone,home,endpoint,ownerToken:main.getOwnerLease()!.owner.token,preload,evidence,userData:join(root,'electron-data'),profiles:ids,passphrase:randomBytes(32).toString('base64url'),message}),{mode:0o600})
    const env={...process.env,MOUSSE_GUI_BRIDGE_CONFIG:config,MOUSSE_HOME:home};delete env.ELECTRON_RUN_AS_NODE
    const result=await new Promise<{code:number|null;stderr:string}>((done,reject)=>{const child=spawn(electron as unknown as string,[mainBundle],{cwd:process.cwd(),env,stdio:['ignore','ignore','pipe']});let stderr='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},50000);child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000)});child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',code=>{clearTimeout(timer);if(timedOut)reject(new Error('Actual GUI Bridge fixture timed out'));else done({code,stderr})})})
    const observed=JSON.parse(readFileSync(evidence,'utf8'))
    if(process.env.MOUSSE_GUI_BRIDGE_EVIDENCE_OUT)writeFileSync(process.env.MOUSSE_GUI_BRIDGE_EVIDENCE_OUT,JSON.stringify({...observed,serverConnectionParts:emitted,exitCode:result.code}),{mode:0o600,flag:'wx'})
    expect(seeded).toBe(true);expect(emitted).toBeGreaterThan(3)
    expect(result.code,JSON.stringify(observed)+'\n'+result.stderr).toBe(0)
    expect(observed).toMatchObject({ok:true,api:true,contentMatched:true,renamed:true,foreignParts:0,partsAfterDispose:0,staleParts:0,decoderErrors:[],partialViews:0,views:1})
    expect(observed.snapshotBytes).toBeGreaterThan(2.5*1024*1024);expect(observed.parts).toBeGreaterThan(80);expect(staleInjected).toBe(true);expect(calls).not.toHaveBeenCalled()
    for(const profile of services){const db=profile.net.runtime().db.database;expect(db.prepare('SELECT target,state FROM net_executions ORDER BY id').all()).toEqual(profile===device?[{target:'bridge.thread.open',state:'completed'}]:[]);expect(db.prepare('SELECT count(*) AS n FROM net_budget_reservations').get()!.n).toBe(0);expect(profile.bots.list()).toEqual([]);expect(profile.bots.activeCount()).toBe(0)}
  }finally{clearInterval(staleTimer);seed.mockRestore();frames.mockRestore();calls.mockRestore();await server.stop();await main.stop();rmSync(root,{recursive:true,force:true})}
},65000)
