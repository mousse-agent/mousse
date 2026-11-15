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
