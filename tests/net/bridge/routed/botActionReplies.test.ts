import { legacyRemoteError, legacyWireError } from './legacyActionErrors'
import { botActionRefusal } from '../../../../src/shared/bots/personal/actionRefusal'
/** Two real daemons with fresh homes; only the bot port is scripted in this transport regression. */
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { NetError, newId, type WireMessage } from '../../../../src/shared/net'
import { validateWireMessage } from '../../../../src/shared/net/schemas'
import type { BotChatMessage } from '../../../../src/shared/bots/personal/chat'
import { botFixture, createBot, type BotFixture } from '../../../bots/botFixture'
import { cleanupAll, cleanups, linked } from './routerFixture'

const BOT = 'bot-0123456789ab'
const ACTION = 'ba_00000000-0000-0000-0000-000000000000'
let t: Awaited<ReturnType<typeof linked>>
let message: BotChatMessage
let f: BotFixture
let realBot: string
let daemonHomes: string[] = []
let sent: WireMessage[] = []
let check = () => {}
let answer = vi.fn(async () => ({ status: 'declined' }))
beforeAll(async () => {
  const create = vi.spyOn(MousseMainService, 'create')
  try { t = await linked() } finally {
    daemonHomes = create.mock.calls.map(([options]) => options!.homeDir!)
    create.mockRestore()
  }
  const session = t.owner.net.session(t.callerNode) as unknown as { send(header: WireMessage, ...rest: unknown[]): Promise<void> }
  const send = session.send.bind(session)
  const spy = vi.spyOn(session, 'send').mockImplementation((header, ...rest) => { sent.push(header); return send(header, ...rest) })
  cleanups.push(() => spy.mockRestore())
  expect(daemonHomes).toHaveLength(2)
  for (const home of daemonHomes) expect(home.startsWith(join(tmpdir(), 'bridge-router-'))).toBe(true)
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
  // A bot reaches only its own computer until the owner adds a device to its Devices: the calling device is added.
  t.owner.botDeviceAccess.set(BOT, { mode: 'chosen', nodes: [t.callerNode] })
  cleanups.push(() => { if (real) Object.defineProperty(t.owner, 'personalBots', real) })
}, 120_000)
afterAll(async () => {
  await cleanupAll()
  for (const home of daemonHomes) expect(existsSync(home)).toBe(false)
  console.info('botActionReplies: both isolated daemons stopped and temporary homes verified removed')
})

it('keeps a tool error outcome without its answer text when a device receives an oversized card', async () => {
  message = {
    id: 'bm_action_test', seq: 1, author: 'bot', kind: 'notice', chips: [], text: 'x'.repeat(80_000), at: '2026-11-17T09:00:00Z',
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
  ['work_ended', 'This work ended. Nothing was sent.'],
  ['owner_paused', 'This bot was paused, so nothing was sent.'],
  ['permission_changed', 'This tool or its permission changed, so nothing was sent.'],
  ['disabled', 'Withdrawn when asks first was turned off. Nothing was sent.'],
  ['owner_removed', 'You removed this request, so nothing was sent.'],
  ['binding_changed', 'This changed since you saw it. Nothing was sent.'],
  ['schedule_changed', 'This changed since you saw it. Nothing was sent.'],
  ['settled', 'This was already answered.'],
  ['gone', "This can't be sent any more."],
  ['timed_out', "This can't be sent any more."]
] as const
const rpcAnswer = (choice = 'send') => t.caller.net.session(t.node).rpc('bots.actions.answer', {
  botId: BOT, actionId: ACTION, digest: 'a'.repeat(64), answer: choice
}, { id: newId('rpc'), idem: newId('rpc'), deadlineMs: 15_000 })

it.each(refusals)('reports %s before effects over a real link', async (reason, sentence) => {
  message = { ...message, text: 'Review', action: { ...message.action!, args: {} } }
  f.store.run('DELETE FROM bot_actions')
  f.store.setPaused(realBot, reason === 'paused' ? 'owner' : null)
  if (reason !== 'gone') {
    const withdrawn = ['schedule_changed', 'work_ended', 'owner_paused', 'permission_changed', 'disabled', 'owner_removed', 'binding_changed'].includes(reason)
    const status = withdrawn ? 'withdrawn' : ['expired', 'withdrawn'].includes(reason) ? reason : reason === 'settled' ? 'done' : reason === 'timed_out' ? 'failed' : 'open'
    f.store.run(`INSERT INTO bot_actions (id, call_key, bot_id, activation_id, lane, kind, target_json, args_json, args_digest, binding_json, status, expires_at, created_at, result_json, card_json)
      VALUES (?, ?, ?, 'missing-run', 'run', 'mcp', '{}', '{}', ?, '{}', ?, ?, ?, ?, ?)`,
      ACTION, ACTION, realBot, 'b'.repeat(64), status, new Date(f.clock.now + 60_000).toISOString(), f.store.now(),
      reason === 'timed_out' ? JSON.stringify({ text: sentence, notSentInTime: true }) : withdrawn ? JSON.stringify({ text: sentence }) : null, withdrawn ? JSON.stringify({ withdrawalCode: `bot_action_${reason}` }) : null)
  }
  const input = { botId: realBot, actionId: ACTION, digest: 'a'.repeat(64), answer: 'send' as const }
  check = () => f.bots.service.actionCheck(input)
  answer = vi.fn(() => f.bots.service.answerAction(input))
  sent = []
  const error = await rpcAnswer().catch(error => error)
  const refusalCode = reason === 'timed_out' ? 'bot_action_gone' : `bot_action_${reason}`
  expect(error).toMatchObject({ code: 'conflict', details: { reason: refusalCode } })
  const frame = sent.find(header => header.t === 'rpc.result' && 'error' in header)
  expect(frame).toMatchObject({ error: { code: 'conflict', message: new NetError('conflict').message,
    cause: [{ code: `application.${refusalCode}`, message: new NetError('conflict').message }] } })
  expect(botActionRefusal(error, { botName: 'Mail', serverName: message.action!.serverName })?.text).toBe(sentence)
  expect(error.message).not.toBe(sentence)
  expect(answer).not.toHaveBeenCalled()
}, 60_000)

it('refuses oversized Send before effects but allows Not now', async () => {
  check = () => {}
  message = { ...message, text: 'x'.repeat(80_000), action: { ...message.action!, args: { body: 'x'.repeat(80_000) } } }
  answer = vi.fn(async () => ({ status: 'declined' }))
  const error = await rpcAnswer().catch(error => error)
  expect(error).toMatchObject({ code: 'conflict', details: { reason: 'bot_action_too_large' } })
  expect(botActionRefusal(error)?.text).toBe('Open it on the computer to send.')
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

it('keeps arbitrary engine error text off the wire', async () => {
  check = () => { throw Object.assign(new Error('private tool answer'), { code: 'bot_action_paused' }) }
  await expect(rpcAnswer()).rejects.toMatchObject({ code: 'conflict', details: { reason: 'bot_action_paused' } })
}, 60_000)

it('new computer refusals remain a generic conflict for the older device decoder', async () => {
  sent = []
  check = () => { throw Object.assign(new Error('DO NOT SEND THIS NAME'), { code: 'bot_action_paused' }) }
  await expect(rpcAnswer()).rejects.toMatchObject({ code: 'conflict', details: { reason: 'bot_action_paused' } })
  const response = sent.find(header => header.t === 'rpc.result' && 'error' in header)
  expect(response).toBeTruthy()
  expect(validateWireMessage(response)).toBe(true)
  if (response?.t !== 'rpc.result' || !('error' in response)) throw new Error('Missing refusal')
  // Execute the frozen prior decoder against the actual new computer response.
  const olderDevice = legacyRemoteError(response.error)
  expect(olderDevice.code).toBe('conflict')
  expect(olderDevice.message).toBe(new NetError('conflict').message)
  expect(response.error.message).toBe(new NetError('conflict').message)
  expect(response.error.cause).toEqual([{ code: 'application.bot_action_paused', message: new NetError('conflict').message }])
  expect(JSON.stringify(response)).not.toContain('DO NOT SEND THIS NAME')
  expect(JSON.stringify(response)).not.toContain('Mail')
  expect(t.caller.net.session(t.node).state()).toBe('open')
}, 60_000)

it('an older computer preflight conflict remains definite on a newer device', async () => {
  sent = []
  const legacyError = new NetError('conflict')
  check = () => { throw legacyError }
  answer.mockClear()
  const error = await rpcAnswer().catch(error => error)
  expect(error).toMatchObject({ code: 'conflict' })
  const response = sent.find(header => header.t === 'rpc.result' && 'error' in header)
  expect(response).toMatchObject({ error: legacyWireError(legacyError) })
  expect(botActionRefusal(error)?.text).toBe('This could not be sent from here. Open it on the computer to see what happened.')
  expect(answer).not.toHaveBeenCalled()
  expect(t.caller.net.session(t.node).state()).toBe('open')
}, 60_000)

it.each(['ready', 'unreachable', 'changed'] as const)('cold admission over the bridge remains definite: %s', async state => {
  // Real BotActions and bridge; only the service listing and tool transport are scripted.
  const { BotActions } = await import('../../../../src/mms/bots/actions/BotActions')
  f.store.run('DELETE FROM bot_actions')
  let cold = false
  let schema = 1
  const calls: unknown[] = []
  const actions = new BotActions({ store: f.store, enabled: () => true, name: () => 'Mail',
    refresh: async () => { if (state !== 'unreachable') { cold = false; if (state === 'changed') schema = 2 } },
    park: () => {}, lifetime: () => 3600_000, origin: () => 'owner', schema: () => ({}),
    binding: () => cold ? undefined : { schema }, obsolete: () => false,
    post: () => {}, settled: () => {}, publish: () => {}, ownerAnswered: () => {}, held: () => {}, forgottenRequest: () => {},
    execute: async (_row, _tool, args) => { calls.push(args); return { text: 'delivered' } }
  })
  const row = f.store.listActivations(realBot)[0]!
  actions.hold(row, 'bridge-dispatch', { server: 'mail', tool: 'send', serverName: 'Mail' } as never, { to: 'one@example.test' }, 'bridge-call')
  const a = actions.forWork(row.id)!
  f.store.run('UPDATE bot_actions SET id = ? WHERE id = ?', ACTION, a.id)
  message = { ...message, action: { ...message.action!, actionId: ACTION, digest: a.args_digest, args: {}, status: 'open' } }
  const input = { actionId: ACTION, digest: a.args_digest, answer: 'send' as const }
  check = () => actions.check(input)
  answer = vi.fn(() => actions.answer(input))
  const tap = () => t.caller.net.session(t.node).rpc('bots.actions.answer', { botId: BOT, ...input }, { id: newId('rpc'), idem: newId('rpc'), deadlineMs: 15_000 })
  cold = true
  const first = await tap().catch(error => error)
  expect(first).toMatchObject({ code: 'conflict', details: { reason: 'bot_action_unreachable' } })
  expect(first.message).not.toContain('partly happened')
  expect(botActionRefusal(first, { serverName: 'Mail' })?.text).toBe("Mail couldn't be reached. Nothing was sent. Try again when it is available.")
  expect(answer).not.toHaveBeenCalled()
  expect(actions.get(ACTION)?.status).toBe('open')
  if (state === 'ready') {
    expect(await tap()).toMatchObject({ status: 'done' })
    expect(calls).toEqual([{ to: 'one@example.test' }])
  } else {
    const next = await tap().catch(error => error)
    expect(next).toMatchObject({ code: 'conflict', details: { reason: state === 'changed' ? 'bot_action_changed' : 'bot_action_unreachable' } })
    expect(next.message).not.toContain('partly happened')
    expect(calls).toEqual([])
    expect(answer).not.toHaveBeenCalled()
  }
})
