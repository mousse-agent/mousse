import { lstatSync, readdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { removePageChange } from './pageChangeFiles'
import { publicFetch, publicUrl } from '../net-public/publicFetch'
import { htmlToText } from '../orchestrator/WebTools'
import type { BotStore } from './store/BotStore'
export interface PageSetting { url: string; contains?: string }
interface Flight { key: string; generation: string; startedAt: number; token: string }
interface Result { flight: Flight; hash?: string; text?: string; error?: string; checked?: boolean; failure?: string }
interface State extends PageSetting { generation: string; handedHash: string | null; inFlight?: Flight; result?: Result; failures: number; firstFailureAt?: number; toldUnreadable: boolean }
export function pageSetting(value: PageSetting): PageSetting {
  const url = publicUrl(value.url)
  if (value.contains !== undefined && (typeof value.contains !== 'string' || value.contains.length > 200)) throw new Error('contains is plain text up to 200 characters.')
  return { url: url.href, ...(value.contains !== undefined ? { contains: value.contains } : {}) }
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
    this.save(botId,id,{url:setting.url,...(setting.contains !== undefined ? {contains:setting.contains} : {}),generation,handedHash:null,failures:0,toldUnreadable:false})
  }
  remove(botId: string, id: string): void {
    this.store.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?',botId,`pagecheck:${id}`) }
  sweep(exists: (botId: string, id: string) => boolean | undefined): void {
    for (const row of this.store.all("SELECT bot_id,key FROM bot_memory_state WHERE key LIKE 'pagecheck:%'"))
      if (exists(String(row.bot_id),String(row.key).slice(10)) === false) this.remove(String(row.bot_id),String(row.key).slice(10))
  }
  cleanupOrphanFiles(): void {
    const root = join(this.store.directory, 'scratch')
    try {
      if (!lstatSync(root).isDirectory()) throw new Error('Invalid run root.')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of readdirSync(root, { withFileTypes:true })) {
      if (entry.isDirectory() && /^act_[a-zA-Z0-9_-]+$/.test(entry.name) && !this.store.activation(entry.name)) removePageChange(root, entry.name)
    }
  }
  recoverFlights(): void {
    for (const row of this.store.all("SELECT bot_id,key,value FROM bot_memory_state WHERE key LIKE 'pagecheck:%'")) {
      const state = JSON.parse(String(row.value)) as State
      if (!state.inFlight) continue
      state.inFlight = undefined
      this.save(String(row.bot_id), String(row.key).slice(10), state)
    }
  }
  check(botId: string, id: string, generation: string, key: string, now: number, folder: string):
    | { kind:'not_ready' } | { kind:'checked'; failure?: string; reportSaved?: () => void } | { kind:'changed'; text:string; url:string; commit: () => void } | undefined {
    const state = this.read(botId,id)
    if (!state) return undefined
    if (state.generation !== generation) { this.set(botId,id,state,generation); return this.check(botId,id,generation,key,now,folder) }
    if (state.result && (state.result.flight.key !== key || state.result.flight.generation !== generation)) state.result = undefined
    if (state.inFlight && (state.inFlight.key !== key || state.inFlight.generation !== generation)) state.inFlight = undefined
    if (state.inFlight && now - state.inFlight.startedAt > 120_000) {
      state.inFlight = undefined
    }
    if (state.result) {
      const result = state.result
      const checked = () => ({ kind:'checked' as const, ...(result.failure ? { failure:result.failure, reportSaved:() => {
        const latest = this.read(botId,id)
        if (latest?.result?.flight.token !== result.flight.token) return
        latest.toldUnreadable = true
        this.save(botId,id,latest)
      } } : {}) })
      if (result.checked) return checked()
      if (result.error) {
        state.failures++; state.firstFailureAt ??= now
        let failure: string | undefined
        if (!state.toldUnreadable && (state.failures >= 6 || now-state.firstFailureAt >= 86_400_000)) {
          const reason = result.error.replace(/^The page /, 'it ')
          failure = `I can't read ${new URL(state.url).host} any more: ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/[.]+$/, '')}.`
        }
        result.checked=true; result.failure=failure; this.save(botId,id,state); return checked()
      }
      state.failures=0; state.firstFailureAt=undefined; state.toldUnreadable=false
      if (state.handedHash === null || state.handedHash === result.hash) {
        state.handedHash=result.hash!; state.result=undefined; this.save(botId,id,state); return {kind:'checked'}
      }
      // Text remains in the profile-owned database until the run takes it atomically.
      if (result.text === undefined) { state.result=undefined; this.save(botId,id,state); return this.check(botId,id,generation,key,now,folder) }
      this.save(botId,id,state)
      return {kind:'changed',text:result.text,url:state.url,commit:() => {
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
      finish({flight,hash:createHash('sha256').update(text).digest('hex'),text})
    }).catch(error => { try { finish({flight,error:error instanceof Error ? error.message : String(error)}) } catch { /* A closed store recovers the in-flight check on restart. */ } })
    return {kind:'not_ready'}
  }
}
