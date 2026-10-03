import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../../src/mms/spaces/SpaceProfileService'
import { SpaceCurrentIdentity } from '../../../../src/mms/spaces/SpaceCurrentIdentity'
export const cleanup:Array<()=>void|Promise<void>>=[]
export function profile(clock=systemClock){
 const path=mkdtempSync(join(tmpdir(),'space-discovery-'));let spaces!:SpaceProfileService,current!:SpaceCurrentIdentity
 const net=new NetService({profileDir:path,clock,composeRuntime:runtime=>{spaces=new SpaceProfileService({runtime,net,clock});current=new SpaceCurrentIdentity({runtime,store:spaces.store,meta:spaces.meta,host:spaces.host,session:space=>spaces.session(space)});spaces.options.spaceIdentity=current.source;return spaces.composition(new NodeStreamAuthority(runtime.identity,spaces.store,runtime.blobs,systemClock))}})
 cleanup.push(()=>rmSync(path,{recursive:true,force:true}),()=>net.shutdown());return{net,get spaces(){return spaces},get current(){return current}}
}
