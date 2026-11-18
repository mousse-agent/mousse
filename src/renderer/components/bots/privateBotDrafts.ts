import { DEFAULT_SECRET_KEEP, SECRET_DAY_MS, type SecretKeep } from '../../../shared/secretRequests'
import { pastedSecretShape, pastedSecretValue, pastedSecretReplacement } from '../../../shared/secretShapes'
import { useBotsStore } from '../../stores/botsStore'

interface Saved { value: string; name: string; expiresAt: number }
export interface PrivateBotDraft {
  text?: string
  busy: boolean
  dismissed: boolean
  highlighted: boolean
  keep: SecretKeep
  error?: string
  notice?: string
  saved: readonly Saved[]
}
// Window memory only. Values never enter Zustand, local storage, transcript or IPC until an explicit choice.
const drafts = new Map<string, PrivateBotDraft>()
const expiryTimers = new Set<ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let admitting: string | undefined
const notify = () => { for (const listener of listeners) listener() }
export const subscribePrivateBotDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function privateBotDraft(botId: string): PrivateBotDraft {
  let entry=drafts.get(botId)
  if (!entry) { entry={ busy:false, dismissed:false, highlighted:false, keep:DEFAULT_SECRET_KEEP, error:undefined, saved:[] };drafts.set(botId,entry) }
  const saved=entry.saved.filter(item=>item.expiresAt>Date.now())
  if(saved.length!==entry.saved.length) {entry={...entry,saved};drafts.set(botId,entry)}
  return entry
}
export function updatePrivateBotDraft(botId:string, patch:Partial<PrivateBotDraft>):void {
  drafts.set(botId,{...privateBotDraft(botId),...patch});notify()
}
export function clearPrivateBotDrafts():void { for(const timer of expiryTimers) clearTimeout(timer);expiryTimers.clear();drafts.clear();notify() }
function replaceKnown(text:string, saved:readonly Saved[]):string {
  for (const item of saved) {
    text=text.split(item.value).join(pastedSecretReplacement(item.value,item.name))
    const raw=pastedSecretValue(item.value)
    if(raw!==item.value) text=text.split(raw).join(`the secret ${item.name}`)
  }
  return text
}
export function changePrivateBotDraft(botId:string,text:string):void {
  const entry=privateBotDraft(botId)
  text=replaceKnown(text,entry.saved)
  const privateText=pastedSecretShape(text)!==undefined
  updatePrivateBotDraft(botId,{text:privateText?text:undefined,dismissed:false,highlighted:false,error:undefined,notice:undefined})
  useBotsStore.getState().setDraft(botId,privateText?'':text)
}
export function savedPrivateBotDraft(botId:string,value:string,name:string):void {
  const entry=privateBotDraft(botId)
  const expiresAt=entry.keep==='day'?Date.now()+SECRET_DAY_MS:Infinity
  const saved=[...entry.saved,{value,name,expiresAt}]
  if(Number.isFinite(expiresAt)) {
    const timer=setTimeout(()=>{expiryTimers.delete(timer);const current=drafts.get(botId);if(current) {drafts.set(botId,{...current,saved:current.saved.filter(item=>item.expiresAt>Date.now())});notify()}},SECRET_DAY_MS)
    expiryTimers.add(timer)
  }
  const text=replaceKnown(entry.text??useBotsStore.getState().drafts[botId]??'',saved)
  updatePrivateBotDraft(botId,{saved,busy:false})
  changePrivateBotDraft(botId,text)
  updatePrivateBotDraft(botId,{notice:`Kept as ${name}`})
}
export function admitPrivateBotDraft(botId:string,text:string):void {
  updatePrivateBotDraft(botId,{text:undefined})
  admitting=botId
  try { useBotsStore.getState().setDraft(botId,text) } finally { admitting=undefined }
}
// Applets and memory quotes write directly into the normal draft, including while this bot is unmounted.
// Drain those additions synchronously so the next edit, save or Send cannot hide or overwrite them.
useBotsStore.subscribe((state,previous)=>{
  if(state.profileId!==previous.profileId) { clearPrivateBotDrafts();return }
  for (const [botId,incoming] of Object.entries(state.drafts)) {
    if(!incoming || incoming===previous.drafts[botId] || admitting===botId) continue
    const entry=drafts.get(botId)
    if(entry?.text!==undefined) changePrivateBotDraft(botId,`${entry.text}\n\n${incoming}`)
    else if(pastedSecretShape(incoming) || entry?.saved.length) changePrivateBotDraft(botId,incoming)
  }
})

export function sentPrivateBotDraft(botId:string):void {
 updatePrivateBotDraft(botId,{notice:undefined,saved:[]})
}
