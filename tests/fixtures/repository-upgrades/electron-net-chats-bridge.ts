import {app,BrowserWindow} from 'electron'
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {GuiMmsController} from '../../../src/main/mms/GuiMmsController'
import {registerGuiIpc} from '../../../src/main/ipc/registerGuiIpc'
import {PresentationState} from '../../../src/main/mms/PresentationState'
import {newId} from '../../../src/shared/net'
import {getDefaultSettings} from '../../../src/shared/settings'
import {ChatStore} from '../../../src/mms/chats/ChatStore'
import type {ChatConversation} from '../../../src/shared/chats'
import type {ChatNetworkBinding,NetworkChatConversation} from '../../../src/shared/chatsNetwork'
import type {NetStatus} from '../../../src/shared/net/local'

const config=JSON.parse(readFileSync(process.env.MOUSSE_GUI_NET_CONFIG!,'utf8')) as {home:string;endpoint:string;ownerToken:string;preload:string;evidence:string;userData:string;ownerProfile:string;memberProfile:string;ownerProfileHome:string;memberProfileHome:string;agentId:string;passphrase:string}
app.setPath('userData',config.userData);app.disableHardwareAcceleration()
const timer=setTimeout(()=>app.exit(2),60000);timer.unref()
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
async function run(){
  await app.whenReady()
  const gui=new GuiMmsController({homeDir:config.home,endpointOverride:config.endpoint,ownerTokenOverride:config.ownerToken,disableAutoStart:true,requestTimeoutMs:10000});gui.on('error',()=>{})
  let active:BrowserWindow|null=null
  registerGuiIpc({guiMms:gui,presentation:new PresentationState(),settings:{get:()=>getDefaultSettings()} as never,fileService:{} as never,gitService:{} as never,browserView:{init:()=>{}} as never,repoRoot:config.home},()=>active)
  const windows:BrowserWindow[]=[]
  const win=()=>{const result=new BrowserWindow({show:false,webPreferences:{preload:config.preload,sandbox:false,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});windows.push(result);return result}
  const owner=win(),member=win()
  const call=<T=any>(window:BrowserWindow,method:string,params:unknown={}):Promise<T>=>{active=window;return window.webContents.executeJavaScript(`window.mousse.platformRequest.request(${JSON.stringify(method)},${JSON.stringify(params)})`) as Promise<T>}
  const deny=async(window:BrowserWindow,method:string,params:unknown):Promise<string|undefined>=>{active=window;return window.webContents.executeJavaScript(`window.mousse.platformRequest.request(${JSON.stringify(method)},${JSON.stringify(params)}).then(()=>({allowed:true}),error=>({code:error.code})).then(value=>value.code)`) as Promise<string|undefined>}
  try{
    await gui.start()
    for(const window of windows){await gui.prepareWindow(window.webContents);await window.loadURL('data:text/html,<html><body>Actual production Net and Chats IPC</body></html>')}
    active=owner;await owner.webContents.executeJavaScript(`window.mousse.profiles.bind(${JSON.stringify(config.ownerProfile)})`)
    active=member;await member.webContents.executeJavaScript(`window.mousse.profiles.bind(${JSON.stringify(config.memberProfile)})`)
    const exposed=await owner.webContents.executeJavaScript(`({bridge:typeof window.mousse.platformRequest.request==='function',nodeUnavailable:typeof window.require==='undefined',ownerTokenUnavailable:!('ownerToken' in window.mousse),legacyControlUnavailable:!('control' in window.mousse)})`)
    await call(owner,'net.init',{listen:true,port:0,name:'GUI owner'});await call(owner,'net.protect',{passphrase:config.passphrase})
    await call(member,'net.init',{listen:true,port:0,name:'GUI member'});await call(member,'net.protect',{passphrase:config.passphrase})
    const ownerStatus=await call<NetStatus>(owner,'net.status'),memberStatus=await call<NetStatus>(member,'net.status')
    if(!ownerStatus.protected||!memberStatus.protected||ownerStatus.self!.user===memberStatus.self!.user)throw new Error('Profiles did not use distinct protected identities')
    const standalone=await call(owner,'spaces.create',{name:'GUI standalone Space'})
    const ownerSpaces=await call(owner,'spaces.list'),memberBefore=await call(member,'spaces.list')
    const group=await call<ChatConversation>(owner,'chats.create',{kind:'group',name:'GUI publishable Group',agentIds:[config.agentId]})
    // Trusted main-side local fixture only. It never sends a renderer filesystem
    // path or starts an agent/provider just to establish prior local history.
    const store=new ChatStore(config.ownerProfileHome,config.ownerProfile),record=store.read(group.id),oldId=randomUUID(),at=new Date().toISOString()
    record.conversation.messages=[{id:oldId,participantId:'self',text:'GUI OLD LOCAL HISTORY CANARY',createdAt:at,status:'completed'}];record.conversation.updatedAt=at;store.write(record)
    writeFileSync(join(record.workspaceRoot,'gui-local-resource.txt'),'GUI LOCAL RESOURCE CANARY',{mode:0o600})
    const before=readFileSync(join(config.ownerProfileHome,'chats',`${group.id}.json`)),local=await call<ChatConversation>(owner,'chats.get',{chatId:group.id})
    const publication={chatId:group.id,publicationId:'gui-original-publication'}
    // The Node-owned server drops this one genuine framed response after commit.
    const lostReply=await deny(owner,'chats.publish',publication)
    const binding=await call<ChatNetworkBinding>(owner,'chats.publication',{chatId:group.id}),retry=await call(owner,'chats.publish',publication)
    const empty=await call<ChatConversation>(owner,'chats.get',{chatId:group.id})
    const message={chatId:group.id,text:'GUI shared original with explicit no bot mentions',clientMessageId:'gui-original-message',mentions:[]}
    const one=await call<ChatConversation>(owner,'chats.send',message),two=await call<ChatConversation>(owner,'chats.send',message)
    const invitation=await call(member,'spaces.list');if(invitation.spaces.length)throw new Error('Owner Spaces crossed the member window before join')
    const invite=await call(owner,'spaces.invite',{space:binding.space})
    await call(member,'spaces.join',{invite:invite.invite,name:'GUI member'})
    const memberThreadsBefore=await member.webContents.executeJavaScript('window.mousse.threads.listAll()'),memberFilesBefore=readdirSync(join(config.memberProfileHome,'chats'))
    const joined=await call<NetworkChatConversation>(member,'chats.bind',{bindingId:'gui-joined-original',space:binding.space,channel:binding.channel})
    const joinedRetry=await call<NetworkChatConversation>(member,'chats.bind',{bindingId:'gui-joined-original',space:binding.space,channel:binding.channel})
    const joinedMessage={chatId:joined.id,text:'GUI authenticated joined member original',clientMessageId:'gui-joined-message',mentions:[]}
    const joinedSent=await call<NetworkChatConversation>(member,'chats.send',joinedMessage),joinedSendRetry=await call<NetworkChatConversation>(member,'chats.send',joinedMessage)
    const current=await call<ChatConversation>(owner,'chats.get',{chatId:group.id}),joinedGet=await call<NetworkChatConversation>(member,'chats.get',{chatId:joined.id})
    const denials={oldControl:await deny(owner,'control.status',{}),oldPairing:await deny(owner,'pairing.create',{}),forgedProfile:await deny(owner,'chats.get',{chatId:group.id,profileId:config.memberProfile}),foreignOwnerGroup:await deny(member,'chats.get',{chatId:group.id}),foreignPublication:await deny(member,'chats.publish',publication),foreignJoinedId:await deny(owner,'chats.get',{chatId:joined.id}),forgedAuthor:await deny(owner,'chats.send',{...message,author:{user:memberStatus.self!.user,node:memberStatus.self!.node}}),foreignMentions:await deny(owner,'chats.send',{...message,clientMessageId:'unregistered-bot',mentions:[newId('bot')]}),changedOriginal:await deny(owner,'chats.send',{...message,text:'changed original'}),runtimePath:await deny(owner,'chats.publish',{...publication,modulePath:'/untrusted/module'}),unallowlisted:await deny(owner,'gui.fixture.notAllowed',{})}
    const memberThreadsAfter=await member.webContents.executeJavaScript('window.mousse.threads.listAll()'),memberFilesAfter=readdirSync(join(config.memberProfileHome,'chats'))
    const evidence={ok:true,exposed,identities:{owner:ownerStatus.self,member:memberStatus.self,protected:true},standalone,ownerSpaces,memberBefore,groupId:group.id,local:{messages:local.messages.length,oldId,originalRecordSha256:hash(before),unchangedRecord:hash(before)===hash(readFileSync(join(config.ownerProfileHome,'chats',`${group.id}.json`)))},lostReply,binding,retry,emptyHead:empty.network!.head,one:one.network,two:two.network,joined,joinedRetryId:joinedRetry.id,joinedSent:joinedSent.network,joinedSendRetry:joinedSendRetry.network,current:current.network,joinedGet,denials,memberThreadsBefore:memberThreadsBefore.length,memberThreadsAfter:memberThreadsAfter.length,memberFilesBefore,memberFilesAfter}
    writeFileSync(config.evidence,JSON.stringify(evidence),{mode:0o600})
  }finally{await gui.stop();for(const window of windows)if(!window.isDestroyed())window.destroy()}
}
void run().then(()=>{clearTimeout(timer);app.exit(0)},error=>{writeFileSync(config.evidence,JSON.stringify({ok:false,message:String(error),stack:error?.stack}),{mode:0o600});process.stderr.write(String(error?.stack??error));app.exit(1)})
