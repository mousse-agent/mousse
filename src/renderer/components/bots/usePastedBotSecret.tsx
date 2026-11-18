import { useSyncExternalStore } from 'react'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { pastedSecretShape, pastedSecretValue } from '../../../shared/secretShapes'
import { SECRET_KEEPS, secretKeepLabel } from '../../../shared/secretRequests'
import { privateBotDraft, subscribePrivateBotDrafts, updatePrivateBotDraft, changePrivateBotDraft, savedPrivateBotDraft, admitPrivateBotDraft } from './privateBotDrafts'

/** A private paste survives unmounts, but lives only in this window's in-memory draft map. */
export function usePastedBotSecret(bot: BotSummary, storedDraft: string) {
  const held=useSyncExternalStore(subscribePrivateBotDrafts,()=>privateBotDraft(bot.id))
  const draft=held.text??storedDraft
  const shape=pastedSecretShape(draft)
  const change=(text:string)=>changePrivateBotDraft(bot.id,text)
  const save=async()=>{
    if(!shape || privateBotDraft(bot.id).busy) return
    const value=draft.slice(shape.start,shape.end)
    updatePrivateBotDraft(bot.id,{busy:true,error:undefined})
    try {
      const {name}=await window.mousse.platformRequest.request<{name:string}>('secrets.keepPasted',{botId:bot.id,value,keep:held.keep})
      // Even an unmounted bot's answer updates its retained draft and announces the granted name on return.
      savedPrivateBotDraft(bot.id,value,name)
    } catch (failure) {
      const error=failure && typeof failure==='object' ? failure as {code?:unknown;message?:unknown} : undefined
      const message=typeof error?.message==='string'?error.message:''
      const safe=message && !message.includes(pastedSecretValue(value)) && !pastedSecretShape(message)
      updatePrivateBotDraft(bot.id,{error:error?.code==='forbidden'
        ? `${bot.name} can't keep secrets; remove it before sending, or allow Use secrets in About.`
        : safe ? message : "Couldn't keep it. Nothing was saved."})
    }
    finally { updatePrivateBotDraft(bot.id,{busy:false}) }
  }
  const beforeSend=()=>{
    const current=privateBotDraft(bot.id)
    if(current.busy) return false
    if(shape && !current.dismissed && !current.highlighted) {updatePrivateBotDraft(bot.id,{highlighted:true});return false}
    if(current.text!==undefined) admitPrivateBotDraft(bot.id,current.text)
    return true
  }
  const offer=<>
    {held.notice && <p role="status" className="secret-request-keep-line">{held.notice}</p>}
    {shape && !held.dismissed && <div className="bot-pasted-secret secret-request-card" role={held.highlighted?'alert':'status'}>
      <p className="composer-question-prompt">This looks like a key. {held.error??'Keep it as a secret?'}</p>
      <div className="secret-request-keep" role="radiogroup" aria-label="Keep it for">
        {SECRET_KEEPS.map(option=><button key={option} type="button" role="radio" aria-checked={held.keep===option} className={`secret-request-keep-option${held.keep===option?' is-selected':''}`} disabled={held.busy} onClick={()=>updatePrivateBotDraft(bot.id,{keep:option})}>{secretKeepLabel(option)}</button>)}
      </div>
      <div className="bot-pasted-secret-actions">
        <button type="button" className="composer-question-btn" disabled={held.busy} onClick={()=>void save()}>Keep as secret</button>
        <button type="button" className="composer-question-btn is-quiet" disabled={held.busy} onClick={()=>updatePrivateBotDraft(bot.id,{dismissed:true})}>Send as text</button>
      </div>
    </div>}
  </>
  return {draft,change,beforeSend,offer}
}
