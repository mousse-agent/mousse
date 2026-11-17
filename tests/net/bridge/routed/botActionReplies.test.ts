/** Two real daemons with fresh homes; only the bot port is scripted in this transport regression. */
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { newId } from '../../../../src/shared/net'
import type { BotChatMessage } from '../../../../src/shared/bots/personal/chat'
import { botFixture, createBot, type BotFixture } from '../../../bots/botFixture'
import { cleanupAll, cleanups, linked } from './routerFixture'

const BOT = 'bot-0123456789ab'
const ACTION = 'ba_00000000-0000-0000-0000-000000000000'
let t: Awaited<ReturnType<typeof linked>>
let message: BotChatMessage
let f: BotFixture
let realBot: string
let check = () => {}
let answer = vi.fn(async () => ({ status: 'declined' }))
beforeAll(async () => {
  t = await linked()
  f = botFixture()
  realBot = (await createBot(f, { name: 'Mail', reply: 'Hello' })).botId
  cleanups.push(() => f.close())
  const real = Object.getOwnPropertyDescriptor(t.owner, 'personalBots')
  const service = {
    get: () => ({ summary: { id: BOT, name: 'Mail' }, permissions: [], runs: [] }),
    chatList: () => ({ messages: [message], hasMore: false }),
    actionMessage: () => message,
    actionCheck: () => check(),
    answerAction: () => answer()
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

// Inputs: every definite held-action refusal, size, Work off, and a change after preflight.
const refusals = [
  ['changed', 'This changed since you saw it. Check it again before sending.'],
  ['paused', 'Resume Mail to send this.'],
  ['expired', 'This expired, so nothing was sent.'],
  ['withdrawn', 'No longer needed, so nothing was sent.'],
  ['settled', 'This was already answered.'],
  ['gone', "This can't be sent any more."],
  ['unreachable', "Mail couldn't be reached, so nothing was sent."]
] as const
const rpcAnswer = (choice = 'send') => t.caller.net.session(t.node).rpc('bots.actions.answer', {
  botId: BOT, actionId: ACTION, digest: 'a'.repeat(64), answer: choice
}, { id: newId('rpc'), idem: newId('rpc'), deadlineMs: 15_000 })

it.each(refusals)('reports %s before effects over a real link', async (reason, sentence) => {
  message = { ...message, text: 'Review', action: { ...message.action!, args: {} } }
  f.store.run('DELETE FROM bot_actions')
  f.store.setPaused(realBot, reason === 'paused' ? 'owner' : null)
  if (reason !== 'gone') {
    const status = ['expired', 'withdrawn'].includes(reason) ? reason : reason === 'settled' ? 'done' : reason === 'unreachable' ? 'failed' : 'open'
    f.store.run(`INSERT INTO bot_actions (id, call_key, bot_id, activation_id, lane, kind, target_json, args_json, args_digest, binding_json, status, expires_at, created_at, result_json)
      VALUES (?, ?, ?, 'missing-run', 'run', 'mcp', '{}', '{}', ?, '{}', ?, ?, ?, ?)`,
      ACTION, ACTION, realBot, 'b'.repeat(64), status, new Date(f.clock.now + 60_000).toISOString(), f.store.now(),
      reason === 'unreachable' ? JSON.stringify({ text: sentence, notSentInTime: true }) : null)
  }
  const input = { botId: realBot, actionId: ACTION, digest: 'a'.repeat(64), answer: 'send' as const }
  check = () => f.bots.service.actionCheck(input)
  answer = vi.fn(() => f.bots.service.answerAction(input))
  await expect(rpcAnswer()).rejects.toMatchObject({ code: 'conflict', message: sentence })
  expect(answer).not.toHaveBeenCalled()
}, 60_000)

it('refuses oversized Send before effects but allows Not now', async () => {
  check = () => {}
  message = { ...message, text: 'x'.repeat(80_000), action: { ...message.action!, args: { body: 'x'.repeat(80_000) } } }
  answer = vi.fn(async () => ({ status: 'declined' }))
  await expect(rpcAnswer()).rejects.toMatchObject({ code: 'conflict', message: 'Open it on the computer to send.' })
  expect(answer).not.toHaveBeenCalled()
  expect(await rpcAnswer('not_now')).toMatchObject({ status: 'declined' })
  expect(answer).toHaveBeenCalledTimes(1)
}, 60_000)

it('keeps Work off ahead of preflight for Send and Not now', async () => {
  let checked = 0
  check = () => { checked++ }
  answer.mockClear()
  await t.owner.net.request('bridge.policy', { node: t.callerNode, work: false })
  try {
    for (const choice of ['send', 'not_now']) await expect(rpcAnswer(choice)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'work_off' } })
    expect(checked).toBe(0)
    expect(answer).not.toHaveBeenCalled()
  } finally { await t.owner.net.request('bridge.policy', { node: t.callerNode, work: true }) }
}, 60_000)

it('keeps a failure after preflight uncertain', async () => {
  message = { ...message, text: 'Review', action: { ...message.action!, args: {} } }
  check = () => {}
  answer = vi.fn(async () => { throw Object.assign(new Error('Changed during dispatch'), { code: 'bot_action_changed' }) })
  await expect(rpcAnswer()).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(answer).toHaveBeenCalledTimes(1)
}, 60_000)
