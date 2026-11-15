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
