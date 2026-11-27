/**
 * The tool API contract of the thread and bot tool APIs (docs: Thread API & Bot API unification). PR 1a recorded the
 * default branch's behaviour; PR 1b-i (#1360) changed the cells marked Δ below, the rows of `BOT_TURN_KINDS`, and PR
 * 1b-iii (#1361) those marked Δ #1361. Any other change to a row is a decision the change names, never an accident.
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
import { BOT_ASK_NOT_YET_TEXT, asksOwner, memoryLaneOf, ownerChatTurn, threadsActOf, threadsReadOnlyOf } from '../../src/mms/bots/activation/BotEngine'
import { BotWatchers } from '../../src/mms/bots/watchers'
import { deriveBotProvenance, type BotActivationProvenance } from '../../src/mms/bots/store/BotStore'
import type { BotActivationTrigger, BotLane } from '../../src/shared/bots/personal/definition'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { defaultIntegrationActor } from '../../src/shared/integrations/actor'
import type { Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture } from './delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from '../bots/botFixture'

const T = '2026-11-24T08:00:00.000Z'
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
    // Δ #1361: a held call's result is a turn of its own, which acts as far as the turn that held the call did.
    ['action:a1', 'chat', manual, 'action_result', false, 'run', undefined, true],
    ['action:a2', 'chat', { ...manual, threadsReadOnly: 'not_owner' }, 'action_result', false, 'run', 'not_owner', true],
    // Δ #1360: a start no build names asks nobody.
    ['future:start', 'chat', manual, 'unknown', false, 'run', 'not_owner', false],
    // No build writes these (the owner's retries are `chat:resume:`, `answer:resume:`): behind a `resume:`, never the owner's.
    ['resume:chat:msg', 'chat', manual, 'botmsg', false, 'run', 'not_owner', true],
    ['resume:answer:q', 'chat', manual, 'botmsg', false, 'run', 'not_owner', true],
    ['work:k1', 'run', work, 'work', false, 'run', undefined, true],
    // Δ #1360: a scheduled run asks its owner, and waits for the answer as work does.
    ['sched:b:s1:t', 'run', schedule, 'schedule', false, 'run', undefined, true],
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

  // A stored provenance wins over the key and trigger: each row's key or trigger alone reads the other way.
  const STORED: Array<[string, BotLane, BotActivationTrigger, BotActivationProvenance, boolean, BotLane, 'not_owner' | undefined, boolean]> = [
    ['future:start', 'chat', manual, 'owner_message', true, 'chat', undefined, true],
    ['chat:msg', 'chat', manual, 'botmsg', false, 'run', 'not_owner', true],
    ['answer:q', 'chat', manual, 'unknown', false, 'run', 'not_owner', false],
    ['manual:m1', 'run', manual, 'work', false, 'run', undefined, true],
    ['work:k1', 'run', work, 'manual', false, 'run', undefined, false],
    // Δ #1360: a chat turn's provenance on a run is not trusted: it reads as a start no build names.
    ['manual:m1', 'run', manual, 'owner_message', false, 'run', 'not_owner', false]
  ]
  it.each(STORED)('%s (%s, %j) stored as %s', (idempotencyKey, lane, trigger, provenance, owner, memoryLane, readOnly, asks) => {
    const stored = { lane, idempotencyKey, trigger, provenance }
    expect([ownerChatTurn(stored), memoryLaneOf(stored), threadsReadOnlyOf(stored), asksOwner(stored)]).toEqual([owner, memoryLane, readOnly, asks])
    const derived = { lane, idempotencyKey, trigger }
    expect([ownerChatTurn(derived), memoryLaneOf(derived), threadsReadOnlyOf(derived), asksOwner(derived)]).not.toEqual([owner, memoryLane, readOnly, asks])
  })
})

/** The matrix's tool calls, each with arguments its handler accepts, so only the turn decides. */
const CALLS: Array<[string, string, Record<string, unknown>]> = [
  // A change to one of the owner's threads ("use your threads"): adds a message to its queue.
  ['thread_change', 'queue_enqueue', { threadId: 'mine', content: 'Then run the tests.', expectedRevision: 'rev-0' }],
  ['say', 'bot_schedule_add', { when: { kind: 'interval', minutes: 60 }, say: 'Stand up and stretch.' }],
  ['remind', 'remind', { text: 'Check the oven.', inMinutes: 30 }],
  ['watch_start', 'watch_start', { command: 'echo hi', brief: 'Tell me how it went.' }],
  // `wait: false`: work that asks goes on, so the calls after it still run in the same turn.
  ['question_ask', 'question_ask', { question: 'Which flat?', choices: ['The first', 'The second'], wait: false }],
  ['question_answer', 'question_answer', { questionId: 'q-missing', answer: 'The second' }],
  ['bot_list', 'bot_list', {}],
  // #1446: held and refused wherever question_ask is; past the turn's rule, the made-up question is not found.
  ['question_withdraw', 'question_withdraw', { questionId: 'q-missing' }],
  ['bot_send', 'bot_send', { bot: 'Beta', message: 'The login page returns a 500.' }],
  ['work_start', 'work_start', { title: 'Research', brief: 'Look up flats near the station.' }],
  ['subagent_start', 'subagent_start', { title: 'Look', brief: 'List the folder.' }],
  // Last: work that waits is parked, which ends what its turn may do.
  ['work_wait', 'work_wait', { why: 'Check again.', inMinutes: 30 }]
]
const HELD = ['bot_schedule_add', 'remind', 'watch_start', 'question_ask', 'question_answer', 'question_withdraw', 'bot_list', 'bot_send', 'work_wait', 'work_start', 'subagent_start'] as const

type Start = 'chat:msg' | 'chat:after:msg' | 'answer:q' | 'create:bot' | 'resume:create:bot' | 'wake:w1' | 'resume:wake:w1' | 'question:q:default' | 'job:j1'
  | 'resume:resume:job:j1' | 'threadmsg:t1' | 'botmsg:b1:m1' | 'resume:act1' | 'action:a1' | 'future:start' | 'work' | 'schedule' | 'manual'
  | StoredStart | 'sched stored as owner_voice'

/**
 * A chat start whose row stores a provenance its key does not give (a writer naming it, `insertActivation`'s `start`):
 * the turn follows the stored one. Read from the key, each would go the other way.
 */
type StoredStart = 'future:start as owner_message' | 'chat:other as botmsg'
const STORED_STARTS: Record<StoredStart, [string, BotActivationProvenance]> = {
  'future:start as owner_message': ['future:start', 'owner_message'],
  'chat:other as botmsg': ['chat:other', 'botmsg']
}

interface Observed {
  provenance: BotActivationProvenance
  memoryLane: BotLane
  threadsReadOnly: 'not_owner' | null
  /** The matrix tools the turn holds (`BotAuthority.appTools`). */
  held: string[]
  /** The turn may start subagents (`BotAuthority.subagents`, what `subagent_start` checks first). */
  subagents: boolean
  /**
   * Each call: `ok`, or the refusal's code. `question_answer` also says ` (owner only)` when it was refused because only
   * the owner's message or tap may pass one on, so the code and the rule are both pinned.
   */
  calls: Record<string, string>
}

/**
 * A chat turn: every start holds the same tools (#1360: the tool list never changes with the start); what it may do is
 * refused at the call. `say` (a schedule's fixed line) needs the owner's message or tap (`memoryLane`). `question_answer`
 * needs the owner's own message or (Δ #1360) tapped answer; past that rule, the made-up question is not found
 * (`refused:failed`). Δ #1360: the owner-only refusal is the registry's `not_granted`, as every other turn-kind
 * refusal is (master: the handler's `failed`, same words). Δ #1360: a start no build names (`unknown`) only reads and
 * answers: its reminders, background commands, questions, messages to bots and work are refused at the call
 * (`turnRefusals`); listing the other bots is reading, so it stays.
 */
const CHAT_HELD = ['bot_list', 'bot_schedule_add', 'bot_send', 'question_answer', 'question_ask', 'question_withdraw', 'remind', 'watch_start', 'work_start']
function chatTurn(provenance: BotActivationProvenance, memoryLane: BotLane, threadsReadOnly: 'not_owner' | null): Observed {
  const owner = provenance === 'owner_message' || provenance === 'owner_tap'
  const acts = provenance === 'unknown' ? 'refused:not_granted' : 'ok'
  return {
    provenance, memoryLane, threadsReadOnly, held: CHAT_HELD, subagents: false,
    calls: {
      thread_change: threadsReadOnly ? 'refused:not_granted' : 'ok',
      say: memoryLane === 'chat' ? 'ok' : 'refused:failed', remind: acts, watch_start: acts, question_ask: acts, question_withdraw: acts === 'ok' ? 'refused:failed' : acts,
      question_answer: owner ? 'refused:failed' : 'refused:not_granted (owner only)', bot_list: 'ok', bot_send: acts, work_start: acts, subagent_start: 'refused:unavailable', work_wait: 'refused:not_granted'
    }
  }
}
/**
 * A run: it hands out no work and changes no schedule. Δ #1360: every run sets reminders and starts background commands
 * (detached: the chat wakes when one ends); a scheduled run asks its owner, waits, lists and messages other bots
 * (`bot_list` too), as work does.
 */
function runTurn(provenance: 'work' | 'schedule' | 'manual'): Observed {
  const asks = provenance !== 'manual'
  return {
    provenance, memoryLane: 'run', threadsReadOnly: null,
    held: asks ? ['bot_list', 'bot_schedule_add', 'bot_send', 'question_ask', 'question_withdraw', 'remind', 'subagent_start', 'watch_start', 'work_wait'] : ['bot_schedule_add', 'remind', 'subagent_start', 'watch_start'], subagents: true,
    calls: {
      thread_change: 'ok',
      say: 'refused:failed', remind: 'ok', watch_start: 'ok', question_ask: asks ? 'ok' : 'refused:unavailable', question_withdraw: asks ? 'refused:failed' : 'refused:unavailable', question_answer: 'refused:unavailable',
      bot_list: asks ? 'ok' : 'refused:unavailable', bot_send: asks ? 'ok' : 'refused:unavailable', work_start: 'refused:not_granted', subagent_start: 'ok', work_wait: asks ? 'ok' : 'refused:not_granted'
    }
  }
}

// One row per start, with the Δ cells of #1360 (in chatTurn and runTurn). A cell a later change moves is that change's decision.
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
  // Δ #1361: a held call's result (master: held as another bot's message is, reading the owner's threads only).
  'action:a1': chatTurn('action_result', 'run', null),
  'future:start': chatTurn('unknown', 'run', 'not_owner'),
  'future:start as owner_message': chatTurn('owner_message', 'chat', null),
  'chat:other as botmsg': chatTurn('botmsg', 'run', 'not_owner'),
  work: runTurn('work'),
  schedule: runTurn('schedule'),
  manual: runTurn('manual'),
  // A scheduled run whose row stores a provenance only a newer build writes reads as `unknown` (#1841): none of a
  // scheduled run's rights, though its key and trigger name a schedule. Δ #1360: an unknown run also only reads the
  // owner's threads and starts no subagents (master: every run acted on threads and split its job).
  'sched stored as owner_voice': {
    provenance: 'unknown', memoryLane: 'run', threadsReadOnly: 'not_owner', held: ['bot_schedule_add'], subagents: false,
    calls: {
      thread_change: 'refused:not_granted', say: 'refused:failed', remind: 'refused:not_granted', watch_start: 'refused:not_granted', question_ask: 'refused:unavailable', question_withdraw: 'refused:unavailable',
      question_answer: 'refused:unavailable', bot_list: 'refused:unavailable', bot_send: 'refused:unavailable', work_start: 'refused:not_granted', subagent_start: 'refused:unavailable', work_wait: 'refused:not_granted'
    }
  }
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
    // "Use your threads", so which turn may change one is the turn's own rule (`threadsReadOnly`), not the grant.
    asking.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To help in your threads.' })
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
    if (which === 'sched stored as owner_voice') {
      const id = await begin('schedule')
      f.store.run("UPDATE bot_activations SET provenance = 'owner_voice' WHERE id = ?", id)
      return id
    }
    if (which === 'manual') return (await f.bots.activate({ botId, input: 'Do the job.', clientRequestId: 'by-hand' })).id
    if (which in STORED_STARTS) {
      const [key, provenance] = STORED_STARTS[which as StoredStart]
      const insert = f.store.insertActivation.bind(f.store)
      const writer = vi.spyOn(f.store, 'insertActivation').mockImplementation((row, limits, named) => insert(row, limits, row.idempotencyKey === key ? { provenance } : named))
      try {
        const activation = await f.bots.enqueueChat(botId, key, 'Carry on.')
        await flush()
        return activation.id
      } finally {
        writer.mockRestore()
      }
    }
    const activation = await f.bots.enqueueChat(botId, which, 'Carry on.')
    await flush()
    return activation.id
  }

  /** The registry a turn's tool calls go through, over a host with one ordinary thread of the owner's (`mine`). */
  function registryFor(turn: { payload: { threadId: string; runId: string }; prepared: { authority: BotAuthority } }) {
    const mine = { id: 'mine', name: 'Fix the login page', projectId: 'p1', createdAt: T, updatedAt: T, startedAt: T } as Thread
    const host = fakeAppToolHost({
      threadMeta: (id) => (id === 'mine' ? mine : undefined),
      listThreads: () => [mine],
      botRole: (id) => (id === turn.payload.threadId ? 'activation' : undefined)
    })
    const { registry, turns, request } = appToolRegistry(f.runs, host.host, { bots: () => ({ host: f.bots.tools }) })
    turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
    const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, request({ threadId: turn.payload.threadId, runId: turn.payload.runId }))
    return { call, queueCommands: host.queueCommands }
  }

  async function observe(which: Start): Promise<Observed> {
    const id = await begin(which)
    const turn = await start(f, id)
    const row = f.store.activation(id)!
    const authority = turn.prepared.authority
    const { call, queueCommands } = registryFor(turn)
    const spawn = vi.spyOn(BotWatchers.prototype, 'start').mockImplementation(() => {})
    const calls: Record<string, string> = {}
    try {
      for (const [label, name, args] of CALLS) {
        const outcome = await call(name, { ...args, clientRequestId: `${label}-1` })
        const refusal = refusalOf(outcome)
        calls[label] = !refusal ? (outcome.isError ? 'error' : 'ok') : `refused:${refusal.code}${label === 'question_answer' && /can pass on their answer/.test(refusal.message) ? ' (owner only)' : ''}`
      }
    } finally {
      spawn.mockRestore()
    }
    // A refused thread change reaches nothing; an allowed one reaches the thread's queue once.
    expect(queueCommands.map((entry) => [entry.threadId, entry.command.op])).toEqual(calls.thread_change === 'ok' ? [['mine', 'enqueue']] : [])
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
    return {
      provenance: row.provenance,
      memoryLane: memoryLaneOf(row),
      // What the turn's authority holds, as the registry reads it: not recomputed from the row.
      threadsReadOnly: authority.threadsReadOnly ?? null,
      held: HELD.filter((tool) => authority.appTools.has(tool)).sort(),
      subagents: Boolean(authority.subagents),
      calls
    }
  }

  const STARTS: Start[] = ['chat:msg', 'chat:after:msg', 'answer:q', 'create:bot', 'resume:create:bot', 'wake:w1', 'resume:wake:w1', 'question:q:default', 'job:j1',
    'resume:resume:job:j1', 'threadmsg:t1', 'botmsg:b1:m1', 'resume:act1', 'action:a1', 'future:start', 'future:start as owner_message', 'chat:other as botmsg', 'work', 'schedule', 'manual', 'sched stored as owner_voice']
  it.each(STARTS)('%s', async (which) => {
    expect(await observe(which)).toEqual(EXPECTED[which])
  })

  // The bot's first message asks for nothing (its raw `create:` key). Once Resume retried it (`resume:create:`), the same
  // provenance (`first_message`) asks as any chat turn does.
  it.each([
    ['create:bot', true],
    ['resume:create:bot', false],
    ['chat:msg', false]
  ] as const)('escalate on %s: refused as too early is %s', async (which, tooEarly) => {
    const turn = await start(f, await begin(which))
    const outcome = await registryFor(turn).call('escalate', { permission: { tool: 'browser' }, reason: 'To book the viewing online.' })
    expect(outcome.text === BOT_ASK_NOT_YET_TEXT).toBe(tooEarly)
    // An ask past that rule is raised for the owner: a wall on this turn.
    expect(f.store.escalations({ activationId: turn.payload.activationId, status: 'open' }).length > 0).toBe(!tooEarly)
  })

  it('question_answer and subagent_start do what the matrix allows: the owner\'s message passes on a real answer, work starts a subagent', async () => {
    const workId = await begin('work')
    const work = await start(f, workId)
    const asked = await registryFor(work).call('question_ask', { question: 'Which flat?', choices: ['The first', 'The second'], wait: false, clientRequestId: 'ask' })
    expect(refusalOf(asked)).toBeUndefined()
    const questionId = chatOf(f, botId).find((message) => message.question && message.activationId === workId)!.question!.questionId
    const started = await registryFor(work).call('subagent_start', { title: 'Look', brief: 'List the folder.', clientRequestId: 'sub' })
    expect(refusalOf(started) ?? started.isError).toBeFalsy()
    // A delegation of the work's run in the run database, with its place on the work's counts.
    expect(f.runs.delegations.listForRootActivation(workId)).toHaveLength(1)
    expect(f.store.subagentRuns(workId)).toHaveLength(1)

    const owner = await start(f, await begin('chat:msg'))
    const relayed = await registryFor(owner).call('question_answer', { questionId, answer: 'The second', clientRequestId: 'qa' })
    expect(refusalOf(relayed)).toBeUndefined()
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { text: 'The second' } })
  })

  it('one refusal shape on thread and bot turns; work_start retries key on the chat turn and its request, not clientRequestId', async () => {
    await f.bots.service.chatSend({ botId, text: 'Research flats.', clientRequestId: 'msg' })
    const turn = await start(f, f.store.activationByKey('chat:msg')!.id)
    const { registry, turns, request } = appToolRegistry(f.runs, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools }) })
    turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
    const call = (name: string, args: Record<string, unknown>) => registry.call(name, args, request({ threadId: turn.payload.threadId, runId: turn.payload.runId }))
    const workIdOf = (outcome: { text: string }) => (JSON.parse(outcome.text) as { runId: string }).runId

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
