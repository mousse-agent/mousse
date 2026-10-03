#!/usr/bin/env node
// Actual retained production ASAR. No probe main, resolver injection or provider.
import {spawn,execFileSync} from 'node:child_process'
import {createHash,randomBytes} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {lookup} from 'node:dns/promises'
import {DatabaseSync} from 'node:sqlite'
import asar from '@electron/asar'
if(process.platform!=='darwin'||process.env.MOUSSE_NET_QA_OPT_IN!=='1')throw new Error('Actual macOS and MOUSSE_NET_QA_OPT_IN=1 are required')
const args=process.argv.slice(2),options={}
for(let i=0;i<args.length;i+=2){if(!['--app','--run-dir','--fixture-source','--enrollment'].includes(args[i])||!args[i+1])throw new Error('Expected --app, --run-dir and --fixture-source values');options[args[i].slice(2)]=args[i+1]}
if(options.enrollment&&!['direct-transition','cloudflare'].includes(options.enrollment))throw new Error('Invalid enrollment mode')
const enrollment=options.enrollment??'cloudflare'
if(!options.app||!options['run-dir']||!options['fixture-source'])throw new Error('Missing immutable fixture provenance or owned run directory')
const contents=join(realpathSync(options.app),'Contents'),archive=join(contents,'Resources/app.asar'),executable=join(contents,'MacOS/mousse-cli'),sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),metadata=JSON.parse(asar.extractFile(archive,'package.json'))
if(metadata.main!=='out/main/cli.js')throw new Error('Fixture must use the actual production CLI main')
const root=resolve(options['run-dir']);if(existsSync(root))throw new Error('Run directory must be new');mkdirSync(root,{mode:0o700});const runDir=realpathSync(root),homes=['owner','follower','member'].map(name=>join(runDir,name)),passphrase=randomBytes(32).toString('base64url'),children=new Set(),daemons=[],tunnels=[]
if(homes.some(home=>Buffer.byteLength(join(home,'mms.sock'))>90))throw new Error('Use a short owned canonical temporary run path')
const env={...process.env,MOUSSE_REPO_ROOT:runDir,NO_COLOR:'1'};delete env.ELECTRON_RUN_AS_NODE
const electronVersion=execFileSync('/usr/libexec/PlistBuddy',['-c','Print:CFBundleVersion',join(contents,'Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist')],{encoding:'utf8',timeout:5000}).trim()
const report={v:1,gate:'production-cli-asar-cloudflared-quick',status:'starting',enrollment,fixtureSource:options['fixture-source'],fixtureMain:metadata.main,fixtureVersion:metadata.version,asarSha256:sha(archive),executableSha256:sha(executable),mainSha256:createHash('sha256').update(asar.extractFile(archive,metadata.main)).digest('hex'),driverNode:process.version,electronVersion,platform:process.platform,arch:process.arch,systemDns:false,injectedResolver:false,onlyCloudflareRoute:false,paidProviderQualified:false,fullPlatformQualified:false,ownedProcessesStopped:false,ownedTunnelDirectoriesRemoved:false,stage:'fixture'}
const reportPath=join(runDir,'cloudflare-evidence.json'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600})
let interrupted=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true})
function own(child){children.add(child);child.once('exit',()=>children.delete(child));return child}
async function until(fn,ready,timeout=30000){const end=Date.now()+timeout;do{if(interrupted)throw new Error('cancelled');const value=await fn();if(ready(value))return value;await sleep(200)}while(Date.now()<end);throw new Error('deadline_exceeded')}
function frozen(){if(sha(archive)!==report.asarSha256||sha(executable)!==report.executableSha256)throw new Error('fixture_changed')}
async function launch(index){frozen();const child=own(spawn(executable,['--home',homes[index],'service','run'],{cwd:dirname(executable),env:{...env,MOUSSE_HOME:homes[index]},stdio:['ignore','pipe','pipe']}));daemons[index]=child;child.stdout.resume();let stderr=Buffer.alloc(0);child.stderr.on('data',bytes=>{stderr=Buffer.concat([stderr,bytes]).subarray(-65536);writeFileSync(join(runDir,'daemon-'+index+'.log'),stderr,{mode:0o600})});await until(()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error('daemon_exited');try{return JSON.parse(readFileSync(join(homes[index],'mms.runtime.json'))).pid===child.pid}catch{return false}},Boolean,40000)}
async function cli(index,args,input){frozen();return new Promise((resolve,reject)=>{const child=own(spawn(executable,['--home',homes[index],'--json',...args],{cwd:dirname(executable),env:{...env,MOUSSE_HOME:homes[index]},stdio:['pipe','pipe','pipe']}));let out='',error='',done=false;const finish=(cause,value)=>{if(done)return;done=true;clearTimeout(timer);cause?reject(cause):resolve(value)},timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('cli_deadline'))},30000);child.stdout.on('data',bytes=>{out+=bytes;if(Buffer.byteLength(out)>8*1024*1024){child.kill('SIGKILL');finish(new Error('output_too_large'))}});child.stderr.on('data',bytes=>{error=(error+bytes).slice(-4096)});child.once('error',()=>finish(new Error('child_error')));child.once('exit',code=>{if(code!==0){const match=/"code":"([a-z_]+)"/.exec(error);finish(new Error(match?.[1]??'cli_failed'));return}try{finish(null,JSON.parse(out))}catch{finish(new Error('invalid_cli_json'))}});child.stdin.end(input)})}
async function attach(index,node,thread){frozen();return new Promise((resolve,reject)=>{const child=own(spawn(executable,['--home',homes[index],'--json','bridge','attach',node,thread],{cwd:dirname(executable),env:{...env,MOUSSE_HOME:homes[index]},stdio:['ignore','pipe','pipe']}));let out='',view,settled=false;const timer=setTimeout(()=>{child.kill('SIGTERM')},20000);child.stderr.resume();child.stdout.on('data',bytes=>{out+=bytes;if(Buffer.byteLength(out)>8*1024*1024){child.kill('SIGKILL');return}let line;while((line=out.indexOf('\n'))>=0){const text=out.slice(0,line);out=out.slice(line+1);try{const row=JSON.parse(text);if(row.kind==='snapshot'){view=row;child.kill('SIGTERM')}}catch{}}});child.once('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(new Error('attach_error'))}});child.once('exit',code=>{clearTimeout(timer);if(settled)return;settled=true;if(!view||code!==0){reject(new Error('attach_snapshot_failed'));return}resolve(view)})})}
function captureTunnels(){const lines=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');for(const line of lines){const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);if(!match||!daemons.some(child=>child.pid===Number(match[2]))||!match[3].includes('cloudflared'))continue;const config=/--config\s+(\S+)/.exec(match[3]);if(!config||!config[1].startsWith(runDir+'/'))throw new Error('unowned_tunnel');if(!tunnels.some(t=>t.pid===Number(match[1])))tunnels.push({pid:Number(match[1]),directory:dirname(config[1]),startIdentity:execFileSync('/bin/ps',['-o','lstart=','-p',match[1]],{encoding:'utf8',timeout:5000}).trim(),command:match[3]})}if(!tunnels.length)throw new Error('tunnel_not_observed');writeFileSync(join(runDir,'owned-tunnels.json'),JSON.stringify(tunnels,null,2)+'\n',{mode:0o600})}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const started=Date.now(),entry={pid:child.pid,daemonIndex:daemons.indexOf(child),requestedSignal:'SIGTERM',escalated:false};await new Promise(resolve=>{const timer=setTimeout(()=>{entry.escalated=true;child.kill('SIGKILL')},8000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});Object.assign(entry,{elapsedMs:Date.now()-started,exitCode:child.exitCode,exitSignal:child.signalCode});(report.stops??=[]).push(entry)}
function retainedPeerRoutes(index,node){const manifest=JSON.parse(readFileSync(join(homes[index],'installation.json'))),path=join(homes[index],'profiles',manifest.defaultProfileId,'net/net.db'),db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA query_only=ON');const row=db.prepare('SELECT signed FROM net_peer_routes WHERE node=?').get(node);if(!row)return null;const signed=JSON.parse(row.signed),bytes=Buffer.from(signed.payload,'base64url');return {record:JSON.parse(bytes),payloadSha256:createHash('sha256').update(bytes).digest('hex')}}finally{db.close()}}
try{
  report.stage='protected-target';save();await launch(0);await cli(0,['net','init',...(enrollment==='direct-transition'?['--listen','--port','0']:[])]);await cli(0,['net','protect'],passphrase)
  const a=await cli(0,['net','status']);if(!a.protected)throw new Error('target_not_protected')
  const cfSettings=join(runDir,'cloudflare.json'),directSettings=join(runDir,'direct.json');writeFileSync(cfSettings,JSON.stringify({mode:'quick',binary:'/opt/homebrew/bin/cloudflared'}),{mode:0o600});writeFileSync(directSettings,'{}',{mode:0o600})
  const enroll=async()=>{await launch(1);const nodeInvite=await cli(0,['bridge','invite']),inviteFile=join(runDir,'node-invite');writeFileSync(inviteFile,nodeInvite.invite,{mode:0o600});try{await cli(1,['bridge','join','--invite-file',inviteFile,'--protect'],passphrase)}finally{rmSync(inviteFile,{force:true})}const b=await cli(1,['net','status']);if(!b.protected||a.self.user!==b.self.user||a.self.node===b.self.node)throw new Error('enrollment_binding')}
  if(enrollment==='direct-transition'){report.stage='direct-enrollment';save();await enroll()}
  report.stage='cloudflare-start';save();await cli(0,['net','transport','configure','cloudflared','--settings-file',cfSettings]);captureTunnels()
  if(enrollment==='direct-transition'){
    // Let the normal direct session retain the current signed CF route first.
    await until(()=>cli(1,['net','status']),status=>status.peers.some(peer=>peer.node===a.self.node&&peer.state==='open'))
    const before=(await cli(0,['net','status'])).routes.find(route=>route.transport==='cloudflared');if(!before)throw new Error('missing_transition_route');const cached=await until(()=>retainedPeerRoutes(1,a.self.node),entry=>entry?.record.routes.some(route=>route.address===before.address));report.transition={beforeAddress:before.address,retainedPayloadSha256:cached.payloadSha256,retainedVersion:cached.record.version};report.stage='direct-disable';save();await cli(0,['net','transport','configure','direct','--settings-file',directSettings,'--disable']);captureTunnels()
  }
  const cf=await cli(0,['net','status']);if(cf.routes.length!==1||cf.routes[0].transport!=='cloudflared'||cf.transports.find(t=>t.id==='direct')?.enabled)throw new Error('route_not_exclusive');report.onlyCloudflareRoute=true
  if(report.transition){report.transition.afterAddress=cf.routes[0].address;report.transition.tunnelChildren=tunnels.length;if(report.transition.beforeAddress!==report.transition.afterAddress||tunnels.length!==1)throw new Error('unchanged_tunnel_restarted')}
  report.stage='system-dns';report.hostname=new URL(cf.routes[0].address).hostname;save();let lastDnsCode
  await until(async()=>{try{const answers=await lookup(report.hostname,{all:true});return answers.length>0}catch(error){lastDnsCode=error.code;return false}},Boolean,45000).catch(()=>{report.dnsError=lastDnsCode??'empty';throw new Error('system_dns_failed')});report.systemDns=true
  if(enrollment==='cloudflare'){report.stage='cloudflare-enrollment';save();await enroll()}
  report.stage='bridge-read-snapshot';save();await until(()=>cli(1,['net','status']),status=>status.peers.some(peer=>peer.node===a.self.node&&peer.state==='open'),40000)
  if(report.transition)report.transition.authenticatedReconnect=true
  const created=await cli(1,['bridge','create',a.self.node,'Packaged Cloudflare provider-independent thread']),thread=created.result?.thread?.id;if(!thread)throw new Error('thread_create_binding')
  const listing=await cli(1,['bridge','threads',a.self.node]);if(!JSON.stringify(listing).includes(thread))throw new Error('thread_listing_missing')
  const view=await attach(1,a.self.node,thread);if(view.kind!=='snapshot'||view.value?.thread?.id!==thread)throw new Error('snapshot_binding');report.bridge={sameUser:true,createdThread:thread,listing:true,verifiedSnapshot:true,snapshotBytes:Buffer.byteLength(JSON.stringify(view.value))}
  report.stage='foreign-public-space';save();await launch(2);await cli(2,['net','init']);await cli(2,['net','protect'],passphrase);const member=await cli(2,['net','status']);if(member.self.user===a.self.user)throw new Error('foreign_identity_missing')
  const space=await cli(0,['spaces','create','Packaged Cloudflare public Space']),spaceInvite=await cli(0,['spaces','invite',space.space]);await cli(2,['spaces','join'],spaceInvite.invite+'\n')
  const text='Original packaged Cloudflare public message '+randomBytes(12).toString('hex'),delivery=await cli(2,['spaces','post',space.channel,text]);if(!delivery.id||!['pending','unknown','sent'].includes(delivery.state))throw new Error('delivery_missing')
  const final=await until(()=>cli(2,['spaces','outbox',space.channel,'--id',delivery.id]),result=>result.entries?.[0]?.state==='sent',40000),receipt=final.entries[0];const read=await until(()=>cli(0,['spaces','tail',space.channel]),page=>page.records?.some(row=>row.envelope.id===delivery.id),30000),original=read.records.find(row=>row.envelope.id===delivery.id)
  if(original.envelope.body.text!==text||original.envelope.author.user!==member.self.user||original.envelope.author.node!==member.self.node||original.seq!==receipt.position.seq||original.epoch!==receipt.position.epoch)throw new Error('original_readback_mismatch')
  const replica=await until(()=>cli(2,['spaces','tail',space.channel]),page=>page.records?.some(row=>row.envelope.id===delivery.id));if(replica.records.find(row=>row.envelope.id===delivery.id).envelope.body.text!==text)throw new Error('replica_original_mismatch')
  report.space={foreignUser:true,space:space.space,stream:space.channel,originalEvent:delivery.id,state:receipt.state,position:receipt.position,hostAndMemberReadback:true};report.status='completed'
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
  report.stageAtCleanup=report.stage
  for(const child of [...children])await stop(child)
  report.ownedProcessesStopped=children.size===0
  const gone=()=>tunnels.length>0&&tunnels.every(t=>{try{process.kill(t.pid,0);return false}catch(error){return error.code==='ESRCH'}})
  const removed=()=>tunnels.length>0&&tunnels.every(t=>!existsSync(t.directory))
  // Electron exit and the tunnel child's exit are separate observable events.
  // Wait for actual cleanup rather than sampling immediately or erasing proof.
  const cleanupDeadline=Date.now()+10000
  while(Date.now()<cleanupDeadline&&(!gone()||!removed()))await sleep(100)
  report.ownedTunnelProcessesStopped=gone();report.ownedTunnelDirectoriesRemoved=removed();report.ownedTunnelCount=tunnels.length
  if(report.status==='completed'&&(!report.ownedProcessesStopped||!gone()||!removed())){report.status='failed';report.error='owned_cleanup_failed';process.exitCode=1}
  report.ownedRuntimeRecordsRemoved=homes.every(home=>!existsSync(join(home,'mms.runtime.json')));report.ownedOwnerRecordsRemoved=homes.every(home=>!existsSync(join(home,'mms.owner.json')));
  if(report.status==='completed'&&(!report.ownedRuntimeRecordsRemoved||!report.ownedOwnerRecordsRemoved||report.stops?.some(entry=>entry.escalated))){report.status='failed';report.error='owned_lifetime_not_graceful';process.exitCode=1}
  rmSync(join(runDir,'node-invite'),{force:true});if(report.ownedProcessesStopped&&gone()&&removed())for(const home of homes)rmSync(home,{recursive:true,force:true});report.ownedProfileDirectoriesRemoved=homes.every(home=>!existsSync(home))
  save();console.log(JSON.stringify(report))
}
