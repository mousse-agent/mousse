import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { appTurn } from '../run/appToolsFixture'
import { botFixture, chatOf, createBot, finish, start, flush, T0, type BotFixture } from './botFixture'

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
    caller: { threadId: running.payload.threadId, runId: running.payload.runId, provider: 'pi', accessLevel: 'lineage' },
    turn: { turnToken: 't', ...appTurn({ threadId: running.payload.threadId, runId: running.payload.runId, bot: running.prepared.authority }) },
    toolCallId: 'done', signal: new AbortController().signal, transport: 'mcp'
  }
  const tool = botTools(() => ({ host: f.bots.tools })).find(tool => tool.name === 'schedule_done')!
  return { own, other, row, ...running, ctx, tool }
}

it.each(['Price is low.', '[SILENT]'])('ends only its own schedule and posts one quiet service line at report time (%s)', async text => {
  const s = await scheduled()
  expect(s.prepared.authority.appTools.has('schedule_done')).toBe(true)
  expect(s.prepared.authority.check({ kind: 'app', tool: 'schedule_done', args: { why: 'Finished.' } })).toMatchObject({ ok: true })
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
  expect(f.store.message(lines[0]!.id)?.tell).toBeNull()
  expect(lines[0]!.text).not.toContain('The price dropped.')
  if (text !== '[SILENT]') expect(chatOf(f, botId).some(row => row.kind === 'run_report' && row.text === text)).toBe(true)
  expect((await f.tickSchedules(new Date(T0 + 10 * 60_000))).inserted).toEqual([])
})

// Actors: chat, manual run, owner work, consult, subagent. Forged arguments never choose the schedule.
it.each(['chat', 'manual', 'work', 'context', 'subagent'])('refuses %s even when it calls the handler directly', async actor => {
  const s = await scheduled()
  const at = f.bots.tools.activationOf(s.payload.threadId)!
  if (actor === 'chat' || actor === 'manual' || actor === 'work') {
    f.store.run('UPDATE bot_activations SET lane = ?, trigger_json = ?, provenance = NULL WHERE id = ?', actor === 'chat' ? 'chat' : 'run', JSON.stringify({ kind: actor === 'chat' ? 'manual' : actor, input: 'Do it' }), s.row.id)
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


it('startup finishes an intent left behind by failed shared-store removal', async () => {
  const s = await scheduled()
  vi.spyOn(f.book, 'remove').mockImplementationOnce(() => { throw new Error('save failed') })
  expect(await s.tool.handler({ why: 'Finished.' }, s.ctx)).toMatchObject({ isError: true })
  await f.bots.reconcileOnStartup()
  expect(f.book.get(botId, s.own.scheduleId)).toBeUndefined()
  expect(f.book.get(botId, s.other.scheduleId)).toBeDefined()
})

it('keeps Tell me on the final report when completion removes the schedule', async () => {
  const s = await scheduled()
  f.book.update(f.scheduler.getJob(s.own.jobId)!, { tellMe: 'needs_you' })
  const events: Array<{ message: { kind: string }; quiet?: true }> = []
  f.bots.events.on('message', event => events.push(event))
  f.automationRuns.report({ threadId: '', activationId: s.row.id }, 'fyi', 'Done.')
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  await finish(f, s.payload, 'completed', { text: 'Done.' })
  expect(events.find(event => event.message.kind === 'run_report')).toMatchObject({ quiet: true })
})

it('refuses ordinary threads even when they call the handler directly', async () => {
  const s = await scheduled()
  const ctx = { ...s.ctx, turn: { ...s.ctx.turn, bot: undefined } }
  expect(s.tool.offered?.(ctx.turn)).toBe(false)
  expect(await s.tool.handler({ why: 'Finished.' }, ctx)).toMatchObject({ isError: true })
  expect(f.book.list(botId)).toHaveLength(2)
})

// Review B9.1: continuations remain part of the executing run after its schedule ends.
it.each(['turn cap', 'restart', 'wall', 'owner removal'] as const)('keeps the report after %s', async path => {
  const s = await scheduled()
  if (path === 'owner removal') f.bots.removeSchedule(botId, s.own.scheduleId)
  else await s.tool.handler({ why: 'Reached the end condition.' }, s.ctx)
  if (path === 'restart') {
    f.runs.markTerminal(s.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await f.bots.reconcileOnStartup()
  } else if (path === 'wall') {
    f.bots.raiseWall(s.row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
    await f.bots.activate({ botId, input: 'Other work', clientRequestId: 'other' })
    expect(f.store.activation(s.row.id)!.status).toBe('waiting_grant')
    await finish(f, s.payload, 'completed', { text: 'Waiting for permission.' })
    const wall = f.bots.listEscalations(s.row.id).find(ask => ask.status === 'open')!
    await f.bots.respond({ escalationId: wall.id, answer: 'allow_once' })
  } else {
    await finish(f, s.payload, 'failed', { outcome: { error: '[provider_turn_cap] Claude Code reached the most steps one turn may take.' } })
  }
  expect(f.store.activation(s.row.id)!.status).toBe('running')
  const next = await start(f, s.row.id, 2)
  await finish(f, next.payload, 'completed', { text: 'Price is low.' })
  expect(chatOf(f, botId).some(row => row.kind === 'run_report' && row.text === 'Price is low.')).toBe(true)
  const lines = chatOf(f, botId).filter(row => row.systemLine)
  expect(lines).toHaveLength(path === 'owner removal' ? 0 : 1)
})

it('finishes startup and refuses completed schedules while the shared store cannot remove them', async () => {
  const s = await scheduled()
  vi.spyOn(f.book, 'remove').mockImplementation(() => { throw new Error('store is read only') })
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  await expect(f.bots.reconcileOnStartup()).resolves.toBeUndefined()
  expect(f.bots.findScheduledOccurrence({ botId, scheduleId: s.own.scheduleId, occurrenceKey: s.row.trigger.kind === 'schedule' ? s.row.trigger.occurrenceAt : '' })).toMatchObject({ kind: 'skipped', reason: 'schedule_completed' })
  expect(f.bots.runScheduledOccurrence({ botId, scheduleId: s.own.scheduleId, prompt: 'Do not run', occurrenceAt: new Date(T0 + 10 * 60_000).toISOString() })).toMatchObject({ kind: 'skipped', reason: 'schedule_completed' })
  await f.tickSchedules(new Date(T0 + 10 * 60_000))
  expect(f.book.get(botId, s.own.scheduleId)?.skip?.reason).toBe('schedule_completed')
  expect(f.bots.runScheduledOccurrence({ botId, scheduleId: s.other.scheduleId, prompt: 'Other check', occurrenceAt: new Date(T0 + 60 * 60_000).toISOString() }).kind).not.toBe('not_ready')
})

it('posts the report followed by one stopped line even when removal keeps failing', async () => {
  const s = await scheduled()
  vi.spyOn(f.book, 'remove').mockImplementation(() => { throw new Error('store is read only') })
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  await finish(f, s.payload, 'completed', { text: 'Price is low.' })
  const rows = chatOf(f, botId)
  const report = rows.findIndex(row => row.kind === 'run_report')
  const line = rows.findIndex(row => row.systemLine)
  expect(report).toBeGreaterThan(-1)
  expect(line).toBeGreaterThan(report)
  vi.restoreAllMocks()
  await f.bots.maintain()
  expect(f.book.get(botId, s.own.scheduleId)).toBeUndefined()
})

it.each(['failed', 'stopped'] as const)('posts one completion line when the run ends %s', async path => {
  const s = await scheduled()
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  if (path === 'failed') await finish(f, s.payload, 'failed', { outcome: { error: 'Provider failure' } })
  else await f.bots.stop(s.row.id)
  await flush()
  expect(chatOf(f, botId).filter(row => row.systemLine)).toHaveLength(1)
})

it('keeps a late final reply ahead of its completion line', async () => {
  const s = await scheduled()
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  await finish(f, s.payload)
  expect(chatOf(f, botId).some(row => row.systemLine)).toBe(false)
  f.bots.settle(s.payload, { text: 'Price is low.' })
  await flush()
  const rows = chatOf(f, botId)
  const report = rows.findIndex(row => row.kind === 'run_report' && row.text === 'Price is low.')
  expect(report).toBeGreaterThan(-1)
  expect(rows.findIndex(row => row.systemLine)).toBeGreaterThan(report)
})

it('startup still repairs running activations and delivers reminders when scheduler reads are locked', async () => {
  const s = await scheduled()
  await f.bots.service.chatSend({ botId, text: 'Remind me', clientRequestId: 'reminder-owner' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  f.bots.tools.reminders.add(botId, chat.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Drink water.' })
  f.clock.now += 120_000
  f.runs.markTerminal(s.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
  const list = vi.spyOn(f.book, 'list').mockImplementation(() => { throw new Error('jobs locked') })
  await expect(f.bots.reconcileOnStartup()).resolves.toBeUndefined()
  expect(f.store.dispatch(s.row.id, 2)).toBeDefined()
  expect(chatOf(f, botId).some(row => row.text.includes('Drink water.'))).toBe(true)
  list.mockRestore()
  await f.bots.maintain()
})

it('upkeep retries pending removals without rescanning all activations or repeating the warning', async () => {
  const s = await scheduled()
  vi.spyOn(f.book, 'remove').mockImplementation(() => { throw new Error('read only') })
  await s.tool.handler({ why: 'Done.' }, s.ctx)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const all = vi.spyOn(f.store, 'all')
  for (let i = 0; i < 3; i++) await f.bots.maintain()
  expect(all.mock.calls.filter(([sql]) => sql.includes("'$.completed'") && sql.includes('SELECT id'))).toHaveLength(0)
  expect(warn.mock.calls.filter(([message]) => message === 'a completed bot schedule could not be removed')).toHaveLength(1)
})

it('settles completion without a scheduler read from the merged progress hook', async () => {
  const s = await scheduled()
  await s.tool.handler({ why: 'Finished.' }, s.ctx)
  const finishProgress = vi.fn()
  f.host.progress = { finishProgress } as NonNullable<typeof f.host.progress>
  vi.spyOn(f.book, 'get').mockImplementation(() => { throw new Error('jobs locked') })
  await finish(f, s.payload, 'completed', { text: 'Price is low.' })
  expect(f.store.activation(s.row.id)!.status).toBe('done')
  expect(chatOf(f, botId).some(row => row.kind === 'run_report' && row.text === 'Price is low.')).toBe(true)
  expect(finishProgress).toHaveBeenCalledWith(botId, s.row.id, false)
})
