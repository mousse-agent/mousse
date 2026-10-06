import { exportAppletHtml } from '../../shared/appletExport'
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { GuiMmsController } from '../mms/GuiMmsController'
import type { AppletBundle } from '../../shared/applets'
import type { AppletIdentity, AppletBounds, AppletUiEvent } from '../../shared/appletRuntime'
import { validateAppletAppearance } from '../../shared/appletAppearance'
import { AppletRuntimeManager } from './AppletRuntimeManager'

type Register = (channel:string, handler:(event:IpcMainInvokeEvent, input:unknown)=>unknown)=>void
interface Owner {manager:AppletRuntimeManager;window:BrowserWindow;profileId:string;epoch:number;entries:Map<string,AppletIdentity>}
export function registerAppletIpc(register:Register, gui:GuiMmsController, allowedWindows:()=>Array<BrowserWindow|null>):void {
  const owners=new Map<number,Owner>()
  const watchedWindows=new WeakSet<BrowserWindow>()
  gui.on('window-profile-changing', ({senderId}:{senderId:number})=>{const own=owners.get(senderId);own?.manager.destroy();owners.delete(senderId)})
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid applet request.');return value as Record<string,unknown>}
  const string=(value:unknown):string=>{if(typeof value!=='string'||!value||value.length>160)throw new Error('Invalid applet identifier.');return value}
  const identity=(raw:Record<string,unknown>):AppletIdentity=>({threadId:string(raw.threadId),appletId:string(raw.appletId),revisionId:string(raw.revisionId)})
  const rect=(value:unknown):AppletBounds=>{const r=object(value);if(['x','y','width','height'].some(key=>typeof r[key]!=='number'||!Number.isFinite(r[key])||Math.abs(r[key] as number)>8192)||Number(r.width)<0||Number(r.height)<0)throw new Error('Invalid applet bounds.');return{x:Number(r.x),y:Number(r.y),width:Number(r.width),height:Number(r.height)}}
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
      if(eventData.type==='state') {
        void gui.runWithSender(win.webContents,()=>gui.request('applets.state.save',{...entry,profileId:ownProfile(value),state:eventData.payload})).catch(()=>{})
        return
      }
      const result:AppletUiEvent={runtimeId:eventData.runtimeId,type:eventData.type==='conversation-input'?'conversation-input':eventData.type,
        ...(eventData.type==='resize'?{height:Number(eventData.payload)}:{}),...(eventData.type==='error'?{message:String(eventData.payload)}:{}),...(eventData.type==='conversation-input'?{text:String(eventData.payload)}:{})}
      win.webContents.send('applets:event',result)
    })
    owners.set(event.sender.id,value)
    if(!watchedWindows.has(win)){
      watchedWindows.add(win)
      const senderId=event.sender.id
      win.once('closed',()=>{owners.get(senderId)?.manager.destroy();owners.delete(senderId)})
    }
    return value
  }
  const ownProfile = (own:Owner) => own.profileId
  register('applets:get',async(event,input)=>{const own=owner(event);const result=await gui.request('applets.get',{...identity(object(input)),profileId:own.profileId});if(owners.get(event.sender.id)!==own)throw new Error('Profile changed.');return result})
  register('applets:mount',async(event,input)=>{
    const own=owner(event),raw=object(input),id=identity(raw),bounds=rect(raw.bounds),clip=rect(raw.clip),appearance=raw.appearance===undefined?undefined:validateAppletAppearance(raw.appearance)
    const bundle=await gui.request<AppletBundle>('applets.get',{...id,profileId:own.profileId})
    if(bundle.sourceHash!==raw.sourceHash)throw new Error('Applet source changed. Reload the thread.')
    const saved=await gui.request<{state:unknown}>('applets.state.get',{...id,profileId:own.profileId})
    if(owners.get(event.sender.id)!==own||gui.getWindowBindingForSender(event.sender.id)?.profileId!==own.profileId||gui.getWindowBindingForSender(event.sender.id)?.epoch!==own.epoch)throw new Error('Profile changed while opening applet.')
    const runtimeId=randomUUID();own.entries.set(runtimeId,id)
    try{await own.manager.mount({runtimeId,threadId:id.threadId,revisionId:id.revisionId,source:bundle.source,state:saved.state,bounds,clip,appearance})}
    catch(error){own.entries.delete(runtimeId);throw error}
    return{runtimeId}
  })
  register('applets:appearance',async(event,input)=>{
    const own=owner(event),raw=object(input),runtimeId=string(raw.runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    await own.manager.appearance(runtimeId,validateAppletAppearance(raw.appearance))
    if(owners.get(event.sender.id)!==own)throw new Error('Profile changed while updating appearance.')
  })
  register('applets:snapshot',async(event,input)=>{
    const own=owner(event),runtimeId=string(object(input).runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    const image=await own.manager.snapshot(runtimeId)
    if(owners.get(event.sender.id)!==own)throw new Error('Profile changed while scrolling applet.')
    return {image}
  })
  register('applets:suspend',(event,input)=>{
    const own=owner(event),runtimeId=string(object(input).runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    own.manager.suspend(runtimeId)
  })
  register('applets:update',(event,input)=>{
    const own=owner(event),raw=object(input),runtimeId=string(raw.runtimeId)
    if(!own.entries.has(runtimeId))throw new Error('Applet runtime is not owned by this window.')
    if(raw.visible===false){own.manager.unmount(runtimeId);own.entries.delete(runtimeId);return}
    own.manager.layout(runtimeId,rect(raw.bounds),rect(raw.clip))
  })
  register('applets:unmount',(event,input)=>{
    const own=owner(event),runtimeId=string(object(input).runtimeId)
    if(!own.entries.has(runtimeId))return
    own.manager.unmount(runtimeId);own.entries.delete(runtimeId)
  })
  register('applets:export',async(event,input)=>{
    const own=owner(event),raw=object(input),id=identity(raw)
    const bundle=await gui.request<AppletBundle>('applets.get',{...id,profileId:own.profileId})
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
      const result=await gui.request<{content:string}>('applets.export',{...id,profileId:own.profileId,format,...(raw.appearance===undefined?{}:{appearance:validateAppletAppearance(raw.appearance)})})
      if(owners.get(event.sender.id)!==own)throw new Error('Profile changed during export.')
      await writeFile(selection.filePath,result.content,'utf8')
    }
    return{cancelled:false}
  })
}
