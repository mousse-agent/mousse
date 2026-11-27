/**
 * "Use your threads" as the bot engine holds it: one ask and one card (what Allow gives, plainly: threads it starts run
 * with full access), About with Remove and its switch, which turns get which thread tools, and what the bot is told. The
 * tools themselves are in
 * tests/run/botThreadTools.test.ts and the service's side in tests/run/botThreadsDaemon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { threadsActOf, threadsReadOnlyOf } from '../../src/mms/bots/activation/BotEngine'
import type { BotActivationTrigger } from '../../src/shared/bots/personal/definition'
import { BOT_SCHEDULES_NOT_OWNER_TEXT, BOT_THREADS_NOT_OWNER_TEXT, botAppToolRefusal } from '../../src/shared/bots/personal/walls'
import { botInstructions } from '../../src/mms/bots/instructions'
import { botCatalogueGroup } from '../../src/shared/bots/personal/catalogue'
import { THREADS_TEXT } from '../../src/shared/bots/personal/askText'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })
const SWITCHED_OFF = /switched that off/
const threadTools = (allow: readonly string[] | undefined) => (allow ?? []).filter((name) => name.startsWith('thread_')).sort()

describe('"use your threads" in the bot engine', () => {
  let f: BotFixture
  let botId: string
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith("- Use your owner's threads"))
  /** The bot's own "use your threads" switch in About. */
  const setThreads = (enabled: boolean) => f.bots.service.setPermission(botId, f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')!.id, enabled)

  beforeEach(async () => {
    f = botFixture()
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

  it('asked from the chat: one card in plain words; Allow gives the owner\'s chat and work every thread tool; About lists it, and Remove takes it all away', async () => {
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
    expect(threadTools(owner.prepared.policy.tools!.allow)).toEqual(['thread_archive', 'thread_create', 'thread_fork', 'thread_list', 'thread_read', 'thread_return', 'thread_search', 'thread_send', 'thread_stop', 'thread_update', 'thread_wait'])
    expect(line(owner.prepared.instructions)).toMatch(/: yes: .*start, message, steer, stop, fork or archive one, or change its queue, when your owner's message asks for it/)
    expect(owner.prepared.instructions).toMatch(/A thread you start runs with full access/)
    // A thread it starts stays out of the sidebar unless the owner asked to follow it (#1534); when to start one visible
    // is in the threads group, which the chat reads before it starts one.
    expect(owner.prepared.instructions).toContain('Before you start one, read the threads group once in the conversation')
    expect(botCatalogueGroup('threads')!.guidance).toMatch(/A thread you start stays out of your owner's sidebar.*Start it with hidden: false when they asked to follow/)
    // The chip of the thread it started keeps that thread in the posted message, for its Open.
    f.chips.set(f.store.dispatch(owner.activation.id, 1)!.clientRequestId, [{ icon: 'think', text: 'started thread', highlight: 'Fix the login page', thread: 't-new' }])
    await finish(f, owner.payload, 'completed', { text: 'Started it.' })
    expect(chatOf(f, botId).at(-1)!.chips).toEqual([{ icon: 'think', text: 'started thread', highlight: 'Fix the login page', thread: 't-new' }])

    const work = await run('w1')
    expect(threadTools(work.prepared.policy.tools!.allow)).toEqual(threadTools(owner.prepared.policy.tools!.allow))
    expect(work.prepared.authority.check(app('thread_archive'))).toEqual({ ok: true })
    expect(line(work.prepared.instructions)).toMatch(/start, message, steer, stop, fork or archive one, or change its queue, when the work your owner asked for needs it/)
    await finish(f, work.payload, 'completed', { text: 'Read them.' })

    f.bots.service.revokePermission(botId, item.id)
    const after = await chat('Start another one.', 'm3')
    expect(threadTools(after.prepared.policy.tools!.allow)).toEqual([])
    expect(after.prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false })
    await finish(f, after.payload, 'completed', { text: 'I can\'t now.' })
  })

  it('switched off for the bot: no thread tool, no card, the bot is told it is switched off and is never offered it', async () => {
    const asked = await chat('Start a thread for me.', 'm1')
    asked.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })
    await finish(f, asked.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.answer(botId, cards()[0]!.ask!.askId, 'allow')
    await finish(f, (await start(f, asked.activation.id, 2)).payload, 'completed', { text: 'Done.' })
    const before = cards().length

    setThreads(false)
    const turn = await chat('Start one now.', 'm2')
    expect(threadTools(turn.prepared.policy.tools!.allow)).toEqual([])
    expect(turn.prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false })
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })).toMatch(SWITCHED_OFF)
    expect(turn.prepared.instructions).not.toContain('You can ask to "use your threads"')
    expect(line(turn.prepared.instructions)).toMatch(/switched off by your owner/)
    await finish(f, turn.payload, 'completed', { text: 'That is off.' })
    expect(cards()).toHaveLength(before)
    expect(f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')).toMatchObject({ enabled: false })

    // A turn that started with it loses it at its next call when the switch goes off.
    setThreads(true)
    const running = await chat('And another.', 'm3')
    expect(running.prepared.authority.check(app('thread_list'))).toEqual({ ok: true })
    setThreads(false)
    expect(running.prepared.authority.check(app('thread_list'))).toMatchObject({ ok: false, refused: { text: expect.stringMatching(SWITCHED_OFF) } })
    await finish(f, running.payload, 'completed', { text: 'Stopped.' })
  })

  // A chat turn the owner's message or tapped answer started, a turn a thread's outcome or an unanswered question
  // started, and every run, may start, message, stop or archive threads; a chat turn another message started is told why not.
  // A run is read by its trigger (`deriveBotProvenance`): one with none names no start, and only reads (#1360).
  const turns: Array<[string, { lane: 'chat' | 'run'; idempotencyKey: string; trigger?: BotActivationTrigger }, boolean, string]> = [
    ['the owner\'s message', { lane: 'chat', idempotencyKey: 'chat:req-1' }, true, ''],
    ['the owner\'s tapped answer', { lane: 'chat', idempotencyKey: 'answer:req-1' }, true, ''],
    ['work the chat handed off', { lane: 'run', idempotencyKey: 'work:act-1:call-1', trigger: { kind: 'work', input: 'Do it', title: 'Job', from: 'act-1' } }, true, ''],
    ['a reminder\'s work', { lane: 'run', idempotencyKey: 'reminder:r1', trigger: { kind: 'work', input: 'Do it', title: 'Job', from: 'r1' } }, true, ''],
    ['a run started by hand', { lane: 'run', idempotencyKey: 'manual:m1', trigger: { kind: 'manual', input: 'Do it' } }, true, ''],
    ['a run whose trigger names no start', { lane: 'run', idempotencyKey: 'wake:w1' }, false, BOT_THREADS_NOT_OWNER_TEXT],
    // A turn a thread's outcome starts in the chat may carry on the work it was told about (#1359).
    ['a wake in the chat', { lane: 'chat', idempotencyKey: 'wake:w1' }, true, ''],
    ['a question no one answered', { lane: 'chat', idempotencyKey: 'question:q1:default' }, true, ''],
    ['a thread outcome notice', { lane: 'chat', idempotencyKey: 'job:j1:a1' }, true, ''],
    ['a scheduled run', { lane: 'run', idempotencyKey: 'sched:b1:s1:2026-11-13T09:00:00.000Z', trigger: { kind: 'schedule', input: 'Check', scheduleId: 's1', occurrenceAt: '2026-11-13T09:00:00.000Z' } }, true, ''],
    ['the bot\'s first message', { lane: 'chat', idempotencyKey: 'create:req-1' }, true, ''],
    ['another bot\'s message', { lane: 'chat', idempotencyKey: 'botmsg:m1' }, false, BOT_THREADS_NOT_OWNER_TEXT],
    // Resume's retry of a turn a usage limit stopped acts as its original could.
    ['the owner\'s message Resume retried', { lane: 'chat', idempotencyKey: 'chat:resume:a1' }, true, ''],
    ['a wake Resume retried', { lane: 'chat', idempotencyKey: 'resume:wake:a1' }, true, ''],
    ['a question no one answered, Resume retried', { lane: 'chat', idempotencyKey: 'resume:question:a1' }, true, ''],
    ['a thread outcome notice Resume retried', { lane: 'chat', idempotencyKey: 'resume:job:a1' }, true, ''],
    ['a thread\'s message Resume retried', { lane: 'chat', idempotencyKey: 'resume:threadmsg:a1' }, true, ''],
    ['the bot\'s first message Resume retried', { lane: 'chat', idempotencyKey: 'resume:create:a1' }, true, ''],
    ['another bot\'s message Resume retried', { lane: 'chat', idempotencyKey: 'resume:a1' }, false, BOT_THREADS_NOT_OWNER_TEXT]
  ]
  it.each(turns)('%s', (_name, row, all, refusal) => {
    expect(threadsActOf(row)).toBe(all)
    // What a start is answered with in a turn holding only the reading tools.
    const readOnly = threadsReadOnlyOf(row)
    const bot = { check: () => ({ ok: true as const }), skills: new Set<string>(), appTools: new Set(['thread_list', 'thread_read']), ...(readOnly ? { threadsReadOnly: readOnly } : {}) }
    expect(all ? undefined : botAppToolRefusal(bot, 'thread_create', {})).toBe(all ? undefined : refusal)
    // A chat turn is offered every thread tool whatever started it (#1360), and the call is refused where it may not act.
    const offered = { ...bot, appTools: new Set(['thread_list', 'thread_read', 'thread_create', 'schedule_list', 'schedule_create']) }
    expect(botAppToolRefusal(offered, 'thread_create', {})).toBe(all ? undefined : refusal)
    expect(botAppToolRefusal(offered, 'schedule_create', {})).toBe(all ? undefined : BOT_SCHEDULES_NOT_OWNER_TEXT)
    expect(botAppToolRefusal(offered, 'thread_read', {})).toBeUndefined()
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

    // Work may act on threads, held to no other device's limit.
    const work = await run('w1')
    expect(f.bots.ownerTurn(work.id)).toEqual({})
    await finish(f, work.payload, 'completed', { text: 'Done.' })
  })

  it('a phone\'s message that continues a turn at its wall keeps the phone\'s limit when Mousse stops before the turn goes on', async () => {
    const desk = await chat('From the computer.', 'd1')
    desk.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'You asked.' })
    await finish(f, desk.payload, 'completed', { text: 'Asked.' })
    // The phone's message is saved, then Mousse stops before the turn continues with it.
    const stopped = vi.spyOn(f.bots, 'continueChatWith').mockRejectedValueOnce(new Error('Mousse stopped'))
    await expect(f.bots.service.chatSend({ botId, text: 'Go on without it.', clientRequestId: 'phone-1', from: { limit: 'accept_edits' } })).rejects.toThrow('Mousse stopped')
    stopped.mockRestore()
    expect(f.store.activation(desk.activation.id)!.status).toBe('waiting_grant')
    // At the next start the saved message continues the turn, still held to the phone.
    await f.bots.reconcileOnStartup()
    expect(f.bots.ownerTurn(desk.activation.id)).toEqual({ limit: 'accept_edits' })
    const continued = await start(f, desk.activation.id, 2)
    expect(f.bots.ownerTurn(desk.activation.id)).toEqual({ limit: 'accept_edits' })
    await finish(f, continued.payload, 'completed', { text: 'OK.' })
  })

  it('deleting a bot withdraws its messages still waiting in its owner\'s threads, under its name', async () => {
    const withdrawn = vi.fn()
    f.host.threadsWithdrawn = withdrawn
    // A chat turn gives the bot its chat thread, the sender of its messages.
    const turn = await chat('Hello.', 'm1')
    await finish(f, turn.payload, 'completed', { text: 'Hi.' })
    const homeThreadId = f.store.registry(botId)!.homeThreadId
    expect(homeThreadId).toEqual(expect.any(String))
    await f.bots.remove(botId)
    expect(withdrawn).toHaveBeenCalledTimes(1)
    expect(withdrawn).toHaveBeenCalledWith({ botId, homeThreadId, name: 'Alpha' })
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
    expect(cards().filter((card) => card.ask?.status === 'open')).toEqual([])

    f.bots.service.revokePermission(botId, f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use your threads')!.id)
    expect(withdrawn).toHaveBeenCalledTimes(1)
    expect(withdrawn).toHaveBeenCalledWith({ botId, homeThreadId: f.store.registry(botId)!.homeThreadId, name: 'Alpha' })
    // Removed while the turn ran: a wait that ends now returns the refusal, nothing else.
    expect(authority.stillHolds?.('thread_wait')).toEqual(expect.any(String))
    await finish(f, running.payload, 'completed', { text: 'Stopped.' })
  })

  it('switching "Use your threads" off for the bot withdraws its waiting messages, and a running wait is refused; switching another permission off does not', async () => {
    const withdrawn = vi.fn()
    f.host.threadsWithdrawn = withdrawn
    for (const [tool, id] of [['threads', 'm1'], ['browser', 'm1b']] as const) {
      const asked = await chat(`Use ${tool}.`, id)
      asked.prepared.authority.escalate!({ permission: { tool }, reason: 'You asked.' })
      await finish(f, asked.payload, 'completed', { text: 'Asked.' })
      await f.bots.service.answer(botId, cards().find((card) => card.ask?.status === 'open')!.ask!.askId, 'allow')
      await finish(f, (await start(f, asked.activation.id, 2)).payload, 'completed', { text: 'Done.' })
    }
    const running = await chat('Wait on that thread.', 'm2')
    expect(running.prepared.authority.stillHolds?.('thread_wait')).toBeUndefined()
    f.bots.service.setPermission(botId, f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use the browser')!.id, false)
    expect(withdrawn).not.toHaveBeenCalled()
    setThreads(false)
    expect(withdrawn).toHaveBeenCalledWith({ botId, homeThreadId: f.store.registry(botId)!.homeThreadId, name: 'Alpha' })
    // The turn no longer holds it, and nothing is asked or shown for it.
    expect(running.prepared.authority.stillHolds?.('thread_wait')).toMatch(SWITCHED_OFF)
    expect(cards().filter((card) => card.ask?.status === 'open')).toEqual([])
    await finish(f, running.payload, 'completed', { text: 'Stopped.' })
  })
})
