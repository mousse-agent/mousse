import {app,BrowserWindow} from 'electron'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {GuiMmsController} from '../../../src/main/mms/GuiMmsController'
import {registerGuiIpc} from '../../../src/main/ipc/registerGuiIpc'
import {PresentationState} from '../../../src/main/mms/PresentationState'
import {getDefaultSettings} from '../../../src/shared/settings'
import type {BridgeEntityRef} from '../../../src/shared/bridge'
const config=JSON.parse(readFileSync(process.env.MOUSSE_GUI_BRIDGE_CONFIG!,'utf8')) as {html:string;renderer:string;replayTrigger:string;replayDone:string;home:string;endpoint:string;ownerToken:string;preload:string;evidence:string;userData:string;profiles:string[];passphrase:string;message:string}
app.setPath('userData',config.userData);app.disableHardwareAcceleration()
const timer=setTimeout(()=>app.exit(2),45000);timer.unref()
const evidence:Record<string,any>={ok:false,parts:0,foreignParts:0,views:0,api:false}
async function run(){
  await app.whenReady();const gui=new GuiMmsController({homeDir:config.home,endpointOverride:config.endpoint,ownerTokenOverride:config.ownerToken,disableAutoStart:true,requestTimeoutMs:10000});gui.on('error',()=>{})
  let active:BrowserWindow|null=null
  registerGuiIpc({guiMms:gui,presentation:new PresentationState(),settings:{get:()=>getDefaultSettings()} as never,fileService:{} as never,gitService:{} as never,browserView:{init:()=>{}} as never,repoRoot:config.home},()=>active)
  const windows=config.profiles.map(()=>new BrowserWindow({show:false,webPreferences:{preload:config.preload,sandbox:false,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})),[owner,foreign,device]=windows
  const call=<T=any>(win:BrowserWindow,method:string,params:unknown={}):Promise<T>=>{active=win;return win.webContents.executeJavaScript(`window.mousse.platformRequest.request(${JSON.stringify(method)},${JSON.stringify(params)})`) as Promise<T>}
  const state=()=>owner.webContents.executeJavaScript('window.display.state')
  try{
    await gui.start();for(const [index,win]of windows.entries()){await gui.prepareWindow(win.webContents);await win.loadFile(config.html);await win.webContents.executeJavaScript(readFileSync(config.renderer,'utf8'));active=win;await win.webContents.executeJavaScript(`(async()=>{await window.mousse.profiles.bind(${JSON.stringify(config.profiles[index])});window.__bridgeParts=[];window.__bridgeApi=typeof window.mousse.bridge?.onThreadPart==='function';window.__bridgeOff=window.__bridgeApi?window.mousse.bridge.onThreadPart(part=>window.__bridgeParts.push(part)):()=>{};return true})()`)}
    await call(owner,'net.init',{listen:true,port:0});await call(owner,'net.protect',{passphrase:config.passphrase});await call(foreign,'net.init',{listen:true,port:0});await call(foreign,'net.protect',{passphrase:config.passphrase})
    const invitation=await call(owner,'bridge.invite');await call(device,'bridge.join',{invite:invitation.invite,passphrase:config.passphrase})
    const ownerStatus=await call(owner,'net.status'),foreignStatus=await call(foreign,'net.status'),deviceStatus=await call(device,'net.status')
    if(!ownerStatus.protected||!foreignStatus.protected||!deviceStatus.protected||ownerStatus.self.user!==deviceStatus.self.user||foreignStatus.self.user===ownerStatus.self.user)throw new Error('Protected same-user/foreign identity fixture mismatch')
    active=device;const thread=await device.webContents.executeJavaScript(`window.mousse.threads.create('GUI remote original thread')`),ref:BridgeEntityRef={nodeId:deviceStatus.self.node,entityId:thread.id};await owner.webContents.executeJavaScript(`window.display.configure(${JSON.stringify(ref)});true`)
    evidence.api=await owner.webContents.executeJavaScript('window.display.api');evidence.ref=ref;evidence.attached=await call(owner,'bridge.hub.attach',{ref})
    let observed:any;const deadline=Date.now()+10000;while(Date.now()<deadline){observed=await state();if(observed.snapshot||observed.errors.length)break;await new Promise(resolve=>setTimeout(resolve,100))}
    evidence.snapshotBytes=observed.snapshot?Buffer.byteLength(JSON.stringify(observed.snapshot)):0;evidence.contentMatched=observed.snapshot?.messages?.[0]?.content===config.message;evidence.decoderErrors=observed.errors;evidence.transaction=observed.transaction;evidence.position=observed.lastPosition;evidence.partialViews=observed.partialViews
    if(!evidence.contentMatched)throw new Error('Actual admitted Bridge snapshot did not reach preload and complete renderer decoder')
    active=device;await device.webContents.executeJavaScript(`window.mousse.threads.rename(${JSON.stringify(thread.id)},'GUI remote verified rename')`)
    const renameDeadline=Date.now()+5000;while(Date.now()<renameDeadline){observed=await state();if(observed.renamed)break;await new Promise(resolve=>setTimeout(resolve,100))}
    evidence.renamed=observed.renamed;evidence.parts=observed.parts;evidence.views=observed.views;evidence.foreignParts=await foreign.webContents.executeJavaScript('window.__bridgeParts.length')
    if(!observed.renamed||evidence.foreignParts)throw new Error('Owned Bridge event delivery or foreign exclusion failed')
    await owner.webContents.executeJavaScript('window.display.dispose();window.__bridgeOff();true');active=device;await device.webContents.executeJavaScript(`window.mousse.threads.rename(${JSON.stringify(thread.id)},'GUI remote after disposer')`);await new Promise(resolve=>setTimeout(resolve,500));evidence.partsAfterDispose=(await state()).afterDispose
    if(evidence.partsAfterDispose)throw new Error('Preload listener disposer did not remove owned listener')
    // Rebind through the actual preload twice. The parent replays the exact
    // previously delivered framed original, with its original now-stale epoch.
    active=owner;await owner.webContents.executeJavaScript(`window.mousse.profiles.bind(${JSON.stringify(config.profiles[1])})`);await owner.webContents.executeJavaScript(`window.mousse.profiles.bind(${JSON.stringify(config.profiles[0])})`)
    await owner.webContents.executeJavaScript('window.__staleParts=[];window.__staleOff=window.mousse.bridge.onThreadPart(part=>window.__staleParts.push(part));true')
    writeFileSync(config.replayTrigger,'ready');const replayDeadline=Date.now()+3000;while(!existsSync(config.replayDone)&&Date.now()<replayDeadline)await new Promise(resolve=>setTimeout(resolve,20));if(!existsSync(config.replayDone))throw new Error('Actual stale framed replay did not execute')
    await new Promise(resolve=>setTimeout(resolve,200));evidence.staleParts=await owner.webContents.executeJavaScript('window.__staleParts.length');if(evidence.staleParts)throw new Error('Old binding epoch reached rebound renderer')
    await owner.webContents.executeJavaScript('window.__staleOff();window.display.close()');evidence.ok=true
  }finally{await gui.stop();for(const win of windows)if(!win.isDestroyed())win.destroy();writeFileSync(config.evidence,JSON.stringify(evidence),{mode:0o600})}
}
void run().then(()=>{clearTimeout(timer);app.exit(0)},error=>{writeFileSync(config.evidence,JSON.stringify({...evidence,error:String(error)}),{mode:0o600});process.stderr.write(String(error?.stack??error));app.exit(1)})
