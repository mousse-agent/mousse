import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as fetcher from '../../src/mms/net-public/publicFetch'
import { botFixture, createBot, T0, flush, type BotFixture } from './botFixture'
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
