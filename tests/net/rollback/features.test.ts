import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { newId, type NodeDelegation, type Roster } from '../../../src/shared/net'
import { MousseMainService } from '../../../src/mms/MousseMainService'
it.each(['netBridge', 'netSpaces'] as const)('binds the persisted %s flag to actual domain admission without changing installation features', async feature => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'net-flags-'))), home=join(root,'home')
  let main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
  try {
    await main.net.request('net.init',{listen:true});await main.net.request('net.protect',{passphrase:'owned-domain-flags'})
    const rt=main.net.runtime(), config=JSON.parse(rt.db.database.prepare('SELECT value FROM net_service_config').get()!.value as string), originalFlags=main.config.get().features
    config.features[feature]=false
    rt.db.transaction(()=>{rt.db.charge(1);rt.db.database.prepare('UPDATE net_service_config SET value=?').run(JSON.stringify(config))})
    await main.stop()
    main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
    await main.net.request('net.unlock',{passphrase:'owned-domain-flags'})
    expect(main.net.status()).toMatchObject({enabled:true,features:config.features})
    if(feature==='netBridge') {
      expect(()=>main.bridge).toThrow(expect.objectContaining({code:'cancelled'}))
      expect(await main.spaces.local.request('spaces.create',{name:'Spaces still opted in'})).toHaveProperty('channel')
      const live=main.net.runtime(),self=live.identity.self()!,rootKey=live.keys.rootKey()!,roster=live.identity.verifySigned<Roster>(live.identity.roster()!,rootKey)
      const delegation=roster.nodes.map(signed=>live.identity.verifySigned<NodeDelegation>(signed,rootKey)).find(row=>row.subject===self.node)!
      const peer={user:self.user,node:self.node,delegation}
      // The real registered admission guard executes before any durable alias/execution.
      await expect(live.rpc.dispatch('threads.list',{},undefined,{id:newId('rpc'),caller:peer,signal:new AbortController().signal,deadlineAt:Date.now()+1000,progress:()=>{}})).rejects.toMatchObject({code:'cancelled'})
      expect(main.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases').get()!.n).toBe(0)
    } else {
      expect(main.bridge.hub).toBeDefined()
      expect(()=>main.spaces).toThrow(expect.objectContaining({code:'cancelled'}))
      expect(()=>main.bots).toThrow(expect.objectContaining({code:'cancelled'}))
      expect(()=>main.chatNetwork.publish({chatId:'invalid',publicationId:'test'} as any)).toThrow(expect.objectContaining({code:'cancelled'}))
    }
    expect(main.config.get().features).toEqual(originalFlags)
  } finally {await main.stop();rmSync(root,{recursive:true,force:true})}
},15000)
