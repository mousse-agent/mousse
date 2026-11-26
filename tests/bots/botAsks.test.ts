/**
 * Bot Phase 1 §5.4: asks. In a run a missing permission is refused as a tool error, one ask waits
 * for the owner per permission, and the run carries on; in the chat (the owner is there) it is a
 * wall whose answer continues the turn. Asks never expire. Allow widens the grant without approving
 * the rest again, Remove narrows it, Not now on a run's ask holds off a new one for 24 hours, and
 * several `escalate` calls in one chat turn show their cards together.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_DUPLICATE_TEXT, BOT_ASK_NOT_NOW_TEXT, BOT_ASK_NOT_YET_TEXT, BOT_ASK_REFUSED_TEXT, BOT_MCP_UNAVAILABLE_TEXT, BOT_SKILLS_NO_ASK_TEXT, BOT_WORK_HAS_TEXT, BOT_ASK_RAISED_TEXT, botAskedText } from '../../src/mms/bots/activation/BotEngine'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'
import { askAnsweredLine } from '../../src/renderer/components/bots/botChatShape'

let f: BotFixture
let botId: string
let invoices: string

const DAY = 24 * 60 * 60_000
/** A command: a gate refusal asks for "run commands", once. */
const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
/** A call of a thread tool: a gate refusal asks for "use your threads", which the chat uses itself. */
const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })
const shellFingerprint = askFingerprintOf({ tool: 'shell' })
/** The bot may make `maxTurns` model requests per activation. */
const limitTurns = (maxTurns: number) => f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxTurns } }))
/** A turn uses up its 3 model requests: the 4th is over the limit. */
const exhaust = (prepared: { authority: { counters: { charge: (kind: 'request') => unknown } } }) => {
  for (let i = 0; i < 4; i += 1) prepared.authority.counters.charge('request')
}

beforeEach(async () => {
  f = botFixture()
  invoices = join(f.base, 'Invoices')
  mkdirSync(invoices)
  botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** A manual run, started. */
async function run(id: string) {
  const activation = await f.bots.activate({ botId, input: 'Sort the invoices', clientRequestId: id })
  return { activation, ...(await start(f, activation.id)) }
}

/** A chat message, its turn started. */
async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

describe('asks in a run', () => {
  it('a refusal is a tool error; one ask per permission across three runs, and every run ends done', async () => {
    for (const id of ['r1', 'r2', 'r3']) {
      const { activation, payload, prepared } = await run(id)
      const decided = prepared.authority.check(command('ls'))
      expect(decided).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
      // The run carries on: other calls are still checked as usual.
      expect(f.store.activation(activation.id)!.status).toBe('running')
      await finish(f, payload, 'completed', { text: `Report ${id}: I skipped the commands.` })
      expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    }
    const asks = f.store.openAsks(botId)
    expect(asks).toMatchObject([{ mode: 'ask', fingerprint: shellFingerprint, permission: { tool: 'shell' }, title: 'run commands', expiresAt: null }])
    const cards = chatOf(f, botId).filter((message) => message.ask)
    expect(cards).toMatchObject([{ author: 'bot', kind: 'notice', text: 'Penny wants to run commands.', ask: { askId: asks[0]!.id, status: 'open', kind: 'permission' } }])
    expect(chatOf(f, botId).filter((message) => message.kind === 'run_report')).toHaveLength(3)
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'needs_you', stateText: 'Wants to run commands', needsOwner: true })
  })

  it('the bot\'s own escalate in a run asks once and carries on', async () => {
    const first = await run('r1')
    // It is told the exact title of the card it made: the name it tells its owner it asked for.
    expect(first.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To tidy them.' })).toBe(botAskedText('run commands', BOT_ASK_RAISED_TEXT))
    await finish(f, first.payload, 'completed', { text: 'Done what I could.' })
    const second = await run('r2')
    // The card already open is the one it names.
    expect(second.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(botAskedText('run commands', BOT_ASK_RAISED_TEXT))
    // A gate refusal of the same permission finds the same ask.
    const gate = second.prepared.authority.check(command('ls'))
    expect(gate).toMatchObject({ ok: false, refused: { askId: f.store.openAsks(botId)[0]!.id } })
    await finish(f, second.payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(f.store.activation(second.activation.id)!.status).toBe('done')
  })

  it('Not now holds off a new ask for 24 hours, then until the owner writes; then the run asks again', async () => {
    const first = await run('r1')
    first.prepared.authority.check(command('ls'))
    await finish(f, first.payload, 'completed', { text: 'Skipped.' })
    const askId = f.store.openAsks(botId)[0]!.id
    expect(f.bots.service.get(botId).summary.needsOwner).toBe(true)
    const { message } = await f.bots.service.answer(botId, askId, 'not_now')
    expect(message.ask).toMatchObject({ askId, status: 'not_now' })
    expect(f.bots.service.get(botId).summary.needsOwner).toBeUndefined()
    f.clock.now += DAY - 60_000
    const second = await run('r2')
    // No card: the bot is told the owner said not now, never that it asked.
    expect(second.prepared.authority.check(command('ls'))).toEqual({ ok: false, refused: { text: BOT_ASK_NOT_NOW_TEXT, askId: '' } })
    await finish(f, second.payload, 'completed', { text: 'Skipped again.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).filter((row) => row.ask)).toHaveLength(1)
    // A day on, the owner has still not written: asking again would be a loop (issue #1363).
    f.clock.now += 2 * 60_000
    const third = await run('r3')
    expect(third.prepared.authority.check(command('ls'))).toEqual({ ok: false, refused: { text: BOT_ASK_DUPLICATE_TEXT, askId: '' } })
    await finish(f, third.payload, 'completed', { text: 'Skipped.' })
    expect(f.store.openAsks(botId)).toEqual([])
    // Once they write, the run asks again.
    await f.bots.service.chatSend({ botId, text: 'what are you up to?', clientRequestId: 'm-up' })
    f.clock.now += 60_000
    const fourth = await run('r4')
    fourth.prepared.authority.check(command('ls'))
    await finish(f, fourth.payload, 'completed', { text: 'Asked.' })
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(f.store.openAsks(botId)[0]!.id).not.toBe(askId)
  })

  it('an ask never expires', async () => {
    const first = await run('r1')
    first.prepared.authority.check(command('ls'))
    await finish(f, first.payload, 'completed', { text: 'Skipped.' })
    f.clock.now += 5 * DAY
    for (const timer of [...f.timers]) timer.fn()
    await flush()
    expect(f.store.openAsks(botId)).toMatchObject([{ status: 'open', expiresAt: null }])
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
  })

})

describe('asks in the chat', () => {
  it('a refusal is a wall: the card is on the reply, and the answer continues the turn', async () => {
    const { activation, payload, prepared } = await chat('Start a thread to fix the login page', 'm1')
    expect(prepared.authority.check(app('thread_create'))).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: 'use your threads' } })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    await finish(f, payload, 'interrupted', { text: 'I need to use your threads first.', outcome: { interruptedBy: 'bot_wall' } })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply).toMatchObject({ author: 'bot', kind: 'text', text: 'I need to use your threads first.', ask: { status: 'open', title: 'use your threads' } })
    // Days pass: the wall waits, it never expires.
    f.clock.now += 3 * DAY
    for (const timer of [...f.timers]) timer.fn()
    await flush()
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    const before = f.store.activeGrant(botId)!
    const { message } = await f.bots.service.answer(botId, reply.ask!.askId, 'allow')
    expect(message).toMatchObject({ id: reply.id, ask: { status: 'allowed' } })
    const after = f.store.activeGrant(botId)!
    expect(after.digest).not.toBe(before.digest)
    // Only the threads are added: the rest of the grant is what it was.
    expect({ ...after.manifest, appTools: before.manifest.appTools }).toEqual(before.manifest)
    expect([...after.manifest.appTools].sort()).toEqual([...before.manifest.appTools, 'threads'].sort())
    expect(f.host.definitions.get(botId)!.published!.permissions.appTools).toContain('threads')
    // The waiting activation moved to the wider grant, and continues on its own history.
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', grantDigest: after.digest })
    const next = f.store.dispatch(activation.id, 2)!
    expect(next).toMatchObject({ kind: 'continue', prompt: { text: '[Mousse] The owner allowed: use your threads. Continue.' } })
    const continued = await start(f, activation.id, 2)
    expect(continued.prepared).toMatchObject({ history: 'thread', lane: 'chat' })
    expect(continued.prepared.authority.check(app('thread_create'))).toEqual({ ok: true })
  })

  it('several asks in one turn show together; the turn continues once every card is answered', async () => {
    const { activation, payload, prepared } = await chat('Ask me now for everything you\'ll need', 'm1')
    expect(prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'Threads.' })).toBe(botAskedText('use your threads', BOT_ASK_DEFERRED_TEXT))
    // Asks are ordered by when they were made (two in the same millisecond order by id).
    f.clock.now += 1
    expect(prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Commands.' })).toBe(botAskedText('run commands', BOT_ASK_DEFERRED_TEXT))
    // The same permission again adds no card.
    expect(prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'Threads again.' })).toBe(botAskedText('use your threads', BOT_ASK_DEFERRED_TEXT))
    // The turn keeps running until its text is complete.
    expect(f.store.activation(activation.id)!.status).toBe('running')
    expect(prepared.authority.time.signal.aborted).toBe(false)
    await finish(f, payload, 'completed', { text: 'I need two things.' })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    const rows = chatOf(f, botId).filter((row) => row.activationId === activation.id && row.author === 'bot')
    expect(rows).toMatchObject([
      { kind: 'text', text: 'I need two things.', ask: { title: 'use your threads', status: 'open' } },
      { kind: 'notice', text: 'Penny wants to run commands.', ask: { title: 'run commands', status: 'open' } }
    ])
    await f.bots.service.answer(botId, rows[0]!.ask!.askId, 'allow')
    expect(f.store.dispatch(activation.id, 2)).toBeUndefined()
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    await f.bots.service.answer(botId, rows[1]!.ask!.askId, 'not_now')
    const next = f.store.dispatch(activation.id, 2)!
    expect(next.prompt.text).toContain('The owner allowed: use your threads.')
    expect(next.prompt.text).toContain('The owner said not now: run commands.')
    expect(f.store.dispatch(activation.id, 3)).toBeUndefined()
  })

  it('both asks of one turn allowed: the turn carries on with the owner\'s request, on its own history, with the threads', async () => {
    const { activation, payload, prepared } = await chat('List my repos', 'm1')
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To find your repo threads.' })
    f.clock.now += 1
    prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run git.' })
    await finish(f, payload, 'completed', { text: 'I need two things.' })
    const asks = chatOf(f, botId).filter((row) => row.activationId === activation.id && row.ask).map((row) => row.ask!)
    expect(asks.map((ask) => ask.title)).toEqual(['use your threads', 'run commands'])
    for (const ask of asks) await f.bots.service.answer(botId, ask.askId, 'allow')
    const next = await start(f, activation.id, 2)
    // The same activation goes on: the owner's request is in the thread's own history, not asked again.
    expect(next.prepared).toMatchObject({ history: 'thread', lane: 'chat' })
    expect(next.prepared.prompt).toContain('The owner allowed: use your threads.')
    expect(next.prepared.prompt).toContain('The owner allowed: run commands. Your work has it now: hand the job to work_start.')
    expect(next.prepared.authority.check(app('thread_create'))).toEqual({ ok: true })
    await finish(f, next.payload, 'completed', { text: 'Here are your repos.' })
    expect(f.store.activation(activation.id)!.status).toBe('done')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'text', text: 'Here are your repos.' })
  })

  it('an export_memory ask grants nothing', async () => {
    const before = f.store.activeGrant(botId)!.digest
    const { activation, payload, prepared } = await chat('Export your memory', 'm1')
    expect(prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })).toBe(botAskedText('save its memory to a folder', BOT_ASK_DEFERRED_TEXT))
    await finish(f, payload, 'completed', { text: 'Pick a folder.' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect(card).toMatchObject({ kind: 'export_memory', status: 'open', title: 'save its memory to a folder' })
    const { message } = await f.bots.service.answer(botId, card.askId, 'allow')
    expect(message.ask).toMatchObject({ status: 'allowed', kind: 'export_memory' })
    expect(f.store.activeGrant(botId)!.digest).toBe(before)
    expect(f.store.dispatch(activation.id, 2)!.prompt.text).toContain('The owner allowed: save its memory to a folder.')
  })
})

describe('About', () => {
  // What every bot has by default (MCP, skills, automation tools) has rows of its own, with a switch and no Remove.
  const granted = () => f.bots.service.get(botId).permissions.filter((item) => !item.builtIn)

  it('never lists the starter grant (files folder, default tools)', async () => {
    expect(granted()).toEqual([])
    await runDispatch(f, (await f.bots.activate({ botId, input: 'x', clientRequestId: 'r1' })).id, 1, { text: 'ok' })
    expect(granted()).toEqual([])
  })
})

describe('asks across lanes and timing (review)', () => {
  it('a chat card is answered only once its message is there; until then the bot is not "needs you"', async () => {
    const { activation, payload, prepared } = await chat('ask me for my threads', 'm-early')
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To sort them.' })
    const ask = f.store.openAsks(botId)[0]!
    expect(f.bots.service.get(botId).summary.state).toBe('working')
    await expect(f.bots.service.answer(botId, ask.id, 'allow')).rejects.toMatchObject({ code: 'ask_not_ready' })
    await finish(f, payload, 'completed', { text: 'May I use your threads?' })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'needs_you', stateText: 'Wants to use your threads' })
  })

  it('a limit has one open ask whichever way it was raised', async () => {
    limitTurns(3)
    const { payload, prepared } = await run('limit-run')
    // A run that used up its steps: it ends, with one ask for more.
    exhaust(prepared)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.openAsks(botId).filter((ask) => ask.kind === 'budget')).toHaveLength(1)
    // The chat asking for the same limit takes that ask over rather than adding a second one.
    const turn = await chat('take more steps please', 'm-limit')
    turn.prepared.authority.escalate!({ permission: { budget: { key: 'maxTurns', amount: 3 } }, reason: 'More steps.' })
    expect(f.store.openAsks(botId).filter((ask) => 'budget' in ask.permission)).toHaveLength(1)
  })

  it('stopping a chat that took over a run\'s ask leaves that ask open for the owner', async () => {
    // The run's ask, raised by its refused call; the run ends done.
    const live = await run('r-moved')
    live.prepared.authority.check(command('ls'))
    await finish(f, live.payload, 'completed', { text: 'Skipped the commands.' })
    const runAsk = f.store.openAsks(botId).find((ask) => ask.fingerprint === shellFingerprint)!
    expect(runAsk.mode).toBe('ask')
    // The chat hits the same permission: the run's ask becomes its wall.
    const turn = await chat('tidy my notes', 'm-moved')
    turn.prepared.authority.check(command('ls'))
    expect(f.store.escalation(runAsk.id)).toMatchObject({ mode: 'wall', activationId: turn.activation.id, status: 'open' })
    await f.bots.service.chatStop(botId)
    expect(f.store.escalation(runAsk.id)).toMatchObject({ mode: 'ask', status: 'open' })
    expect(chatOf(f, botId).filter((message) => message.ask?.askId === runAsk.id).every((message) => message.ask!.status === 'open')).toBe(true)
  })

  it('a message sent while the chat waits at a limit starts a chat of its own', async () => {
    limitTurns(3)
    const turn = await chat('a long job', 'm-long')
    exhaust(turn.prepared)
    await finish(f, turn.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(turn.activation.id)!.status).toBe('waiting_grant')
    await f.bots.service.chatSend({ botId, text: 'never mind, just say hi', clientRequestId: 'm-hi' })
    await flush()
    expect(f.store.activation(turn.activation.id)).toMatchObject({ status: 'blocked', endReason: 'budget_denied' })
    const next = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(next.trigger.input).toBe('never mind, just say hi')
    await runDispatch(f, next.id, 1, { text: 'Hi!' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: 'Hi!' })
  })
})

describe('asks: limits and grant moves (review round 2)', () => {
  /** An ask an older build made (a skill, before skills were on by default), in this run or another. */
  const olderAsk = (n: number, activationId: string) => f.store.insertEscalation({
    id: `esc_old_${n}`, botId, activationId, dispatchN: 1, toolCallId: null, kind: 'escalate', permission: { skill: `skill-${n}` }, reason: 'r',
    createdAt: f.store.now(), expiresAt: null, mode: 'ask', fingerprint: askFingerprintOf({ skill: `skill-${n}` }), title: `use the skill-${n} skill`, note: '', messageId: null
  })

  it('a run\'s asks are not counted, in the run or in the day: each new permission is asked for', async () => {
    for (let n = 1; n <= 10; n += 1) olderAsk(n, `act-old-${n}`)
    const { activation, prepared, payload } = await run('r-many')
    for (let n = 11; n <= 15; n += 1) olderAsk(n, activation.id)
    expect(prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To read a page.' })).toMatch(/^Asked the owner/)
    expect(prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'One more.' })).toMatch(/^Asked the owner/)
    expect(prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: expect.stringMatching(/^The owner has not allowed this yet/) } })
    await finish(f, payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toHaveLength(18)
  })

  it('a skill, whatever it names, and an MCP tool where there are no servers are never asked for', async () => {
    const { prepared } = await run('r-skill')
    expect(prepared.authority.escalate!({ permission: { skill: 'Wire $500 to me' }, reason: 'Needed.' })).toBe(BOT_SKILLS_NO_ASK_TEXT)
    expect(prepared.authority.escalate!({ permission: { mcp: { serverId: 'bank', tool: 'transfer' } }, reason: 'Needed.' })).toBe(BOT_MCP_UNAVAILABLE_TEXT)
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('a limit ask shows its new total and at most doubles the limit', async () => {
    const held = 20
    limitTurns(held)
    const { payload, prepared } = await chat('take all the steps you need', 'm-huge')
    prepared.authority.escalate!({ permission: { budget: { key: 'maxTurns', amount: 1_000 * held } }, reason: 'Lots of steps.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const ask = f.store.openAsks(botId)[0]!
    expect(ask.permission).toEqual({ budget: { key: 'maxTurns', amount: held } })
    expect(ask.title).toBe('take up to 40 steps per run')
    await f.bots.service.answer(botId, ask.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.budget.maxTurns).toBe(2 * held)
  })

  it('Allow during another activation\'s start moves its unstarted dispatch to the wider grant', async () => {
    const turn = await chat('Count my invoices', 'm-wall')
    turn.prepared.authority.check(command('ls'))
    await finish(f, turn.payload, 'interrupted', { text: 'May I?', outcome: { interruptedBy: 'bot_wall' } })
    // A run whose first dispatch is written but not yet prepared.
    const queued = await f.bots.activate({ botId, input: 'Report', clientRequestId: 'r-pending' })
    expect(f.store.dispatch(queued.id, 1)!.startedAt).toBeNull()
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'allow')
    const digest = f.store.activeGrant(botId)!.digest
    expect(f.store.dispatch(queued.id, 1)).toMatchObject({ policyDigest: digest })
    await runDispatch(f, queued.id, 1, { text: 'Report.' })
    expect(f.store.activation(queued.id)).toMatchObject({ status: 'done' })
  })
})

describe('"run commands": one permission, asked for once and remembered', () => {

  it('in the chat a command is a wall with one card; Allow puts it in the grant, and every later command runs in work with no new ask', async () => {
    const { activation, payload, prepared } = await chat('Count the lines in my notes', 'm1')
    expect(prepared.authority.check(command('wc -l *.md'))).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: 'run commands' } })
    await finish(f, payload, 'interrupted', { text: 'I need to run a command for that.', outcome: { interruptedBy: 'bot_wall' } })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply.ask).toMatchObject({ status: 'open', title: 'run commands' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint }])
    await f.bots.service.answer(botId, reply.ask!.askId, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
    expect(f.host.definitions.get(botId)!.published!.permissions.tools).toContain('shell')
    const continued = await start(f, activation.id, 2)
    // The chat is the front desk: commands are its work's now, and no new card is made for them.
    expect(continued.prepared.authority.check(command('wc -l *.md'))).toEqual({ ok: false, refused: { text: BOT_WORK_HAS_TEXT, askId: '' } })
    await finish(f, continued.payload, 'completed', { text: 'On it.' })
    const later = await chat('And again', 'm2')
    expect(later.prepared.authority.check(command('ls'))).toEqual({ ok: false, refused: { text: BOT_WORK_HAS_TEXT, askId: '' } })
    await finish(f, later.payload, 'completed', { text: 'On it.' })
    // Work runs any command, wherever it says it runs: no per-command ask.
    const runLater = await run('r1')
    for (const text of ['wc -l *.md', 'rm -rf build', 'git status']) expect(runLater.prepared.authority.check(command(text)), text).toEqual({ ok: true })
    expect(runLater.prepared.authority.check({ kind: 'builtin', tool: 'shell', nativeName: 'shell', args: { command: 'ls', cwd: invoices } })).toEqual({ ok: true })
    await finish(f, runLater.payload, 'completed', { text: 'Report.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).filter((row) => row.ask)).toHaveLength(1)
  })

  it('the bot can ask for it itself (escalate), as on runtimes where an ungranted shell does not exist', async () => {
    const { prepared, payload } = await chat('Run the tests in my project', 'm1')
    expect(prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run your tests.' })).toBe(botAskedText('run commands', BOT_ASK_DEFERRED_TEXT))
    await finish(f, payload, 'completed', { text: 'I\'ve asked to run commands.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint, title: 'run commands' }])
  })

  it('a run asks once, is refused, and carries on; Not now grants nothing', async () => {
    const { activation, payload, prepared } = await run('r1')
    expect(prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    expect(prepared.authority.check(command('pwd'))).toMatchObject({ ok: false, refused: { askId: f.store.openAsks(botId)[0]!.id } })
    expect(f.store.activation(activation.id)!.status).toBe('running')
    await finish(f, payload, 'completed', { text: 'Report: I could not run commands.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ mode: 'ask', fingerprint: shellFingerprint, title: 'run commands' }])
    const { message } = await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'not_now')
    expect(message.ask).toMatchObject({ status: 'not_now' })
    expect(f.store.activeGrant(botId)!.manifest.tools).not.toContain('shell')
    const next = await run('r2')
    expect(next.prepared.authority.check(command('ls'))).toEqual({ ok: false, refused: { text: BOT_ASK_NOT_NOW_TEXT, askId: '' } })
    // Not now holds for every kind of permission, and escalate says the same, never "Asked the owner".
    expect(next.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_NOT_NOW_TEXT)
    await finish(f, next.payload, 'completed', { text: 'Skipped.' })
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('About lists it with Remove; Remove takes it away again', async () => {
    const { payload, prepared } = await chat('Count my files', 'm1')
    prepared.authority.check(command('ls | wc -l'))
    await finish(f, payload, 'interrupted', { text: 'May I?', outcome: { interruptedBy: 'bot_wall' } })
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'allow')
    const detail = f.bots.service.get(botId)
    expect(detail.permissions.filter((item) => !item.builtIn)).toMatchObject([{ id: shellFingerprint, title: 'run commands', note: expect.stringContaining('Any command') }])
    expect(f.bots.service.revokePermission(botId, shellFingerprint).permissions.filter((item) => !item.builtIn)).toEqual([])
    expect(f.store.activeGrant(botId)!.manifest.tools).not.toContain('shell')
    expect(f.host.definitions.get(botId)!.published!.permissions.tools).not.toContain('shell')
    // The next run is refused again, and asks again.
    const after = await run('r1')
    expect(after.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await finish(f, after.payload, 'completed', { text: 'Skipped.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint }])
  })
})

describe('asks nobody needs', () => {
  it("a new bot's first message makes no card: it asks once the owner wants something", async () => {
    const created = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Pip', description: 'Keep my to-do list.', clientRequestId: 'create-pip' })
    const first = f.store.listActivations(created.bot.id).find((activation) => activation.lane === 'chat')!
    const { prepared, payload } = await start(f, first.id)
    expect(prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To save your lists.' })).toBe(BOT_ASK_NOT_YET_TEXT)
    await finish(f, payload, 'completed', { text: "I'll keep your to-do list." })
    expect(f.store.openAsks(created.bot.id)).toEqual([])
    expect(f.store.activation(first.id)).toMatchObject({ status: 'done' })
  })

  it('the web tools the starter grant holds are no ask: the chat hands the work off, and work has them', async () => {
    const { prepared, payload } = await chat('look something up', 'm-web')
    for (const tool of ['web_fetch', 'web_search'])
      expect(prepared.authority.escalate!({ permission: { tool }, reason: 'To read pages.' })).toBe(BOT_WORK_HAS_TEXT)
    await finish(f, payload, 'completed', { text: 'On it.' })
    const work = await run('r-web')
    for (const tool of ['web_fetch', 'web_search'])
      expect(work.prepared.authority.escalate!({ permission: { tool }, reason: 'To read pages.' })).toMatch(/^The owner already allowed this/)
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('an MCP tool is no ask in the chat either: no bot can hold one yet', async () => {
    const { prepared } = await chat('use my bank server', 'm-mcp')
    expect(prepared.authority.escalate!({ permission: { mcp: { serverId: 'bank', tool: 'balance' } }, reason: 'Needed.' })).toBe(BOT_MCP_UNAVAILABLE_TEXT)
    expect(f.store.openAsks(botId)).toEqual([])
  })
})

describe('a message sent while the chat waits on an ask', () => {
  it('gets a turn of its own when the waiting turn cannot continue', async () => {
    const { activation, prepared, payload } = await chat('sort my threads', 'm-wall')
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To read your threads.' })
    await finish(f, payload, 'completed', { text: 'I need your threads first.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'waiting_grant' })
    // About → Remove while it waits: the waiting turn keeps the old grant, so it can't go on.
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'web_search') }))
    await f.bots.service.chatSend({ botId, text: 'skip that, just list what you can', clientRequestId: 'm-instead' })
    await flush()
    expect(f.store.activation(activation.id)!.status).not.toBe('waiting_grant')
    const next = f.store.laneActivations(botId, 'chat', ['queued', 'running'])
    expect(next).toHaveLength(1)
    expect(next[0]!.trigger.input).toBe('skip that, just list what you can')
  })
})

describe('a card for one of the bot\'s own tools', () => {
  // A bot made before set_profile existed has none of it in its grant, so the owner's "call yourself Scout" asks for it.
  // The card and the line its answer leaves say what it does, never "use the set profile tool".
  it('reads in plain words, and Not now keeps them', async () => {
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'set_profile') }))
    const { payload, prepared } = await chat('Call yourself Scout.', 'm-rename')
    const call: NormalisedCall = { kind: 'app', tool: 'set_profile', args: { name: 'Scout' } }
    expect(prepared.authority.check(call)).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: 'change its name or description' } })
    await finish(f, payload, 'interrupted', { text: 'I need your OK first.', outcome: { interruptedBy: 'bot_wall' } })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply.ask).toMatchObject({ status: 'open', title: 'change its name or description' })
    expect(JSON.stringify(reply.ask)).not.toMatch(/set_profile|set profile/)
    const { message } = await f.bots.service.answer(botId, reply.ask!.askId, 'not_now')
    expect(askAnsweredLine('Penny', message.ask!)).toBe('You said not now to Penny: change its name or description')
  })
})

it('an unknown saved special ask is a plain permission card and Allow grants nothing', async () => {
  const before = f.store.activeGrant(botId)!.digest
  await f.bots.service.chatSend({ botId, text: 'Ask', clientRequestId: 'future' })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { payload, prepared } = await start(f, activation.id)
  prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'Ask' })
  await finish(f, payload, 'completed', { text: 'Allow?' })
  const ask = f.store.openAsks(botId)[0]!
  f.store.run('UPDATE bot_escalations SET permission_json = ?, title = NULL WHERE id = ?', JSON.stringify({ ask: 'future_ask' }), ask.id)
  expect(f.bots.chat.card(f.store.escalation(ask.id)!)).toMatchObject({ kind: 'permission' })
  await f.bots.service.answer(botId, ask.id, 'allow')
  expect(f.store.activeGrant(botId)!.digest).toBe(before)
  expect(f.store.all("SELECT key FROM bot_memory_state WHERE key GLOB 'alone:*'")).toEqual([])
})
