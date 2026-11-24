/**
 * The tool API contract as the default branch has it before the thread and bot tool APIs are joined
 * (docs: Thread API & Bot API unification, PR 1a). It records today's behaviour; a later change to a row is a decision
 * the change names, never an accident.
 *
 * What started a bot's turn (its provenance) decides what the turn may do. Every start the engine writes is a row:
 * the owner's message and its continuation, a tapped answer, the bot's first message (also when Resume retried it), a
 * wake (and its retry), a question's default, a thread's notice (and a retry of a retry), a thread's message, another
 * bot's message, Resume of another bot's message (`resume:<id>`), work, a schedule, a run started by hand, and a start
 * no build writes (`future:start`). Each turn is real (a real engine, `bots.db` and run database) and each call goes
 * through the registered tool dispatch a runtime's call takes (`createAppToolRegistry`), so the bot's grant, the turn's
 * tools and each handler's own rules all apply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asksOwner, memoryLaneOf, ownerChatTurn, threadsActOf, threadsReadOnlyOf } from '../../src/mms/bots/activation/BotEngine'
import { BotWatchers } from '../../src/mms/bots/watchers'
import { deriveBotProvenance, type BotActivationProvenance } from '../../src/mms/bots/store/BotStore'
import type { BotActivationTrigger, BotLane } from '../../src/shared/bots/personal/definition'
import { defaultIntegrationActor } from '../../src/shared/integrations/actor'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture } from './delegationFixture'
import { botFixture, createBot, finish, flush, start, type BotFixture } from '../bots/botFixture'

const manual: BotActivationTrigger = { kind: 'manual', input: 'Hi' }
const work: BotActivationTrigger = { kind: 'work', input: 'Look it up', title: 'Research', from: 'chat-1' }
const schedule: BotActivationTrigger = { kind: 'schedule', input: 'Morning news', scheduleId: 's1', occurrenceAt: '2026-11-24T08:00:00.000Z' }

describe('what started a turn, and the rules that read it', () => {
  // [key, lane, trigger] → [provenance, ownerChatTurn, memoryLane, threadsReadOnly, asksOwner]
  const ROWS: Array<[string, BotLane, BotActivationTrigger, BotActivationProvenance, boolean, BotLane, 'not_owner' | undefined, boolean]> = [
    ['chat:msg', 'chat', manual, 'owner_message', true, 'chat', undefined, true],
    ['chat:after:msg', 'chat', manual, 'owner_message', true, 'chat', undefined, true],
    ['chat:resume:act0', 'chat', manual, 'owner_message', true, 'chat', undefined, true],
    ['answer:q', 'chat', manual, 'owner_tap', false, 'chat', undefined, true],
    ['answer:resume:act0', 'chat', manual, 'owner_tap', false, 'chat', undefined, true],
    ['create:bot', 'chat', manual, 'first_message', false, 'run', undefined, true],
    ['resume:create:bot', 'chat', manual, 'first_message', false, 'run', undefined, true],
    ['wake:w1', 'chat', manual, 'wake', false, 'run', undefined, true],
    ['resume:wake:w1', 'chat', manual, 'wake', false, 'run', undefined, true],
    ['question:q:default', 'chat', manual, 'question', false, 'run', undefined, true],
    ['job:j1', 'chat', manual, 'job', false, 'run', undefined, true],
    ['resume:resume:job:j1', 'chat', manual, 'job', false, 'run', undefined, true],
    ['threadmsg:t1', 'chat', manual, 'threadmsg', false, 'run', undefined, true],
    ['botmsg:b1:m1', 'chat', manual, 'botmsg', false, 'run', 'not_owner', true],
    ['resume:act1', 'chat', manual, 'botmsg', false, 'run', 'not_owner', true],
    ['action:a1', 'chat', manual, 'action_result', false, 'run', 'not_owner', true],
    ['future:start', 'chat', manual, 'unknown', false, 'run', 'not_owner', true],
    ['work:k1', 'run', work, 'work', false, 'run', undefined, true],
    ['sched:b:s1:t', 'run', schedule, 'schedule', false, 'run', undefined, false],
    ['manual:m1', 'run', manual, 'manual', false, 'run', undefined, false],
    ['chat:in-a-run', 'run', manual, 'manual', false, 'run', undefined, false]
  ]

  it.each(ROWS)('%s (%s)', (idempotencyKey, lane, trigger, provenance, owner, memoryLane, readOnly, asks) => {
    expect(deriveBotProvenance({ lane, idempotencyKey, trigger })).toBe(provenance)
    // A caller with only the lane and key (no stored provenance) reads the same as a row read from bots.db.
    for (const row of [{ lane, idempotencyKey, trigger }, { lane, idempotencyKey, trigger, provenance }]) {
      expect([ownerChatTurn(row), memoryLaneOf(row), threadsReadOnlyOf(row), threadsActOf(row), asksOwner(row)]).toEqual([owner, memoryLane, readOnly, readOnly === undefined, asks])
    }
  })
})

/** The matrix's tool calls, each with arguments its handler accepts, so only the turn decides. */
const CALLS: Array<[string, string, Record<string, unknown>]> = [
  ['say', 'bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, say: 'Stand up and stretch.' }],
  ['remind', 'remind', { text: 'Check the oven.', inMinutes: 30 }],
  ['watch_start', 'watch_start', { command: 'echo hi', brief: 'Tell me how it went.' }],
  // `wait: false`: work that asks goes on, so the calls after it still run in the same turn.
  ['ask_owner', 'ask_owner', { question: 'Which flat?', choices: ['The first', 'The second'], wait: false }],
  ['question_answer', 'question_answer', { questionId: 'q-missing', answer: 'The second' }],
  ['bot_send', 'bot_send', { bot: 'Beta', message: 'The login page returns a 500.' }],
  ['work_start', 'work_start', { title: 'Research', brief: 'Look up flats near the station.' }],
  // Last: work that waits is parked, which ends what its turn may do.
  ['work_wait', 'work_wait', { why: 'Check again.', inMinutes: 30 }]
]
const HELD = ['bot_schedule_add', 'remind', 'watch_start', 'ask_owner', 'question_answer', 'bot_send', 'work_wait', 'work_start', 'subagent_start'] as const

type Start = 'chat:msg' | 'chat:after:msg' | 'answer:q' | 'create:bot' | 'resume:create:bot' | 'wake:w1' | 'resume:wake:w1' | 'question:q:default' | 'job:j1'
  | 'resume:resume:job:j1' | 'threadmsg:t1' | 'botmsg:b1:m1' | 'resume:act1' | 'future:start' | 'work' | 'schedule' | 'manual'

interface Observed {
  provenance: BotActivationProvenance
  memoryLane: BotLane
  threadsReadOnly: 'not_owner' | null
  /** The matrix tools the turn holds (`BotAuthority.appTools`). */
  held: string[]
  /** The turn may start subagents (`BotAuthority.subagents`, what `subagent_start` checks first). */
  subagents: boolean
  /** Each call: `ok`, or the refusal's code. `question_answer` also says when only the owner's own message may pass one on. */
  calls: Record<string, string>
}

/**
 * A chat turn: every start holds the same tools (#1360: the tool list never changes with the start); what it may do is
 * refused at the call. `say` (a schedule's fixed line) needs the owner's message or tap (`memoryLane`). `question_answer`
 * needs the owner's own message; past that rule, the made-up question is not found (`refused:failed`).
 */
const CHAT_HELD = ['ask_owner', 'bot_schedule_add', 'bot_send', 'question_answer', 'remind', 'watch_start', 'work_start']
function chatTurn(provenance: BotActivationProvenance, memoryLane: BotLane, threadsReadOnly: 'not_owner' | null): Observed {
  const owner = provenance === 'owner_message'
  return {
    provenance, memoryLane, threadsReadOnly, held: CHAT_HELD, subagents: false,
    calls: {
      say: memoryLane === 'chat' ? 'ok' : 'refused:failed', remind: 'ok', watch_start: 'ok', ask_owner: 'ok',
      question_answer: owner ? 'refused:failed' : 'refused:owner_message_only', bot_send: 'ok', work_start: 'ok', work_wait: 'refused:not_granted'
    }
  }
}
/** A run: only the chat sets reminders, starts background commands or hands out work; it changes no schedule. */
function runTurn(provenance: 'work' | 'schedule' | 'manual'): Observed {
  const work = provenance === 'work'
  return {
    provenance, memoryLane: 'run', threadsReadOnly: null, held: work ? ['ask_owner', 'bot_schedule_add', 'bot_send', 'subagent_start', 'work_wait'] : ['bot_schedule_add', 'subagent_start'], subagents: true,
    calls: {
      say: 'refused:failed', remind: 'refused:not_granted', watch_start: 'refused:not_granted', ask_owner: work ? 'ok' : 'refused:unavailable', question_answer: 'refused:unavailable',
      bot_send: work ? 'ok' : 'refused:unavailable', work_start: 'refused:not_granted', work_wait: work ? 'ok' : 'refused:not_granted'
    }
  }
}

// One row per start: what the default branch does today. A cell a later change moves is that change's decision.
const EXPECTED: Record<Start, Observed> = {
  'chat:msg': chatTurn('owner_message', 'chat', null),
  'chat:after:msg': chatTurn('owner_message', 'chat', null),
  'answer:q': chatTurn('owner_tap', 'chat', null),
  'create:bot': chatTurn('first_message', 'run', null),
  'resume:create:bot': chatTurn('first_message', 'run', null),
  'wake:w1': chatTurn('wake', 'run', null),
  'resume:wake:w1': chatTurn('wake', 'run', null),
  'question:q:default': chatTurn('question', 'run', null),
  'job:j1': chatTurn('job', 'run', null),
  'resume:resume:job:j1': chatTurn('job', 'run', null),
  'threadmsg:t1': chatTurn('threadmsg', 'run', null),
  'botmsg:b1:m1': chatTurn('botmsg', 'run', 'not_owner'),
  'resume:act1': chatTurn('botmsg', 'run', 'not_owner'),
  'future:start': chatTurn('unknown', 'run', 'not_owner'),
  work: runTurn('work'),
  schedule: runTurn('schedule'),
  manual: runTurn('manual')
}

describe('the turn-kind matrix through registered dispatch', () => {
  let f: BotFixture
  let botId: string
  beforeEach(async () => {
    f = botFixture()
    // The handlers read the time from the system clock (`reminderTime`): the engine's clock starts there too.
    f.clock.now = Date.now()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', description: 'Help me with my work.', reply: 'Hello.' })).botId
    await createBot(f, { name: 'Beta', description: 'Watch the website.', reply: 'Hi.' })
    // "Run commands", so a background command's own rules decide (the owner allows it, as on the bot's ask).
    const grant = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'grant-commands' })
    const asking = await start(f, grant.id)
    asking.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To watch builds.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    await flush()
  })
  afterEach(() => f.close())

  /** The activation `start` started, queued and pumped; its id. */
  async function begin(which: Start): Promise<string> {
    if (which === 'chat:msg') {
      await f.bots.service.chatSend({ botId, text: 'Find me a flat.', clientRequestId: 'msg' })
      return f.store.activationByKey('chat:msg')!.id
    }
    if (which === 'work') {
      await f.bots.service.chatSend({ botId, text: 'Research flats.', clientRequestId: 'owner' })
      const owner = await start(f, f.store.activationByKey('chat:owner')!.id)
      const { workId } = await f.bots.tools.work.start(botId, owner.payload.activationId, { title: 'Research', brief: 'Look up flats.', key: 'k1' })
      await finish(f, owner.payload, 'completed', { text: 'On it.' })
      return workId
    }
    if (which === 'schedule') {
      f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check the news.' }, 'owner')
      f.clock.now += 5 * 60_000
      return (await f.tickSchedules(new Date(f.clock.now))).inserted[0]!
    }
    if (which === 'manual') return (await f.bots.activate({ botId, input: 'Do the job.', clientRequestId: 'by-hand' })).id
    const activation = await f.bots.enqueueChat(botId, which, 'Carry on.')
    await flush()
    return activation.id
  }

  async function observe(which: Start): Promise<Observed> {
    const id = await begin(which)
    const turn = await start(f, id)
    const row = f.store.activation(id)!
    const authority = turn.prepared.authority
    const { registry, turns, request } = appToolRegistry(f.runs, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools }) })
    turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: authority }))
    const spawn = vi.spyOn(BotWatchers.prototype, 'start').mockImplementation(() => {})
    const calls: Record<string, string> = {}
    try {
      for (const [label, name, args] of CALLS) {
        const outcome = await registry.call(name, { ...args, clientRequestId: `${label}-1` }, request({ threadId: turn.payload.threadId, runId: turn.payload.runId }))
        const refusal = refusalOf(outcome)
        calls[label] = !refusal ? 'ok' : label === 'question_answer' && /own message started/.test(refusal.message) ? 'refused:owner_message_only' : `refused:${refusal.code}`
      }
    } finally {
      spawn.mockRestore()
    }
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
    return {
      provenance: row.provenance,
      memoryLane: memoryLaneOf(row),
      threadsReadOnly: threadsReadOnlyOf(row) ?? null,
      held: HELD.filter((tool) => authority.appTools.has(tool)).sort(),
      subagents: Boolean(authority.subagents),
      calls
    }
  }

  const STARTS: Start[] = ['chat:msg', 'chat:after:msg', 'answer:q', 'create:bot', 'resume:create:bot', 'wake:w1', 'resume:wake:w1', 'question:q:default', 'job:j1',
    'resume:resume:job:j1', 'threadmsg:t1', 'botmsg:b1:m1', 'resume:act1', 'future:start', 'work', 'schedule', 'manual']
  it.each(STARTS)('%s', async (which) => {
    expect(await observe(which)).toEqual(EXPECTED[which])
  })

  it('one refusal shape on thread and bot turns; work_start retries key on the chat turn and its request, not clientRequestId', async () => {
    await f.bots.service.chatSend({ botId, text: 'Research flats.', clientRequestId: 'msg' })
    const turn = await start(f, f.store.activationByKey('chat:msg')!.id)
    const { registry, turns, request } = appToolRegistry(f.runs, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools }) })
    turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
    const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, request({ threadId: turn.payload.threadId, runId: turn.payload.runId }))
    const workIdOf = (outcome: { text: string }) => (JSON.parse(outcome.text) as { workId: string }).workId

    const brief = { title: 'Research', brief: 'Look up flats near the station.' }
    const first = await call('work_start', { ...brief, clientRequestId: 'a' })
    const retried = await call('work_start', { ...brief, clientRequestId: 'b' })
    const other = await call('work_start', { title: 'Research', brief: 'Look up flats near the park.', clientRequestId: 'a' })
    expect(refusalOf(first) ?? refusalOf(retried) ?? refusalOf(other)).toBeUndefined()
    expect(workIdOf(retried)).toBe(workIdOf(first))
    expect(workIdOf(other)).not.toBe(workIdOf(first))
    expect(f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work' && row.trigger.from === turn.payload.activationId)).toHaveLength(2)

    // A bot turn's refusal: an error result carrying { refused: { code, message, retry } }.
    const refused = refusalOf(await call('work_wait', { why: 'Later.', inMinutes: 5, clientRequestId: 'w' }))
    expect(refused).toMatchObject({ refused: { code: expect.any(String), message: expect.any(String), retry: expect.any(String) } })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })

    // The same tool on an ordinary thread's turn: refused in the same shape, and nothing starts.
    const fx = delegationFixture()
    try {
      const run = await fx.runningRun('thread-a')
      const threads = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools }) })
      threads.turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
      const before = f.store.listActivations(botId).length
      const outcome = await threads.registry.call('work_start', { ...brief, clientRequestId: 'c' }, threads.request({ threadId: 'thread-a', runId: run.runId }))
      expect(refusalOf(outcome)).toMatchObject({ refused: { code: expect.any(String), message: expect.any(String), retry: expect.any(String) } })
      expect(f.store.listActivations(botId)).toHaveLength(before)
    } finally {
      fx.dispose()
    }
  })
})
