/** Two real daemons with fresh homes; only the bot port is scripted in this transport regression. */
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { newId } from '../../../../src/shared/net'
import type { BotChatMessage } from '../../../../src/shared/bots/personal/chat'
import { cleanupAll, cleanups, linked } from './routerFixture'

const BOT = 'bot-0123456789ab'
const ACTION = 'ba_00000000-0000-0000-0000-000000000000'
let t: Awaited<ReturnType<typeof linked>>
let message: BotChatMessage
beforeAll(async () => {
  t = await linked()
  const real = Object.getOwnPropertyDescriptor(t.owner, 'personalBots')
  const service = {
    get: () => ({ summary: { id: BOT, name: 'Mail' }, permissions: [], runs: [] }),
    chatList: () => ({ messages: [message], hasMore: false }),
    actionMessage: () => message
  }
  Object.defineProperty(t.owner, 'personalBots', { value: { service, events: new EventEmitter(), liveActivity: () => undefined }, configurable: true })
  cleanups.push(() => { if (real) Object.defineProperty(t.owner, 'personalBots', real) })
}, 120_000)
afterAll(async () => {
  await cleanupAll()
  console.info('botActionReplies: both isolated daemons stopped and temporary homes removed')
})

it('keeps a tool error outcome without its answer text when a device receives an oversized card', async () => {
  message = {
    id: 'bm_action_test', seq: 1, role: 'notice', text: 'x'.repeat(80_000), at: '2026-11-17T09:00:00Z',
    action: { actionId: ACTION, digest: 'a'.repeat(64), title: 'Send', serverName: 'Mail',
      args: { body: 'x'.repeat(80_000) }, hasHiddenValues: false, hiddenPaths: [], status: 'failed',
      result: { text: 'private tool answer', toolReportedError: true } }
  } as BotChatMessage
  const page = await t.caller.net.session(t.node).rpc('bots.chat.list', { botId: BOT }, { id: newId('rpc'), deadlineMs: 15_000 }) as { messages: BotChatMessage[] }
  expect(page.messages[0].action).toMatchObject({ status: 'failed', tooLarge: true, result: { toolReportedError: true } })
  expect(page.messages[0].action?.result).not.toHaveProperty('text')
  expect(JSON.stringify(page)).not.toContain('private tool answer')
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48 * 1024)
}, 60_000)
