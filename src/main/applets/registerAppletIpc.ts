import { exportAppletHtml } from '../../shared/appletExport'
import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents, type WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { GuiMmsController } from '../mms/GuiMmsController'
import type { AppletBundle } from '../../shared/applets'
import type { AppletBotRef, AppletIdentity, AppletUiEvent } from '../../shared/appletRuntime'
import { parseQualifiedId } from '../../shared/threadRef'
import { validateAppletAppearance } from '../../shared/appletAppearance'
import { AppletRuntimeManager, AppletSlotsBusyError } from './AppletRuntimeManager'
import { logWarn } from '../../mms/log/diag'

type Register = (channel:string, handler:(event:IpcMainInvokeEvent, input:unknown)=>unknown)=>void
/** A running applet: what it is, and `readOnly` when its state is not saved (another computer's bot, shown from the copy). */
type Entry=AppletIdentity&{readOnly?:true}
interface Owner {manager:AppletRuntimeManager;window:BrowserWindow;profileId:string;epoch:number;entries:Map<string,Entry>}
/** What the daemon answers for an applet of another computer's bot (`bots.remote.applet`). */
interface RemoteAppletOpened {bundle:Pick<AppletBundle,'appletId'|'revisionId'|'sourceHash'|'title'|'description'|'source'>;state:unknown;readOnly?:true}
/** Each window's applets, by the window's web contents id. */
const owners=new Map<number,Owner>()

/**
 * `will-attach-webview` for a webview that asks for an applet page: false refuses it. Only the address the window's
 * current applet manager minted attaches, once, into that applet's own session (see AppletRuntimeManager.attach).
 */
export function attachAppletWebview(embedder:WebContents, webPreferences:WebPreferences, params:Record<string,string>):boolean {
  return owners.get(embedder.id)?.manager.attach(webPreferences,params)??false
}
/** `did-attach-webview`: true when the guest is an applet page, which the browser must then leave alone. */
export function adoptAppletWebview(embedder:WebContents, guest:WebContents):boolean {
  return owners.get(embedder.id)?.manager.adopt(guest)??false
}

export function registerAppletIpc(register:Register, gui:GuiMmsController, allowedWindows:()=>Array<BrowserWindow|null>):void {
  const watchedWindows=new WeakSet<BrowserWindow>()
  gui.on('window-profile-changing', ({senderId}:{senderId:number})=>{const own=owners.get(senderId);own?.manager.destroy();owners.delete(senderId)})
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid applet request.');return value as Record<string,unknown>}
  const string=(value:unknown):string=>{if(typeof value!=='string'||!value||value.length>160)throw new Error('Invalid applet identifier.');return value}
  /**
   * An applet of a bot of another computer: the bot by its qualified id and the message that shows it. Its thread is
   * that computer's, so `threadId` becomes a key of this window's alone and never names a thread here.
   */
  const botRef=(value:unknown):AppletBotRef=>{const raw=object(value),botId=string(raw.botId);if(!parseQualifiedId(botId))throw new Error('Invalid applet request.');return{botId,messageId:string(raw.messageId)}}
  const identity=(raw:Record<string,unknown>):AppletIdentity=>{
    const appletId=string(raw.appletId),revisionId=string(raw.revisionId)
    if(raw.bot===undefined)return{threadId:string(raw.threadId),appletId,revisionId}
    const bot=botRef(raw.bot)
    return{threadId:`bot:${bot.botId}`,appletId,revisionId,bot}
  }
  /**
   * The applet's source and saved state: from a thread of this profile, or, for a bot of another computer, read there
   * through the bot (`bots.remote.applet`; the copy here, read-only, while that computer is away). Either way it is
   * checked to be the applet and revision asked for.
   */
  const load=async(own:Owner,id:AppletIdentity):Promise<{bundle:Pick<AppletBundle,'appletId'|'revisionId'|'sourceHash'|'title'|'description'|'source'>;state?:unknown;readOnly?:true}>=>{
    if(!id.bot){
      const bundle=await gui.request<AppletBundle>('applets.get',{threadId:id.threadId,appletId:id.appletId,revisionId:id.revisionId,profileId:own.profileId})
      return{bundle}
    }
    const opened=await gui.request<RemoteAppletOpened>('bots.remote.applet',{profileId:own.profileId,botId:id.bot.botId,messageId:id.bot.messageId,appletId:id.appletId,revisionId:id.revisionId})
    if(opened?.bundle?.appletId!==id.appletId||opened.bundle.revisionId!==id.revisionId)throw new Error('Applet unavailable.')
    return{bundle:opened.bundle,state:opened.state,...(opened.readOnly?{readOnly:true as const}:{})}
  }
  const threadParams=(id:AppletIdentity)=>({threadId:id.threadId,appletId:id.appletId,revisionId:id.revisionId})
  function owner(event:IpcMainInvokeEvent):Owner {
    const win=allowedWindows().find(candidate=>candidate&&!candidate.isDestroyed()&&candidate.webContents===event.sender)
    if(!win||event.senderFrame!==event.sender.mainFrame)throw new Error('Applet access requires the owning Mousse window.')
    const binding=gui.getWindowBindingForSender(event.sender.id)
    const profileId=binding?.profileId
    const epoch=binding?.epoch
    if(!profileId||epoch===undefined)throw new Error('Choose a profile before opening an applet.')
    const previous=owners.get(event.sender.id)
    if(previous?.profileId===profileId&&previous.epoch===epoch)return previous
    previous?.manager.destroy()
    const value:Owner={window:win,profileId,epoch,entries:new Map(),manager:null as unknown as AppletRuntimeManager}
    value.manager=new AppletRuntimeManager(win,eventData=>{
      const entry=value.entries.get(eventData.runtimeId)
      if(!entry||win.isDestroyed())return
      if(gui.getWindowBindingForSender(win.webContents.id)?.profileId!==profileId||gui.getWindowBindingForSender(win.webContents.id)?.epoch!==epoch){value.manager.destroy();value.entries.clear();owners.delete(win.webContents.id);return}
      if(eventData.type==='released')value.entries.delete(eventData.runtimeId)
      if(eventData.type==='state') {
        win.webContents.send('applets:event',{runtimeId:eventData.runtimeId,type:'state-changed'} satisfies AppletUiEvent)
        // Shown from the copy while its bot's computer is away: nothing is saved, and nothing is kept to save later.
        if(entry.readOnly)return
        const {bot,readOnly:_readOnly,...thread}=entry
        void gui.runWithSender(win.webContents,()=>bot
          // An applet of another computer's bot: saved there, which owns its state.
          ?gui.request('bots.remote.appletState',{profileId:ownProfile(value),botId:bot.botId,messageId:bot.messageId,appletId:entry.appletId,revisionId:entry.revisionId,state:eventData.payload})
          :gui.request('applets.state.save',{...thread,profileId:ownProfile(value),state:eventData.payload})).catch(error=>logWarn('applets','saving applet state failed',error,{appletId:entry.appletId}))
        return
      }
      const result:AppletUiEvent={runtimeId:eventData.runtimeId,type:eventData.type,
        ...(eventData.type==='resize'?{height:Number(eventData.payload)}:{}),...(eventData.type==='error'?{message:String(eventData.payload)}:{}),...(eventData.type==='conversation-input'?{text:String(eventData.payload)}:{}),...(eventData.type==='wheel'?{deltaY:Number(eventData.payload)}:{})}
      win.webContents.send('applets:event',result)
    })
    owners.set(event.sender.id,value)
    if(!watchedWindows.has(win)){
      watchedWindows.add(win)
      const senderId=event.sender.id
      win.once('closed',()=>{owners.get(senderId)?.manager.destroy();owners.delete(senderId)})
      // Backstop: a reload, navigation or crashed page has no applet webviews left, so none of their pages may run on.
      // The next applet request from the new page starts a fresh manager.
      const pageGone=()=>{owners.get(senderId)?.manager.destroy();owners.delete(senderId)}
      win.webContents.on('did-start-navigation',(details:{isMainFrame:boolean;isSameDocument:boolean})=>{if(details.isMainFrame&&!details.isSameDocument)pageGone()})
      win.webContents.on('render-process-gone',pageGone)
    }
    return value
  }
  const ownProfile = (own:Owner) => own.profileId
  register('applets:get',async(event,input)=>{const own=owner(event);const{bundle}=await load(own,identity(object(input)));if(owners.get(event.sender.id)!==own)throw new Error('Profile changed.');return bundle})
  register('applets:mount',async(event,input)=>{
    const own=owner(event),raw=object(input),id=identity(raw),appearance=raw.appearance===undefined?undefined:validateAppletAppearance(raw.appearance)
    const loaded=await load(own,id)
    if(loaded.bundle.sourceHash!==raw.sourceHash)throw new Error('Applet source changed. Reload the thread.')
    // Another computer's bot's applet came with its state; a thread's is read here.
    const state=id.bot?loaded.state:(await gui.request<{state:unknown}>('applets.state.get',{...threadParams(id),profileId:own.profileId})).state
    if(owners.get(event.sender.id)!==own||gui.getWindowBindingForSender(event.sender.id)?.profileId!==own.profileId||gui.getWindowBindingForSender(event.sender.id)?.epoch!==own.epoch)throw new Error('Profile changed while opening applet.')
    const runtimeId=randomUUID();own.entries.set(runtimeId,{...id,...(loaded.readOnly?{readOnly:true as const}:{})})
    const host=raw.host==='panel'?'panel':'transcript'
    // The same sandboxed page as every applet, whichever computer its source came from.
    try{return{runtimeId,src:own.manager.mount({runtimeId,host,threadId:id.threadId,revisionId:id.revisionId,source:loaded.bundle.source,state,appearance}),...(loaded.readOnly?{readOnly:true as const}:{})}}
    catch(error){own.entries.delete(runtimeId);if(error instanceof AppletSlotsBusyError)return{busy:true};throw error}
  })
  register('applets:appearance',async(event,input)=>{
    const own=owner(event),raw=object(input),runtimeId=string(raw.runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    await own.manager.appearance(runtimeId,validateAppletAppearance(raw.appearance))
    if(owners.get(event.sender.id)!==own)throw new Error('Profile changed while updating appearance.')
  })
  register('applets:visible',(event,input)=>{
    const own=owner(event),raw=object(input),runtimeId=string(raw.runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    if(typeof raw.visible!=='boolean')throw new Error('Invalid applet request.')
    own.manager.setVisible(runtimeId,raw.visible)
  })
  register('applets:unmount',(event,input)=>{
    const own=owner(event),runtimeId=string(object(input).runtimeId)
    if(!own.entries.has(runtimeId))return
    own.manager.unmount(runtimeId);own.entries.delete(runtimeId)
  })
  register('applets:export',async(event,input)=>{
    const own=owner(event),raw=object(input),id=identity(raw)
    const{bundle}=await load(own,id)
    const format=raw.format
    if(!['html','source','png'].includes(String(format)))throw new Error('Unsupported export format.')
    const selection=await dialog.showSaveDialog(own.window,{title:'Export applet',defaultPath:`applet.${format==='source'?'json':format}`,filters:[{name:format==='png'?'PNG image':format==='source'?'JSON source':'HTML document',extensions:[format==='source'?'json':String(format)]}]})
    if(selection.canceled||!selection.filePath)return{cancelled:true}
    if(owners.get(event.sender.id)!==own||gui.getWindowBindingForSender(event.sender.id)?.profileId!==own.profileId||gui.getWindowBindingForSender(event.sender.id)?.epoch!==own.epoch)throw new Error('Profile changed during export.')
    if(format==='png'){
      const runtimeId=string(raw.runtimeId),entry=own.entries.get(runtimeId)
      if(!entry||entry.threadId!==id.threadId||entry.appletId!==id.appletId||entry.revisionId!==id.revisionId)throw new Error('Applet must be running to export an image.')
      const image=await own.manager.capture(runtimeId)
      if(owners.get(event.sender.id)!==own)throw new Error('Profile changed during export.')
      await writeFile(selection.filePath,image.toPNG())
    }else if(format==='html'){
      const content=exportAppletHtml(bundle.source,raw.appearance===undefined?undefined:validateAppletAppearance(raw.appearance))
      if(owners.get(event.sender.id)!==own)throw new Error('Profile changed during export.')
      await writeFile(selection.filePath,content,'utf8')
    }else{
      // Another computer's bot's applet: its source as read from there, written as a thread's is.
      const result=id.bot?{content:JSON.stringify(bundle.source,null,2)}:await gui.request<{content:string}>('applets.export',{...threadParams(id),profileId:own.profileId,format,...(raw.appearance===undefined?{}:{appearance:validateAppletAppearance(raw.appearance)})})
      if(owners.get(event.sender.id)!==own)throw new Error('Profile changed during export.')
      await writeFile(selection.filePath,result.content,'utf8')
    }
    return{cancelled:false}
  })
}
