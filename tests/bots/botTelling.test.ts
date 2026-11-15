import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, createBot, type BotFixture } from './botFixture'
let f: BotFixture
let botId: string
beforeEach(async () => { f = botFixture(); await f.bots.reconcileOnStartup(); ({ botId } = await createBot(f)) })
afterEach(() => f.close())
// Inputs: owner, reply, service line, unattended reply, report, failure, offline, dropped schedules.
it('keeps a class and due time in the post transaction', () => {
  for (const [patch, tell] of [
    [{ author: 'owner' }, null],
    [{}, 'soon'],
    [{ id: 'bm_permission_test', kind: 'notice' }, null],
    [{ id: 'bm_x_offline', kind: 'notice' }, 'later'],
    [{ id: 'bm_x_sched_dropped_today', kind: 'error' }, 'later'],
    [{ kind: 'error', error: { text: 'Failed' } }, 'soon'],
    [{ kind: 'run_report' }, 'soon']
  ] as const) {
    const message = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Update', ...patch })
    expect(f.store.message(message.id)).toMatchObject({ tell, tellAt: tell ? f.store.now() : null })
  }
})

it('releases due unread rows once and keeps read rows silent', async () => {
  const events: unknown[] = []
  f.bots.events.on('tell', e => events.push(e))
  f.bots.setTellingWindows(1)
  const m = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Hello\nprivate second line' })
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ body: 'Hello', sound: true, rows: [{ botId, messageId: m.id, tell: 'soon' }] })
  expect(f.store.message(m.id)?.toldAt).toBe(f.store.now())
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(1)
  const read = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Already read' })
  f.bots.markRead(botId, read.seq)
  events.length = 0
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(0)
  expect(f.store.message(read.id)?.toldAt).toBeTruthy()
})
