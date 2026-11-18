import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writePageChange } from '../../src/mms/bots/pageChangeFiles'
import * as fetcher from '../../src/mms/net-public/publicFetch'
import { botFixture, createBot, T0, flush, runDispatch, type BotFixture } from './botFixture'
let f: BotFixture, botId: string
let body = 'old page'
beforeEach(async () => {
  body = 'old page'
  vi.spyOn(fetcher, 'publicFetch').mockImplementation(async () => ({ status:200, headers:{}, body:Buffer.from(body) }))
  f = botFixture(); ({botId} = await createBot(f, {name:'Page reader',reply:'Hi.'}))
})
afterEach(() => { f.close(); vi.restoreAllMocks() })
const runs = () => f.store.listActivations(botId).filter(r => r.trigger.kind === 'schedule')
const state = (id: string) => f.store.get<{value:string}>('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?',botId,`pagecheck:${id}`)
async function add(contains?: string) {
  const entry = f.bots.addSchedule(botId,{when:{kind:'interval',minutes:5},prompt:'Tell me when it changes.',onlyIfChanged:{url:'https://example.com/tickets',...(contains ? {contains} : {})}},'owner')
  await f.bots.reconcileOnStartup(); return entry
}
async function check(min: number) {
  const at = new Date(T0+min*60_000)
  await f.tickSchedules(at); await flush(); return f.tickSchedules(at)
}
it('records the first page quietly; unchanged checks leave no activation or scheduler run state; a change names the saved text',async () => {
  const entry = await add()
  await check(5); await check(10)
  expect(runs()).toEqual([])
  const job = f.scheduler.getJob(entry.jobId)!
  expect(job.botSkip).toBeUndefined(); expect(job.lastRunAt).toBeUndefined(); expect(job.lastStatus).toBeUndefined()
  body = 'new page'
  await check(15)
  expect(runs()).toHaveLength(1)
  const trigger = runs()[0]!.trigger
  if(trigger.kind !== 'schedule') throw Error('schedule expected')
  const file = trigger.input.match(/new text is in (.+)\./)![1]!
  expect(readFileSync(file,'utf8')).toBe('new page')
  await check(15); expect(runs()).toHaveLength(1)
})
it('removes the check state with the schedule',async () => {
  const entry = await add(); expect(state(entry.scheduleId)).toBeDefined()
  f.bots.removeSchedule(botId,entry.scheduleId); expect(state(entry.scheduleId)).toBeUndefined()
})
it('rejects a fixed line with a page check',() => {
  expect(() => f.bots.addSchedule(botId,{when:{kind:'interval',minutes:5},say:'Hello',onlyIfChanged:{url:'https://example.com'}},'owner')).toThrow(/say/)
})
it('compares only the case-insensitive window, including absent text becoming present',async () => {
  body = 'nothing'; await add('tickets'); await check(5)
  body = 'different but absent'; await check(10); expect(runs()).toHaveLength(0)
  body = 'Tickets available'; await check(15); expect(runs()).toHaveLength(1)
})
it('drops an old fetch when the schedule is edited and records the edited baseline',async () => {
  let resolve!: (r: fetcher.PublicResponse) => void
  vi.mocked(fetcher.publicFetch).mockImplementationOnce(() => new Promise(r => {resolve=r}))
  const entry = await add(); await f.tickSchedules(new Date(T0+5*60_000))
  f.book.update(f.scheduler.getJob(entry.jobId)!,{prompt:'Different instructions'})
  resolve({status:200,headers:{},body:Buffer.from('stale')}); await flush()
  await check(10); expect(runs()).toHaveLength(0)
  expect(JSON.parse(state(entry.scheduleId)!.value).handedHash).not.toBeNull()
})
it('rolls back the handed hash if activation insertion fails and retries the same change',async () => {
  const entry=await add(); await check(5); const baseline=JSON.parse(state(entry.scheduleId)!.value).handedHash
  body='changed'; await f.tickSchedules(new Date(T0+10*60_000)); await flush()
  const insert=vi.spyOn(f.store,'insertActivationOnce').mockImplementationOnce(() => {throw new Error('crash before transaction commits')})
  await f.tickSchedules(new Date(T0+10*60_000))
  expect(runs()).toHaveLength(0); expect(JSON.parse(state(entry.scheduleId)!.value).handedHash).toBe(baseline)
  insert.mockRestore()
  // A scheduler crash before finishing its claim replays that occurrence.
  f.bots.runScheduledOccurrence({botId,scheduleId:entry.scheduleId,prompt:entry.prompt,occurrenceAt:new Date(T0+10*60_000).toISOString()})
  await flush(); expect(runs()).toHaveLength(1)
  f.bots.runScheduledOccurrence({botId,scheduleId:entry.scheduleId,prompt:entry.prompt,occurrenceAt:new Date(T0+10*60_000).toISOString()})
  expect(runs()).toHaveLength(1)
})
it('six failures report once in chat and the failed-run ledger, and success clears the streak quietly',async () => {
  const entry=await add()
  vi.mocked(fetcher.publicFetch).mockRejectedValue(new Error('The page returned HTTP 403.'))
  for(let i=1;i<=8;i++) await check(i*5)
  expect(f.store.messages(botId,{limit:100}).filter(m=>m.text.includes("I can't read"))).toHaveLength(1)
  expect(f.automationRuns.list().runs.filter(r=>r.botId===botId)).toHaveLength(1)
  expect(f.automationRuns.list().runs.find(r=>r.botId===botId)?.state).toBe('failed')
  vi.mocked(fetcher.publicFetch).mockResolvedValue({status:200,headers:{},body:Buffer.from('readable')})
  await check(45)
  expect(JSON.parse(state(entry.scheduleId)!.value)).toMatchObject({failures:0,toldUnreadable:false})
})
it('times out a persisted in-flight check after restart and ignores its late response',async () => {
  const entry=await add()
  vi.mocked(fetcher.publicFetch).mockImplementationOnce(() => new Promise(() => {}))
  await f.tickSchedules(new Date(T0+5*60_000)); await f.tickSchedules(new Date(T0+8*60_000))
  expect(JSON.parse(state(entry.scheduleId)!.value).failures).toBe(1)
})
it('names the page in the returned and About labels',async () => {
  const entry=await add()
  expect(entry.label).toContain('runs when example.com changes')
  expect(f.bots.listSchedules(botId)[0]!.label).toContain('runs when example.com changes')
  expect(f.bots.service.automationFacts(botId,entry.scheduleId)?.whenText).toContain('runs when example.com changes')
})
it('a late pre-edit fetch cannot overwrite the new generation snapshot',async () => {
  let old!: (r:fetcher.PublicResponse)=>void
  const entry=await add(); await check(5)
  vi.mocked(fetcher.publicFetch).mockImplementationOnce(()=>new Promise(r=>{old=r}))
  const at=new Date(T0+10*60_000)
  await f.tickSchedules(at)
  f.book.update(f.scheduler.getJob(entry.jobId)!,{prompt:'Updated'})
  body='new baseline'; await f.tickSchedules(at); await flush()
  const current=JSON.parse(state(entry.scheduleId)!.value)
  expect(current.result.text).toBe('new baseline')
  old({status:200,headers:{},body:Buffer.from('stale response')}); await flush()
  expect(JSON.parse(state(entry.scheduleId)!.value).result.text).toBe('new baseline')
  expect(JSON.parse(state(entry.scheduleId)!.value).generation).toBe(current.generation)
})
it('ignores edits outside the 4000-character match window and keeps the whole compared text',async () => {
  body='a'.repeat(5000)+'Tickets'+'b'.repeat(5000)
  await add('tickets'); await check(5)
  body='outside'+body.slice(7); await check(10); expect(runs()).toHaveLength(0)
  body=body.replace('Tickets','Tickets open'); await check(15)
  const trigger=runs()[0]!.trigger
  if(trigger.kind!=='schedule') throw Error('expected schedule')
  const text=readFileSync(trigger.input.match(/new text is in (.+)\./)![1]!,'utf8')
  expect(text).toHaveLength(4000); expect(text).toContain('Tickets open'); expect(text).not.toContain('outside')
})
it('reports a day of failures before six attempts, and removes orphan state on startup',async () => {
  const entry=await add()
  vi.mocked(fetcher.publicFetch).mockRejectedValue(new Error('unavailable'))
  await check(5); await check(1450)
  expect(f.store.messages(botId,{limit:100}).filter(m=>m.text.includes("I can't read"))).toHaveLength(1)
  f.store.run("INSERT INTO bot_memory_state(bot_id,key,value) VALUES(?,?,?)",botId,'pagecheck:gone',state(entry.scheduleId)!.value)
  await f.bots.reconcileOnStartup(); expect(state('gone')).toBeUndefined()
})
it('keeps the watched URL in the saved prompt for older builds',async()=>{
  const entry=await add('tickets')
  expect(f.scheduler.getJob(entry.jobId)!.prompt).toContain('https://example.com/tickets')
  expect(f.scheduler.getJob(entry.jobId)!.prompt).toContain('tickets')
})

it('six unchanged checks leave no page files and no inbox rows',async()=>{
  await add()
  for(let i=1;i<=6;i++) await check(i*5)
  const files=readdirSync(f.bots.filesFolder(botId),{recursive:true})
  expect(files.filter(p=>String(p).endsWith('.txt'))).toEqual([])
  expect(f.automationRuns.list().runs).toEqual([])
})
it('change files belong to the run and are removed from Automations',async()=>{
  const entry=await add(); await check(5); body='new page'; await check(10)
  const row=runs()[0]!
  const file=join(f.store.directory,'scratch',row.id,'page-change.txt')
  expect(readFileSync(file,'utf8')).toBe('new page')
  f.scheduler.deleteJob(entry.jobId)
  expect(existsSync(file)).toBe(false)
  expect(state(entry.scheduleId)).toBeUndefined()
})
it('a symlink in the run directory cannot redirect the page write',()=>{
  const root=join(f.store.directory,'scratch'), outside=join(f.store.directory,'outside')
  mkdirSync(root,{recursive:true}); mkdirSync(outside)
  symlinkSync(outside,join(root,'planted'),'dir')
  expect(()=>writePageChange(root,'planted','hostile')).toThrow()
  expect(readdirSync(outside)).toEqual([])
  mkdirSync(join(root,'leaf'))
  const target=join(outside,'target.txt')
  symlinkSync(target,join(root,'leaf','page-change.txt'))
  expect(()=>writePageChange(root,'leaf','hostile')).toThrow()
  expect(existsSync(target)).toBe(false)
})

it('deletes the change file when its run ends',async()=>{
  await add(); await check(5); body='changed'; await check(10)
  const row=runs()[0]!, file=join(f.store.directory,'scratch',row.id,'page-change.txt')
  expect(existsSync(file)).toBe(true)
  await runDispatch(f,row.id)
  expect(existsSync(file)).toBe(false)
})
