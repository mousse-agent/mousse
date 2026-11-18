import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicFetch, publicUrl } from '../net-public/publicFetch'
import { htmlToText } from '../orchestrator/WebTools'
import type { BotStore } from './store/BotStore'
export interface PageSetting { url: string; contains?: string }
interface Flight { key: string; generation: string; startedAt: number; token: string }
interface Result { flight: Flight; hash?: string; file?: string; error?: string; checked?: boolean; failure?: string }
interface State extends PageSetting { generation: string; handedHash: string | null; inFlight?: Flight; result?: Result; failures: number; firstFailureAt?: number; toldUnreadable: boolean }
export function pageSetting(value: PageSetting): PageSetting {
  publicUrl(value.url)
  if (value.contains !== undefined && (typeof value.contains !== 'string' || value.contains.length > 200)) throw new Error('contains is plain text up to 200 characters.')
  return { url: value.url, ...(value.contains !== undefined ? { contains: value.contains } : {}) }
}
export function comparedText(body: string, contains?: string): string {
  const text = htmlToText(body).replace(/\s+/g, ' ').trim()
  if (contains === undefined) return text
  const at = text.toLowerCase().indexOf(contains.toLowerCase())
  if (at < 0) return ''
  const start = Math.max(0, at + Math.floor(contains.length / 2) - 2000)
  return text.slice(start, start + 4000)
}
export class PageChecks {
  constructor(private readonly store: BotStore) {}
  read(botId: string, id: string): State | undefined {
    const row = this.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `pagecheck:${id}`)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  save(botId: string, id: string, state: State): void {
    this.store.run('INSERT INTO bot_memory_state(bot_id,key,value) VALUES(?,?,?) ON CONFLICT(bot_id,key) DO UPDATE SET value=excluded.value',botId,`pagecheck:${id}`,JSON.stringify(state))
  }
  set(botId: string, id: string, setting: PageSetting, generation: string): void {
    this.save(botId,id,{...setting,generation,handedHash:null,failures:0,toldUnreadable:false})
  }
  remove(botId: string, id: string): void { this.store.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?',botId,`pagecheck:${id}`) }
  sweep(exists: (botId: string, id: string) => boolean): void {
    for (const row of this.store.all("SELECT bot_id,key FROM bot_memory_state WHERE key LIKE 'pagecheck:%'"))
      if (!exists(String(row.bot_id),String(row.key).slice(10))) this.remove(String(row.bot_id),String(row.key).slice(10))
  }
  check(botId: string, id: string, generation: string, key: string, now: number, folder: string):
    | { kind:'not_ready' } | { kind:'checked'; failure?: string } | { kind:'changed'; prompt:string; commit: () => void } | undefined {
    const state = this.read(botId,id)
    if (!state) return undefined
    if (state.generation !== generation) { this.set(botId,id,state,generation); return this.check(botId,id,generation,key,now,folder) }
    if (state.result && (state.result.flight.key !== key || state.result.flight.generation !== generation)) state.result = undefined
    if (state.inFlight && (state.inFlight.key !== key || state.inFlight.generation !== generation)) state.inFlight = undefined
    if (state.inFlight && now - state.inFlight.startedAt > 120_000) {
      state.result = { flight:state.inFlight, error:'The page check did not finish within two minutes.' }; state.inFlight = undefined
    }
    if (state.result) {
      const result = state.result
      if (result.checked) return {kind:'checked', ...(result.failure ? {failure:result.failure} : {})}
      if (result.error) {
        state.failures++; state.firstFailureAt ??= now
        let failure: string | undefined
        if (!state.toldUnreadable && (state.failures >= 6 || now-state.firstFailureAt >= 86_400_000)) {
          failure = `I can't read ${new URL(state.url).host} any more: ${result.error}`; state.toldUnreadable = true
        }
        result.checked=true; result.failure=failure; this.save(botId,id,state); return {kind:'checked',...(failure ? {failure} : {})}
      }
      state.failures=0; state.firstFailureAt=undefined; state.toldUnreadable=false
      if (state.handedHash === null || state.handedHash === result.hash) {
        state.handedHash=result.hash!; state.result=undefined; this.save(botId,id,state); return {kind:'checked'}
      }
      // A complete file precedes the transaction. A failed insert leaves the result and old hash for retry.
      readFileSync(result.file!, 'utf8')
      this.save(botId,id,state)
      return {kind:'changed',prompt:`The page at ${state.url} changed since your last run; the new text is in ${result.file}.`,commit:() => {
        state.handedHash=result.hash!; state.result=undefined; this.save(botId,id,state)
      }}
    }
    if (state.inFlight) return {kind:'not_ready'}
    const flight: Flight = {key,generation,startedAt:now,token:randomUUID()}
    state.inFlight=flight; this.save(botId,id,state)
    const finish = (result: Result) => {
      // Late completions, including after removal or a timeout, never resurrect state.
      const latest = this.read(botId,id)
      if (latest?.inFlight?.token !== flight.token || latest.generation !== generation) return
      latest.inFlight=undefined; latest.result=result; this.save(botId,id,latest)
    }
    void publicFetch(state.url).then(response => {
      const current = this.read(botId,id)
      if (current?.inFlight?.token !== flight.token || current.generation !== generation) return
      const text=comparedText(response.body.toString('utf8'),state.contains)
      const dir=join(folder,'page-changes',id); mkdirSync(dir,{recursive:true})
      const file=join(dir,`${createHash('sha256').update(key).digest('hex')}-${flight.token}.txt`)
      writeFileSync(file,text)
      finish({flight,hash:createHash('sha256').update(text).digest('hex'),file})
    }).catch(error => { try { finish({flight,error:error instanceof Error ? error.message : String(error)}) } catch { /* A closed store recovers the in-flight check on restart. */ } })
    return {kind:'not_ready'}
  }
}
