import {spawn,type ChildProcess} from 'node:child_process'
import {mkdtempSync,readFileSync,realpathSync,rmSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {build} from 'esbuild'
import {expect,it} from 'vitest'
import {MousseMainService} from '../../../../src/mms/MousseMainService'
import {FileKeyStore} from '../../../../src/mms/net/identity'
import {decodeEnvelope} from '../../../../src/mms/net/sync/codec'
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited}
it.skipIf(process.platform==='win32')('moves a public/private Space through two emitted daemons, physical prepared-bundle death, route refresh and exact-original activation',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'archive-daemons-'))),homes=[join(root,'source'),join(root,'target')],children:ChildProcess[]=[],entry=resolve('out/cli/index.js'),faultEntry=resolve('out/cli/archive-qa.js'),passphrases=['archive-source-protected','archive-target-protected']
  for(const home of homes)mkdirSync(home)
  const {getCliBuildOptions}=await import(new URL('../../../../scripts/build-cli.mjs',import.meta.url).href)
  const options=getCliBuildOptions();await build(options);await build({...options,entryPoints:[resolve('tests/net/spaces/archive/daemon-entry.ts')],outfile:faultEntry})
  let logs='',seed:MousseMainService|undefined,probe:MousseMainService|undefined
  const profile=(home:string)=>join(home,'profiles',JSON.parse(readFileSync(join(home,'installation.json'),'utf8')).defaultProfileId)
  const read=<T>(home:string,work:(db:DatabaseSync)=>T):T=>{const db=new DatabaseSync(join(profile(home),'net/net.db'),{readOnly:true});try{return work(db)}finally{db.close()}}
  const until=async(work:()=>Promise<boolean>|boolean,timeout=30000)=>{const deadline=Date.now()+timeout;while(!await work()){if(Date.now()>=deadline)throw Error('Task-owned archive daemon condition timed out');await new Promise(resolve=>setTimeout(resolve,25))}}
  const cli=(home:string,args:string[],input?:string)=>new Promise<{code:number|null;value:any;out:string;error:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,'--home',home,'--json',...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,NO_COLOR:'1'}});children.push(child)
    let out='',error='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Archive emitted CLI timed out'))},40000)
    child.stdout!.on('data',bytes=>{out+=bytes});child.stderr!.on('data',bytes=>{error+=bytes});child.on('error',reason=>{clearTimeout(timer);reject(reason)})
    child.on('exit',code=>{clearTimeout(timer);let value;try{value=JSON.parse(code===0?out:error)}catch{}resolve({code,value,out,error})});child.stdin!.end(input)
  })
  const ok=async(home:string,args:string[],input?:string)=>{const result=await cli(home,args,input);expect(result.code,args.join(' ')+'\n'+result.error+'\n'+logs).toBe(0);return result.value}
  const launch=async(home:string,fault=false)=>{
    const child=spawn(process.execPath,[fault?faultEntry:entry,'--home',home,'service','run'],{stdio:['ignore','pipe','pipe'],env:{...process.env,MOUSSE_HOME:home,NO_COLOR:'1',...(fault?{MOUSSE_ARCHIVE_QA_ROOT:root,MOUSSE_ARCHIVE_QA_FAULT:'spaces.archive.private.bundleDurable'}:{})}});children.push(child)
    child.stdout!.on('data',bytes=>{logs=(logs+bytes).slice(-16000)});child.stderr!.on('data',bytes=>{logs=(logs+bytes).slice(-16000)})
    await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('Task-owned archive daemon exited: '+logs);try{return JSON.parse(readFileSync(join(home,'mms.runtime.json'),'utf8')).pid===child.pid}catch{return false}},40000)
    return child
  }
  try{
    seed=await MousseMainService.create({homeDir:homes[0],repoRoot:root,headless:true,requireOwnership:false})
    await seed.net.request('net.init',{listen:true,port:0});await seed.net.request('net.protect',{passphrase:passphrases[0]})
    const rt=seed.net.runtime(),self=rt.identity.self()!,space=seed.spaces.host.create({name:'Actual emitted archive move'}),channel=seed.spaces.host.createChannel(space.space,'general'),publicPost=seed.spaces.client.post(channel,'Original emitted public history');await seed.spaces.flush(space.space)
    const creation=seed.spaces.private.prepareCreation(space.space,channel,[self.user]);await seed.spaces.private.publishCreation(creation.descriptor.id)
    const privateStream=creation.descriptor.id,control=seed.spaces.private.state(privateStream)!.control,oldKeyHash=hash(rt.keys.getSecret(`private/${privateStream}/1`)!),sealed=seed.spaces.private.seal(privateStream,'message.posted',{text:'Private old plaintext must never export'});await seed.spaces.append(privateStream,sealed.id,sealed.envelope,sealed.sig)
    const original=seed.spaces.store.getById(privateStream,sealed.id)!;await seed.stop();seed=undefined
    const source=await launch(homes[0]);let target=await launch(homes[1])
    await ok(homes[0],['net','unlock'],passphrases[0]);expect((await cli(homes[0],['spaces','--help'])).out).toContain('spaces export')
    const invite=await ok(homes[0],['bridge','invite']),joined=await ok(homes[1],['bridge','join'],invite.invite)
    await ok(homes[1],['net','protect'],passphrases[1]);await ok(homes[1],['net','init','--listen','--port','0'])
    await until(async()=>{const status=await ok(homes[0],['net','status']);return status.peers.some((peer:any)=>peer.node===joined.node&&peer.state==='open')})
    await ok(homes[0],['spaces','freeze',space.space,'Actual two-daemon quiesced move'])
    const directory=join(root,'space-archive'),exported=await ok(homes[0],['spaces','export',space.space,directory]);expect(exported.state).toBe('exported')
    expect(readFileSync(join(directory,'space.db')).includes(Buffer.from('Private old plaintext must never export'))).toBe(false)
    expect((await cli(homes[1],['spaces','import',directory])).value).toMatchObject({code:'forbidden'})
    expect((await ok(homes[0],['spaces','retire',space.space])).state).toBe('retired');expect(read(homes[0],db=>db.prepare('SELECT count(*) AS n FROM net_streams WHERE space_id=?').get(space.space)!.n)).toBe(0)
    expect((await ok(homes[0],['net','authority','transfer',joined.node])).phase).toBe('activated')
    await stop(source);await stop(target);target=await launch(homes[1],true);await ok(homes[1],['net','unlock'],passphrases[1])
    const imported=await ok(homes[1],['spaces','import',directory,'--archive-mode','move']);expect(imported.state).toBe('importedFrozen')
    expect(read(homes[1],db=>db.prepare('SELECT count(*) AS n FROM net_streams WHERE space_id=? AND id NOT IN (SELECT stream FROM net_space_archive_hidden)').get(space.space)!.n)).toBe(0)
    expect(read(homes[1],db=>db.prepare('SELECT count(*) AS n FROM net_space_archive_hidden WHERE operation=?').get(imported.operation)!.n)).toBe(3)
    const crashed=await cli(homes[1],['spaces','activate',space.space]);expect(crashed.code).not.toBe(0);await until(()=>target.signalCode==='SIGKILL')
    expect(JSON.parse(readFileSync(join(root,'physical-fault.json'),'utf8'))).toEqual({point:'spaces.archive.private.bundleDurable'})
    expect(read(homes[1],db=>JSON.parse(db.prepare('SELECT value FROM net_space_archive_operations WHERE id=?').get(imported.operation)!.value as string).state)).toBe('importedFrozen')
    const keys=new FileKeyStore(profile(homes[1]));await keys.unlock(passphrases[1]);expect(keys.getSecret(`private/${privateStream}/1`)).toBeUndefined()
    const prepared=JSON.parse(keys.getSecret(`archive/rotation/${imported.operation}/${privateStream}/2`)!.toString()),preparedKeyHash=hash(Buffer.from(prepared.key,'base64url'));expect(preparedKeyHash).not.toBe(oldKeyHash)
    target=await launch(homes[1]);expect((await cli(homes[1],['spaces','activate',space.space])).value).toMatchObject({code:'keystore_locked'});await ok(homes[1],['net','unlock'],passphrases[1])
    expect((await ok(homes[1],['spaces','archive-status',space.space])).operation.state).toBe('importedFrozen')
    const active=await ok(homes[1],['spaces','activate',space.space]);expect(active).toMatchObject({state:'activeNew',epoch:2});expect(await ok(homes[1],['spaces','activate',space.space])).toEqual(active)
    const stored=read(homes[1],db=>db.prepare('SELECT envelope,sig,epoch,seq FROM net_records WHERE id=?').get(decodeEnvelope(Buffer.from(prepared.original.envelope,'base64url')).envelope.id)!)
    expect(stored).toMatchObject({epoch:2,seq:1});expect(Buffer.from(stored.envelope as Uint8Array).toString('base64url')).toBe(prepared.original.envelope);expect(Buffer.from(stored.sig as Uint8Array).toString('base64url')).toBe(prepared.original.sig)
    expect(prepared.body.writers.every((writer:any)=>control.writers.every(old=>old.noncePrefix!==writer.noncePrefix))).toBe(true)
    expect((await ok(homes[1],['spaces','post',channel,'After emitted move'])).position).toEqual({epoch:2,seq:1})
    await stop(target)
    probe=await MousseMainService.create({homeDir:homes[1],repoRoot:root,headless:true,requireOwnership:false});await probe.net.request('net.unlock',{passphrase:passphrases[1]})
    expect(probe.spaces.store.getById(channel,publicPost)).toBeDefined();expect(probe.spaces.store.getById(privateStream,sealed.id)).toEqual(original)
    expect(hash(probe.net.runtime().keys.getSecret(`private/${privateStream}/2`)!)).toBe(preparedKeyHash)
    const fresh=probe.spaces.private.seal(privateStream,'message.posted',{text:'Fresh private capability after daemon restart'});await probe.spaces.append(privateStream,fresh.id,fresh.envelope,fresh.sig)
    expect(probe.spaces.private.open(privateStream,probe.spaces.store.getById(privateStream,fresh.id)!)).toEqual({text:'Fresh private capability after daemon restart'})
    expect(decodeEnvelope(fresh.envelope).envelope.sealed).toMatchObject({keyEpoch:2})
    await probe.bridge.archives.request('spaces.archive.freeze',{space:space.space,reason:'Re-export moved private history'})
    const reexport=join(root,'moved-reexport')
    await probe.bridge.archives.request('spaces.archive.export',{space:space.space,path:reexport})
    await probe.bridge.archives.request('spaces.archive.import',{path:reexport,mode:'restore'})
    expect(await probe.bridge.archives.request('spaces.archive.activate',{space:space.space})).toMatchObject({state:'activeNew',epoch:3})
    expect(probe.spaces.store.getById(privateStream,sealed.id)).toEqual(original)
    expect(probe.spaces.store.getById(privateStream,fresh.id)!.envelope).toEqual(fresh.envelope)
    const newest=probe.spaces.private.state(privateStream)!.control
    expect(newest.keyEpoch).toBe(3);expect(newest.writers.every(writer=>[...control.writers,...prepared.body.writers].every(old=>old.noncePrefix!==writer.noncePrefix))).toBe(true)
    expect(hash(probe.net.runtime().keys.getSecret(`private/${privateStream}/3`)!)).not.toBe(preparedKeyHash)
    await probe.stop();probe=undefined;target=await launch(homes[1]);await ok(homes[1],['net','unlock'],passphrases[1]);expect((await ok(homes[1],['spaces','archive-status',space.space])).operation).toMatchObject({state:'activeNew',epoch:3})
    expect(logs).not.toContain(passphrases[0]);expect(logs).not.toContain(passphrases[1]);expect(logs).not.toContain('Private old plaintext must never export')
  }finally{if(seed)await seed.stop();if(probe)await probe.stop();await Promise.all(children.map(stop));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
},150000)
