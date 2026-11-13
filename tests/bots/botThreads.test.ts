/**
 * "Use your threads" as the bot engine holds it: one ask and one card (what Allow gives, plainly: threads it starts run
 * with full access), About with Remove, which turns get which thread tools, what the bot is told, and What bots may do
 * here's fourth switch, which takes it away on this computer with no card. The tools themselves are in
 * tests/run/botThreadTools.test.ts and the service's side in tests/run/botThreadsDaemon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ownerChatTurn, threadsReadOnlyOf } from '../../src/mms/bots/activation/BotEngine'
import { BOT_THREADS_CHAT_ONLY_TEXT, BOT_THREADS_NOT_OWNER_TEXT, botAppToolRefusal } from '../../src/shared/bots/personal/walls'
import { botInstructions } from '../../src/mms/bots/instructions'
import { THREADS_TEXT } from '../../src/shared/bots/personal/askText'
import { BOT_COMPUTER_OPEN, BOT_OFF_HERE_MARK, type BotComputerLimit } from '../../src/shared/bots/personal/computerLimit'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })
const NOT_HERE = /^Not on this computer: "use your threads" is switched off here/
const threadTools = (allow: readonly string[] | undefined) => (allow ?? []).filter((name) => name.startsWith('thread_')).sort()

describe('"use your threads" in the bot engine', () => {
  let f: BotFixture
  let botId: string
  let limit: BotComputerLimit
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith("- Use your owner's threads"))

  beforeEach(async () => {
    f = botFixture()
    limit = { ...BOT_COMPUTER_OPEN }
    f.host.computerLimit = () => limit
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', description: 'Help me with my work.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  async function run(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Check my threads.', clientRequestId: id })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }

  it('asked from the chat: one card in plain words; Allow gives the owner\'s chat every thread tool and work only reading; About lists it, and Remove takes it all away', async () => {
    const turn = await chat('Can you start a new Mousse thread to fix the login page?', 'm1')
    expect(threadTools(turn.prepared.policy.tools!.allow)).toEqual([])
    // The bot is told it can ask, and asks once; a call of a thread tool in the same turn is the same ask.
    expect(turn.prepared.instructions).toContain('You can ask to "use your threads"')
    expect(line(turn.prepared.instructions)).toMatch(/: no$/)
    turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked me to start a thread.' })
    turn.prepared.authority.check(app('thread_create'))
    await finish(f, turn.payload, 'completed', { text: 'I asked to use your threads.' })
    expect(cards()).toHaveLength(1)
    const card = cards()[0]!.ask!
    expect(card).toMatchObject({ title: THREADS_TEXT.title, note: 'Threads it starts run with full access on this computer.', status: 'open' })
    expect(card.tip).toMatch(/runs commands and changes files without asking/)
    await f.bots.service.answer(botId, card.askId, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('threads')
    // The answer continues the owner's turn, now with every thread tool.
    const continued = await start(f, turn.activation.id, 2)
    expect(threadTools(continued.prepared.policy.tools!.allow)).toContain('thread_create')
    await finish(f, continued.payload, 'completed', { text: 'Starting it.' })
    const item = f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')!
    expect(item.note).toBe(THREADS_TEXT.tip)

    const owner = await chat('Start it now on Opus.', 'm2')
    expect(threadTools(owner.prepared.policy.tools!.allow)).toEqual(['thread_create', 'thread_interrupt', 'thread_list', 'thread_read', 'thread_search', 'thread_send', 'thread_wait'])
    expect(line(owner.prepared.instructions)).toMatch(/: yes: .*start, message or stop one when your owner's message asks for it/)
    expect(owner.prepared.instructions).toMatch(/A thread you start runs with full access/)
    // The chip of the thread it started keeps that thread in the posted message, for its Open.
    f.chips.set(f.store.dispatch(owner.activation.id, 1)!.clientRequestId, [{ icon: 'think', text: 'started thread', highlight: 'Fix the login page', thread: 't-new' }])
    await finish(f, owner.payload, 'completed', { text: 'Started it.' })
    expect(chatOf(f, botId).at(-1)!.chips).toEqual([{ icon: 'think', text: 'started thread', highlight: 'Fix the login page', thread: 't-new' }])

    const work = await run('w1')
    expect(threadTools(work.prepared.policy.tools!.allow)).toEqual(['thread_list', 'thread_read', 'thread_search', 'thread_wait'])
    expect(work.prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false })
    expect(line(work.prepared.instructions)).toMatch(/starting, messaging or stopping one is for your chat/)
    await finish(f, work.payload, 'completed', { text: 'Read them.' })

    f.bots.service.revokePermission(botId, item.id)
    const after = await chat('Start another one.', 'm3')
    expect(threadTools(after.prepared.policy.tools!.allow)).toEqual([])
    expect(after.prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false })
    await finish(f, after.payload, 'completed', { text: 'I can\'t now.' })
  })

  it('switched off on this computer: no thread tool, no card, the bot is told it is not here and is never offered it; About marks what it holds', async () => {
    const asked = await chat('Start a thread for me.', 'm1')
    asked.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })
    await finish(f, asked.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.answer(botId, cards()[0]!.ask!.askId, 'allow')
    await finish(f, (await start(f, asked.activation.id, 2)).payload, 'completed', { text: 'Done.' })
    const before = cards().length

    limit = { ...BOT_COMPUTER_OPEN, threads: false }
    const turn = await chat('Start one now.', 'm2')
    expect(threadTools(turn.prepared.policy.tools!.allow)).toEqual([])
    expect(turn.prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'threads' } })
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })).toMatch(NOT_HERE)
    expect(turn.prepared.instructions).not.toContain('You can ask to "use your threads"')
    expect(line(turn.prepared.instructions)).toMatch(/off on this computer/)
    await finish(f, turn.payload, 'completed', { text: 'That is off here.' })
    expect(cards()).toHaveLength(before)
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('threads')
    expect(f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')).toMatchObject({ mark: BOT_OFF_HERE_MARK })

    // A turn that started with it loses it at its next call when the switch goes off.
    limit = { ...BOT_COMPUTER_OPEN }
    const running = await chat('And another.', 'm3')
    expect(running.prepared.authority.check(app('thread_list'))).toEqual({ ok: true })
    limit = { ...BOT_COMPUTER_OPEN, threads: false }
    expect(running.prepared.authority.check(app('thread_list'))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'threads' } })
    await finish(f, running.payload, 'completed', { text: 'Stopped.' })
  })

  // Only a chat turn the owner's own message started may start, message or stop threads; any other is told why not in
  // words that fit where it is (work is told it's for the chat; the bot's first message, in the chat, that no message of
  // the owner's started it).
  const turns: Array<[string, { lane: 'chat' | 'run'; idempotencyKey: string }, boolean, string]> = [
    ['the owner\'s message', { lane: 'chat', idempotencyKey: 'chat:req-1' }, true, ''],
    ['the bot\'s first message', { lane: 'chat', idempotencyKey: 'create:req-1' }, false, BOT_THREADS_NOT_OWNER_TEXT],
    ['work the chat handed off', { lane: 'run', idempotencyKey: 'act-1:call-1' }, false, BOT_THREADS_CHAT_ONLY_TEXT],
    ['a reminder\'s work', { lane: 'run', idempotencyKey: 'reminder:r1' }, false, BOT_THREADS_CHAT_ONLY_TEXT],
    ['a scheduled run', { lane: 'run', idempotencyKey: 'sched:b1:s1:2026-11-13T09:00:00.000Z' }, false, BOT_THREADS_CHAT_ONLY_TEXT],
    ['a run started by hand', { lane: 'run', idempotencyKey: 'chat:looks-like-a-chat-key' }, false, BOT_THREADS_CHAT_ONLY_TEXT]
  ]
  it.each(turns)('%s', (_name, row, all, refusal) => {
    expect(ownerChatTurn(row)).toBe(all)
    // What a start is answered with in a turn holding only the reading tools.
    const readOnly = threadsReadOnlyOf(row)
    const bot = { check: () => ({ ok: true as const }), skills: new Set<string>(), appTools: new Set(['thread_list', 'thread_read']), ...(readOnly ? { threadsReadOnly: readOnly } : {}) }
    expect(all ? undefined : botAppToolRefusal(bot, 'thread_create', {})).toBe(all ? undefined : refusal)
  })

  it('a chat turn another device\'s message started is held to that device\'s limit; this computer\'s own window is not', async () => {
    await f.bots.service.chatSend({ botId, text: 'From my phone: start a thread.', clientRequestId: 'p1', from: { limit: 'ask' } })
    const phone = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(f.bots.ownerTurn(phone.id)).toEqual({ limit: 'ask' })
    const turn = await start(f, phone.id)
    // It asks, and waits at the wall; the owner's reply from this computer continues it, still held to the phone.
    turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.chatSend({ botId, text: 'Never mind the card, go on.', clientRequestId: 'p2' })
    expect(f.bots.ownerTurn(phone.id)).toEqual({ limit: 'ask' })
    await finish(f, (await start(f, phone.id, 2)).payload, 'completed', { text: 'OK.' })

    const desk = await chat('From the computer.', 'd1')
    expect(f.bots.ownerTurn(desk.activation.id)).toEqual({})
    // A computer's turn its owner then continues from a phone is held to the phone from there on.
    desk.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'You asked.' })
    await finish(f, desk.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.chatSend({ botId, text: 'Go on without it.', clientRequestId: 'd2', from: { limit: 'accept_edits' } })
    expect(f.bots.ownerTurn(desk.activation.id)).toEqual({ limit: 'accept_edits' })
    await finish(f, (await start(f, desk.activation.id, 2)).payload, 'completed', { text: 'OK.' })

    // Work is no owner's chat turn at all.
    const work = await run('w1')
    expect(f.bots.ownerTurn(work.id)).toBeUndefined()
    await finish(f, work.payload, 'completed', { text: 'Done.' })
  })

  it('Remove withdraws what the bot sent that has not started; removing another permission does not, and a wait that ends after either is refused', async () => {
    const withdrawn = vi.fn()
    f.host.threadsWithdrawn = withdrawn
    // The owner allows "use your threads" and "use the browser", one card each.
    for (const [tool, id] of [['threads', 'm1'], ['browser', 'm1b']] as const) {
      const asked = await chat(`Use ${tool}.`, id)
      asked.prepared.authority.escalate!({ permission: { tool }, reason: 'You asked.' })
      await finish(f, asked.payload, 'completed', { text: 'Asked.' })
      await f.bots.service.answer(botId, cards().find((card) => card.ask?.status === 'open')!.ask!.askId, 'allow')
      await finish(f, (await start(f, asked.activation.id, 2)).payload, 'completed', { text: 'Done.' })
    }
    const other = f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use the browser')
    expect(other).toBeDefined()
    f.bots.service.revokePermission(botId, other!.id)
    expect(withdrawn).not.toHaveBeenCalled()

    const running = await chat('Wait on that thread.', 'm2')
    const authority = running.prepared.authority
    expect(authority.stillHolds?.('thread_wait')).toBeUndefined()
    // The switch off: the turn no longer holds it, and nothing is asked or shown for it.
    limit = { ...BOT_COMPUTER_OPEN, threads: false }
    expect(authority.stillHolds?.('thread_wait')).toMatch(NOT_HERE)
    limit = { ...BOT_COMPUTER_OPEN }
    expect(authority.stillHolds?.('thread_wait')).toBeUndefined()
    expect(cards().filter((card) => card.ask?.status === 'open')).toEqual([])

    f.bots.service.revokePermission(botId, f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')!.id)
    expect(withdrawn).toHaveBeenCalledTimes(1)
    expect(withdrawn).toHaveBeenCalledWith({ botId, homeThreadId: f.store.registry(botId)!.homeThreadId, name: 'Alpha' })
    // Removed while the turn ran: a wait that ends now returns the refusal, nothing else.
    expect(authority.stillHolds?.('thread_wait')).toEqual(expect.any(String))
    await finish(f, running.payload, 'completed', { text: 'Stopped.' })
  })

  it('switching "Use your threads" off on this computer withdraws every bot\'s waiting messages; another switch does not', () => {
    const withdrawn = vi.fn()
    f.host.threadsWithdrawn = withdrawn
    f.bots.computerLimitChanged()
    limit = { ...BOT_COMPUTER_OPEN, browser: false }
    f.bots.computerLimitChanged()
    expect(withdrawn).not.toHaveBeenCalled()
    limit = { ...BOT_COMPUTER_OPEN, browser: false, threads: false }
    f.bots.computerLimitChanged()
    expect(withdrawn).toHaveBeenCalledWith({ botId, homeThreadId: f.store.registry(botId)!.homeThreadId, name: 'Alpha' })
    // Saved again with it still off: nothing more to withdraw.
    f.bots.computerLimitChanged()
    expect(withdrawn).toHaveBeenCalledTimes(1)
  })
})
