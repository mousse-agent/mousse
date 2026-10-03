import { createServer } from 'node:net'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { FileKeyStore,NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { DurableRpcDispatcher } from '../../../../src/mms/net/sync/rpcDispatcher'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel'
import { systemClock } from '../../../../src/mms/net/clock'
import { MmsRemoteBackend,RemoteApi } from '../../../../src/mms/bridge/remote'
async function main(){
  const mms=await MousseMainService.create({homeDir:process.argv[2],headless:true,ownerKind:'test'});await mms.start()
  const db=new NetDatabase({profileDir:mms.getProfileHomeDir()}),keys=new FileKeyStore(mms.getProfileHomeDir()),identity=new NetIdentityService({database:db.database,keys,clock:systemClock,coordinator:db}),store=new SqliteStreamStore(db),executions=new SqliteExecutionLedger(db)
  const dispatcher=new DurableRpcDispatcher({db,executions,identity,clock:systemClock}),actual=new MmsRemoteBackend(mms),api=new RemoteApi({snapshot:id=>actual.snapshot(id),run:(...args)=>actual.run(...args),execute:async(method,params)=>{const result=await actual.execute(method,params);if(method==='threads.create')process.kill(process.pid,'SIGKILL');return result}},systemClock)
  api.register(dispatcher)
  const server=createServer(raw=>{void openSecureChannel(raw,{role:'server',credentials:keys.tlsCredentials(),deadlineMs:2000}).then(channel=>{new NetSyncSession({channel,identity,store,rpc:dispatcher})}).catch(()=>raw.destroy())})
  server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener.');process.stdout.write(JSON.stringify({port:address.port})+'\n')})
}
void main().catch(error=>{console.error(error);process.exit(1)})
