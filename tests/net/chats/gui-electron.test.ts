import {spawn} from 'node:child_process'
import {mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'
import {build} from 'esbuild'
import electron from 'electron'
import {expect,it,vi} from 'vitest'
import {MousseMainService} from '../../../src/mms/MousseMainService'
import {MmsProtocolServer} from '../../../src/mms/protocol/server'
import {StaticAgentIntegrationLookup} from '../../../src/mms/agentDefinitions/lookups'
import {defaultAgentSettings} from '../../../src/shared/agents/defaults'

it('routes production preload Net and published/joined Chats through real window-bound MMS with exact originals and profile isolation',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'gui-net-chats-'))),home=join(root,'home'),main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,ownerKind:'test'})
  const manager=main.getInstallationHost()!,ownerId=manager.getDefaultProfileId(),memberId=manager.manager.create({displayName:'GUI member',slug:'gui-member'}).id,owner=await main.getProfileServices(ownerId),member=await main.getProfileServices(memberId)
  const settings=defaultAgentSettings({name:'Local GUI fixture agent',slug:'local-gui-agent'})
  settings.memory.scope='off';settings.recovery.retryCount=0
  const draft=owner.platform.agentDefinitions.createDraft({settings,systemPrompt:'GUI LOCAL ONLY PROMPT CANARY'})
  owner.platform.agentDefinitions.publish(draft.id,draft.draftHash,{integrationLookup:new StaticAgentIntegrationLookup({builtinToolIds:['read','write']})})
  const ownerRun=vi.spyOn(owner.orchestrator,'runAgentDefinition'),memberRun=vi.spyOn(member.orchestrator,'runAgentDefinition'),modelCalls=vi.spyOn(main.providerAuth.models,'streamSimple'),passphrase=randomBytes(32).toString('base64url')
  await main.start()
  const server=new MmsProtocolServer({mms:main,ownerToken:main.getOwnerLease()!.owner.token,version:'gui-net-chats-fixture'}),endpoint=await server.start()
  let dropped=false
  const concrete=server as unknown as {sendRaw(session:{socket:{destroy():void}},message:any):boolean},send=concrete.sendRaw.bind(server),fault=vi.spyOn(concrete,'sendRaw').mockImplementation((session,message)=>{
    if(!dropped&&message.kind==='res'&&message.ok&&message.result?.publicationId==='gui-original-publication'){dropped=true;session.socket.destroy();return false}
    return send(session,message)
  })
  try{
    const mainBundle=join(root,'electron-main.cjs'),preload=join(root,'preload.cjs'),evidence=join(root,'evidence.json'),config=join(root,'config.json')
    symlinkSync(resolve('node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir')
    await build({entryPoints:[resolve('tests/fixtures/repository-upgrades/electron-net-chats-bridge.ts')],outfile:mainBundle,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'})
    await build({entryPoints:[resolve('src/preload/index.ts')],outfile:preload,bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'})
    writeFileSync(config,JSON.stringify({home,endpoint,ownerToken:main.getOwnerLease()!.owner.token,preload,evidence,userData:join(root,'electron-data'),ownerProfile:ownerId,memberProfile:memberId,ownerProfileHome:owner.getProfileHomeDir(),memberProfileHome:member.getProfileHomeDir(),agentId:draft.id,passphrase}),{mode:0o600})
    const env={...process.env,MOUSSE_GUI_NET_CONFIG:config,MOUSSE_HOME:home};delete env.ELECTRON_RUN_AS_NODE
    const result=await new Promise<{code:number|null;stderr:string}>((done,reject)=>{
      const child=spawn(electron as unknown as string,[mainBundle],{cwd:process.cwd(),env,stdio:['ignore','ignore','pipe']});let stderr='',timedOut=false
      const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},65000)
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000)})
      child.once('error',error=>{clearTimeout(timeout);reject(error)})
      child.once('exit',code=>{clearTimeout(timeout);if(timedOut)reject(new Error('Actual GUI Net/Chats fixture timed out: '+stderr));else done({code,stderr})})
    })
    expect(result.code,result.stderr).toBe(0)
    const observed=JSON.parse(readFileSync(evidence,'utf8'))
    expect(observed).toMatchObject({ok:true,exposed:{bridge:true,nodeUnavailable:true,ownerTokenUnavailable:true,legacyControlUnavailable:true},local:{messages:1,unchangedRecord:true},emptyHead:{epoch:1,seq:0},memberBefore:{spaces:[]},memberThreadsBefore:0,memberThreadsAfter:0,memberFilesBefore:[],memberFilesAfter:[],identities:{protected:true}})
    expect(dropped).toBe(true);expect(typeof observed.lostReply).toBe('string');expect(observed.retry).toEqual(observed.binding)
    expect(observed.binding.localHistory.messageCount).toBe(1);expect(observed.binding.localHistory.lastMessageId).toBe(observed.local.oldId)
    expect(observed.ownerSpaces.spaces.map((space:{space:string})=>space.space)).toContain(observed.standalone.space)
    expect(observed.identities.owner.user).not.toBe(observed.identities.member.user)
    expect(observed.one.delivery).toMatchObject({state:'sent',position:{epoch:1,seq:1}});expect(observed.two.delivery.id).toBe(observed.one.delivery.id)
    expect(observed.joined).toMatchObject({presentation:'network',messages:[],binding:{space:observed.binding.space,channel:observed.binding.channel}})
    expect(observed.joined).not.toHaveProperty('threadId');expect(observed.joined).not.toHaveProperty('projectId');expect(observed.joinedRetryId).toBe(observed.joined.id)
    expect(observed.joinedSent.delivery).toMatchObject({state:'sent',position:{epoch:1,seq:2}});expect(observed.joinedSendRetry.delivery.id).toBe(observed.joinedSent.delivery.id)
    expect(observed.current.records.map((record:any)=>record.envelope.id)).toEqual([observed.one.delivery.id,observed.joinedSent.delivery.id])
    expect(observed.current.records[1].envelope.author).toMatchObject({user:observed.identities.member.user,node:observed.identities.member.node})
    expect(observed.joinedGet.network.records).toEqual(observed.current.records)
    expect(JSON.stringify(observed.current)).not.toMatch(/GUI OLD LOCAL HISTORY CANARY|GUI LOCAL RESOURCE CANARY|GUI LOCAL ONLY PROMPT CANARY/)
    expect(observed.denials).toMatchObject({oldControl:'platform_method_not_allowed',oldPairing:'platform_method_not_allowed',forgedProfile:'profile_mismatch',foreignOwnerGroup:'chat_not_found',foreignPublication:'chat_not_found',foreignJoinedId:'chat_not_found',forgedAuthor:'unknown_field',changedOriginal:'conflict',runtimePath:'unknown_field',unallowlisted:'platform_method_not_allowed'})
    expect(observed.denials.foreignMentions).toBe('forbidden')
    expect(owner.spaces.store.listStreams({space:observed.binding.space,kind:'space.channel'})).toHaveLength(1)
    expect(owner.spaces.store.head(observed.binding.channel)).toEqual({epoch:1,seq:2})
    expect(member.threads.listAllThreads()).toHaveLength(0)
    for(const services of [owner,member]){const db=services.net.runtime().db.database;expect(db.prepare('SELECT count(*) AS n FROM net_blobs').get()!.n).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0);expect(services.bots.list()).toEqual([])}
    expect(owner.spaces.meta.entities(observed.binding.space,'bot')).toHaveLength(0)
    expect(ownerRun).not.toHaveBeenCalled();expect(memberRun).not.toHaveBeenCalled();expect(modelCalls).not.toHaveBeenCalled()
    expect(JSON.stringify(observed)).not.toContain(main.getOwnerLease()!.owner.token);expect(JSON.stringify(observed)).not.toContain(passphrase)
  }finally{fault.mockRestore();ownerRun.mockRestore();memberRun.mockRestore();modelCalls.mockRestore();await server.stop();await main.stop();rmSync(root,{recursive:true,force:true})}
},80000)
