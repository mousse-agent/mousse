import { existsSync } from 'node:fs'
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

it('removing a schedule drops a queued occurrence before a slot opens', async () => {
  const busy = []
  for (let i = 0; i < 3; i++) busy.push(await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` }))
  const own = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const queued = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  expect(queued.status).toBe('queued')
  f.bots.removeSchedule(botId, own.scheduleId)
  const first = await start(f, busy[0]!.id)
  await finish(f, first.payload, 'completed', { text: 'Done.' })
  expect(f.store.activation(queued.id)!.status).toBe('cancelled')
  expect(f.store.dispatches(queued.id)).toHaveLength(0)
})

// Removal paths and states: About, bot tool host, Automations; queued, waiting at a wall,
// parked, paused, already running; deletion of the bot; a restart between the two stores.
it.each(['about', 'bot', 'automations'])('%s removal cancels queued work quietly and leaves other schedules alone', async actor => {
  for (let i = 0; i < 3; i++) await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` })
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  const b = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'B' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const own = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule' && row.trigger.scheduleId === a.scheduleId)!
  const before = chatOf(f, botId).length
  // The profile forwards shared-store edits to this hook, also for Automations removals.
  f.scheduler.on('updated', () => f.bots.schedulesEdited(botId))
  if (actor === 'about') f.bots.service.removeSchedule(botId, a.scheduleId)
  else if (actor === 'bot') f.bots.tools.schedules.remove(botId, a.scheduleId)
  else f.scheduler.deleteJob(a.jobId)
  expect(f.store.activation(own.id)).toMatchObject({ status: 'cancelled', endReason: 'schedule_removed' })
  expect(f.book.get(botId, b.scheduleId)).toBeDefined()
  expect(chatOf(f, botId)).toHaveLength(before)
  expect(f.store.registry(botId)!.pausedReason).toBeNull()
})

it.each(['waiting_grant', 'blocked', 'paused'] as const)('removal ends a %s run without another dispatch', async status => {
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write' })
  if (status !== 'waiting_grant') f.store.moveActivation(row.id, ['waiting_grant'], status)
  f.bots.removeSchedule(botId, a.scheduleId)
  await f.bots.maintain()
  expect(f.store.activation(row.id)).toMatchObject({ status: 'cancelled', endReason: 'schedule_removed' })
  expect(f.store.escalations({ activationId: row.id, status: 'open' })).toHaveLength(0)
  expect(f.store.dispatches(row.id)).toHaveLength(1)
  expect(chatOf(f, botId).filter(row => row.kind === 'error')).toHaveLength(0)
})

it('a turn already running finishes its report after removal', async () => {
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  const turn = await start(f, row.id)
  f.bots.removeSchedule(botId, a.scheduleId)
  expect(f.store.activation(row.id)!.status).toBe('running')
  await finish(f, turn.payload, 'completed', { text: 'Finished.' })
  expect(f.store.activation(row.id)!.status).toBe('done')
  expect(chatOf(f, botId).some(row => row.kind === 'run_report' && row.text === 'Finished.')).toBe(true)
})

it('startup drops work left queued when only the shared-store removal committed', async () => {
  for (let i = 0; i < 3; i++) await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` })
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  f.scheduler.deleteJob(a.jobId)
  await f.bots.reconcileOnStartup()
  expect(f.store.activation(row.id)).toMatchObject({ status: 'cancelled', endReason: 'schedule_removed' })
  expect(f.store.dispatches(row.id)).toHaveLength(0)
})

it('deleting the bot also cancels its queued schedule work', async () => {
  for (let i = 0; i < 3; i++) await f.bots.activate({ botId, input: 'Busy', clientRequestId: `busy-${i}` })
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  await f.bots.remove(botId)
  expect(f.store.activation(row.id)).toMatchObject({ status: 'cancelled', endReason: 'bot_deleted' })
  expect(f.store.dispatches(row.id)).toHaveLength(0)
})

it('cancelling waiting schedule work takes the normal end path', async () => {
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  const turn = await start(f, row.id)
  f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
  const browser = vi.fn()
  f.host.browser = { activationEnded: browser } as NonNullable<typeof f.host.browser>
  const changed = vi.fn()
  f.host.changed = changed
  f.bots.removeSchedule(botId, a.scheduleId)
  expect(f.journal.some(event => event.kind === 'run_end' && event.activationId === row.id && event.text === 'schedule_removed')).toBe(true)
  expect(browser).toHaveBeenCalledWith({ botId, activationId: row.id })
  expect(existsSync(turn.prepared.scratch)).toBe(false)
  expect(changed).toHaveBeenCalledWith({ botId, activationId: row.id })
})

it('starting unrelated work does not read the shared scheduler under the bot transaction', async () => {
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'A' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const row = f.store.listActivations(botId).find(row => row.trigger.kind === 'schedule')!
  f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
  const get = vi.spyOn(f.book, 'get')
  await f.bots.activate({ botId, input: 'Other work', clientRequestId: 'other' })
  expect(get).not.toHaveBeenCalled()
  expect(f.book.list(botId).some(entry => entry.scheduleId === a.scheduleId)).toBe(true)
})
