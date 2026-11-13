/**
 * "Use your threads" as the bot engine holds it: one ask and one card (what Allow gives, plainly: threads it starts run
 * with full access), About with Remove, which turns get which thread tools, what the bot is told, and What bots may do
 * here's fourth switch, which takes it away on this computer with no card. The tools themselves are in
 * tests/run/botThreadTools.test.ts and the service's side in tests/run/botThreadsDaemon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerChatTurn } from '../../src/mms/bots/activation/BotEngine'
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

  // Only a chat turn the owner's own message started may start, message or stop threads.
  const turns: Array<[string, { lane: 'chat' | 'run'; idempotencyKey: string }, boolean]> = [
    ['the owner\'s message', { lane: 'chat', idempotencyKey: 'chat:req-1' }, true],
    ['the bot\'s first message', { lane: 'chat', idempotencyKey: 'create:req-1' }, false],
    ['work the chat handed off', { lane: 'run', idempotencyKey: 'act-1:call-1' }, false],
    ['a reminder\'s work', { lane: 'run', idempotencyKey: 'reminder:r1' }, false],
    ['a scheduled run', { lane: 'run', idempotencyKey: 'sched:b1:s1:2026-11-13T09:00:00.000Z' }, false],
    ['a run started by hand', { lane: 'run', idempotencyKey: 'chat:looks-like-a-chat-key' }, false]
  ]
  it.each(turns)('%s', (_name, row, all) => {
    expect(ownerChatTurn(row)).toBe(all)
  })
})
