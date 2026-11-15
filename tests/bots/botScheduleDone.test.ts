import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { appTurn } from '../run/appToolsFixture'
import { botFixture, chatOf, createBot, finish, start, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { reply: 'Hi.' }))
  await f.bots.reconcileOnStartup()
})
afterEach(() => { vi.restoreAllMocks(); f.close() })

async function scheduled() {
  const own = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check the price until it drops.' }, 'owner')
  const other = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Other check.' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  const running = await start(f, row.id)
  const ctx: ToolCallContext = {
    caller: { threadId: running.payload.threadId, runId: running.payload.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { turnToken: 't', ...appTurn({ threadId: running.payload.threadId, runId: running.payload.runId, bot: running.prepared.authority }) },
    toolCallId: 'done', signal: new AbortController().signal, transport: 'mcp'
  }
  const tool = botTools(() => ({ host: f.bots.tools })).find(tool => tool.name === 'schedule_done')!
  return { own, other, row, ...running, ctx, tool }
}

it.each(['Price is low.', '[SILENT]'])('ends only its own schedule and posts one quiet service line at report time (%s)', async text => {
  const s = await scheduled()
  expect(s.prepared.authority.appTools.has('schedule_done')).toBe(true)
  expect(s.tool).toBeDefined()
  expect(await s.tool.handler({ why: 'The price dropped.', scheduleId: s.other.scheduleId }, s.ctx)).not.toMatchObject({ isError: true })
  expect(await s.tool.handler({ why: 'Again.' }, s.ctx)).not.toMatchObject({ isError: true })
  expect(f.book.get(botId, s.own.scheduleId)).toBeUndefined()
  expect(f.book.get(botId, s.other.scheduleId)).toBeDefined()
  expect(f.bots.get(botId).summary.schedules!.map(row => row.id)).toEqual([s.other.scheduleId])
  expect(f.store.activation(s.row.id)!.trigger).toMatchObject({ completed: { why: 'The price dropped.' } })
  expect(chatOf(f, botId).filter(row => row.systemLine)).toHaveLength(0)
  await finish(f, s.payload, 'completed', { text })
  await f.bots.reconcileOnStartup()
  const lines = chatOf(f, botId).filter(row => row.systemLine)
  expect(lines).toHaveLength(1)
  expect(lines[0]!.text).toMatch(/^Stopped /)
  expect(lines[0]!.text).not.toContain('The price dropped.')
  if (text !== '[SILENT]') expect(chatOf(f, botId).some(row => row.kind === 'run_report' && row.text === text)).toBe(true)
  expect((await f.tickSchedules(new Date(T0 + 10 * 60_000))).inserted).toEqual([])
})

// Actors: chat, manual run, owner work, consult, subagent. Forged arguments never choose the schedule.
it.each(['chat', 'manual', 'work', 'context', 'subagent'])('refuses %s even when it calls the handler directly', async actor => {
  const s = await scheduled()
  const at = f.bots.tools.activationOf(s.payload.threadId)!
  if (actor === 'chat' || actor === 'manual' || actor === 'work') {
    f.store.run('UPDATE bot_activations SET lane = ?, trigger_json = ? WHERE id = ?', actor === 'chat' ? 'chat' : 'run', JSON.stringify({ kind: actor === 'chat' ? 'manual' : actor, input: 'Do it' }), s.row.id)
  } else {
    vi.spyOn(f.bots.tools, 'activationOf').mockReturnValue({ ...at, role: actor })
  }
  expect(s.tool).toBeDefined()
  expect(await s.tool.handler({ why: 'Done.' }, s.ctx)).toMatchObject({ isError: true })
  expect(f.book.list(botId)).toHaveLength(2)
})

it.each(['', 'x'.repeat(201), undefined])('refuses an invalid reason without ending the schedule', async why => {
  const s = await scheduled()
  expect(s.tool).toBeDefined()
  expect(await s.tool.handler({ why }, s.ctx)).toMatchObject({ isError: true })
  expect(f.book.list(botId)).toHaveLength(2)
})

it.each(['chat', 'manual', 'work'])('never offers schedule completion to %s turns', async actor => {
  let id: string
  if (actor === 'chat') {
    await f.bots.service.chatSend({ botId, text: 'Hi again', clientRequestId: 'chat' })
    id = f.store.laneActivations(botId, 'chat', ['running'])[0]!.id
  } else if (actor === 'manual') {
    id = (await f.bots.activate({ botId, input: 'Check once', clientRequestId: 'manual' })).id
  } else {
    await f.bots.service.chatSend({ botId, text: 'Check once', clientRequestId: 'chat' })
    const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    id = (await f.bots.tools.work.start(botId, chat.id, { title: 'Check', brief: 'Check once', key: 'work' })).workId
  }
  const { prepared } = await start(f, id)
  expect(prepared.authority.appTools.has('schedule_done')).toBe(false)
})

it('a retry completes removal if the shared scheduler failed after the intent was saved', async () => {
  const s = await scheduled()
  vi.spyOn(f.book, 'remove').mockImplementationOnce(() => { throw new Error('save failed') })
  expect(await s.tool.handler({ why: 'Finished.' }, s.ctx)).toMatchObject({ isError: true })
  expect(f.book.get(botId, s.own.scheduleId)).toBeDefined()
  expect(await s.tool.handler({ why: 'Retry.' }, s.ctx)).not.toMatchObject({ isError: true })
  expect(f.book.get(botId, s.own.scheduleId)).toBeUndefined()
})

