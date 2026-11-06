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
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_REFUSED_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
let invoices: string
let notes: string

const DAY = 24 * 60 * 60_000
/** A read of a folder: a gate refusal asks for exactly the path the call named. */
const readIn = (folder: string): NormalisedCall => ({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: folder } })

beforeEach(async () => {
  f = botFixture()
  invoices = join(f.base, 'Invoices')
  notes = join(f.base, 'Notes')
  mkdirSync(invoices)
  mkdirSync(notes)
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
    const fingerprint = askFingerprintOf({ path: invoices, access: 'read' })
    for (const id of ['r1', 'r2', 'r3']) {
      const { activation, payload, prepared } = await run(id)
      const decided = prepared.authority.check(readIn(invoices))
      expect(decided).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
      // The run carries on: other calls are still checked as usual.
      expect(f.store.activation(activation.id)!.status).toBe('running')
      await finish(f, payload, 'completed', { text: `Report ${id}: I skipped the invoices.` })
      expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    }
    const asks = f.store.openAsks(botId)
    expect(asks).toMatchObject([{ mode: 'ask', fingerprint, title: `read files in ${invoices}`, expiresAt: null }])
    const cards = chatOf(f, botId).filter((message) => message.ask)
    expect(cards).toMatchObject([{ author: 'bot', kind: 'notice', text: `Penny wants to read files in ${invoices}.`, ask: { askId: asks[0]!.id, status: 'open', kind: 'permission' } }])
    expect(chatOf(f, botId).filter((message) => message.kind === 'run_report')).toHaveLength(3)
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'needs_you', stateText: `Wants to read files in ${invoices}` })
  })

  it('the bot\'s own escalate in a run asks once and carries on', async () => {
    const first = await run('r1')
    expect(first.prepared.authority.escalate!({ permission: { path: notes, access: 'write' }, reason: 'To tidy them.' })).toMatch(/^Asked the owner/)
    await finish(f, first.payload, 'completed', { text: 'Done what I could.' })
    const second = await run('r2')
    expect(second.prepared.authority.escalate!({ permission: { path: notes, access: 'write' }, reason: 'Again.' })).toMatch(/^Asked the owner/)
    // A gate refusal of the same permission finds the same ask.
    const gate = second.prepared.authority.check({ kind: 'builtin', tool: 'edit', nativeName: 'edit', args: { path: notes } })
    expect(gate).toMatchObject({ ok: false, refused: { askId: f.store.openAsks(botId)[0]!.id } })
    await finish(f, second.payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(f.store.activation(second.activation.id)!.status).toBe('done')
  })

  it('Not now holds off a new ask for 24 hours; then the run asks again', async () => {
    const first = await run('r1')
    first.prepared.authority.check(readIn(invoices))
    await finish(f, first.payload, 'completed', { text: 'Skipped.' })
    const askId = f.store.openAsks(botId)[0]!.id
    const { message } = await f.bots.service.answer(botId, askId, 'not_now')
    expect(message.ask).toMatchObject({ askId, status: 'not_now' })
    f.clock.now += DAY - 60_000
    const second = await run('r2')
    expect(second.prepared.authority.check(readIn(invoices))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await finish(f, second.payload, 'completed', { text: 'Skipped again.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).filter((row) => row.ask)).toHaveLength(1)
    f.clock.now += 2 * 60_000
    const third = await run('r3')
    third.prepared.authority.check(readIn(invoices))
    await finish(f, third.payload, 'completed', { text: 'Asked.' })
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(f.store.openAsks(botId)[0]!.id).not.toBe(askId)
  })

  it('an ask never expires', async () => {
    const first = await run('r1')
    first.prepared.authority.check(readIn(invoices))
    await finish(f, first.payload, 'completed', { text: 'Skipped.' })
    f.clock.now += 5 * DAY
    for (const timer of [...f.timers]) timer.fn()
    await flush()
    expect(f.store.openAsks(botId)).toMatchObject([{ status: 'open', expiresAt: null }])
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.workspace).toMatchObject({ roots: [invoices], access: 'read' })
  })
})

describe('asks in the chat', () => {
  it('a refusal is a wall: the card is on the reply, and the answer continues the turn', async () => {
    const { activation, payload, prepared } = await chat('Sort my invoices', 'm1')
    expect(prepared.authority.check(readIn(invoices))).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: `read files in ${invoices}` } })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    await finish(f, payload, 'interrupted', { text: 'I need to read your invoices first.', outcome: { interruptedBy: 'bot_wall' } })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply).toMatchObject({ author: 'bot', kind: 'text', text: 'I need to read your invoices first.', ask: { status: 'open', title: `read files in ${invoices}` } })
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
    // Only the folder is added: the rest of the grant is what it was.
    expect({ ...after.manifest, workspace: null }).toEqual({ ...before.manifest, workspace: null })
    expect(after.manifest.workspace).toMatchObject({ roots: [invoices], access: 'read' })
    expect(f.host.definitions.get(botId)!.published!.permissions.workspace).toMatchObject({ roots: [invoices] })
    // The waiting activation moved to the wider grant, and continues on its own history.
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'running', grantDigest: after.digest })
    const next = f.store.dispatch(activation.id, 2)!
    expect(next).toMatchObject({ kind: 'continue', prompt: { text: `[Mousse] The owner allowed: read files in ${invoices}. Continue.` } })
    const continued = await start(f, activation.id, 2)
    expect(continued.prepared).toMatchObject({ history: 'thread', lane: 'chat' })
    expect(continued.prepared.authority.check(readIn(invoices))).toEqual({ ok: true })
  })

  it('Remove in About narrows the grant again', async () => {
    const { payload, prepared } = await chat('Sort my invoices', 'm1')
    prepared.authority.check(readIn(invoices))
    await finish(f, payload, 'interrupted', { text: 'May I?', outcome: { interruptedBy: 'bot_wall' } })
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'allow')
    const detail = f.bots.service.get(botId)
    expect(detail.permissions).toMatchObject([{ id: askFingerprintOf({ path: invoices, access: 'read' }), title: `read files in ${invoices}`, note: 'Only this folder. It can\'t change anything.' }])
    const narrowed = f.bots.service.revokePermission(botId, detail.permissions[0]!.id)
    expect(narrowed.permissions).toEqual([])
    expect(f.store.activeGrant(botId)!.manifest.workspace).toBeNull()
    expect(f.host.definitions.get(botId)!.published!.permissions.workspace).toBeNull()
  })

  it('several asks in one turn show together; the turn continues once every card is answered', async () => {
    const { activation, payload, prepared } = await chat('Ask me now for everything you\'ll need', 'm1')
    expect(prepared.authority.escalate!({ permission: { path: invoices, access: 'read' }, reason: 'Invoices.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    // Asks are ordered by when they were made (two in the same millisecond order by id).
    f.clock.now += 1
    expect(prepared.authority.escalate!({ permission: { path: notes, access: 'write' }, reason: 'Notes.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    // The turn keeps running until its text is complete.
    expect(f.store.activation(activation.id)!.status).toBe('running')
    expect(prepared.authority.time.signal.aborted).toBe(false)
    await finish(f, payload, 'completed', { text: 'I need two things.' })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    const rows = chatOf(f, botId).filter((row) => row.activationId === activation.id && row.author === 'bot')
    expect(rows).toMatchObject([
      { kind: 'text', text: 'I need two things.', ask: { title: `read files in ${invoices}`, status: 'open' } },
      { kind: 'notice', text: `Penny wants to change files in ${notes}.`, ask: { title: `change files in ${notes}`, status: 'open' } }
    ])
    await f.bots.service.answer(botId, rows[0]!.ask!.askId, 'allow')
    expect(f.store.dispatch(activation.id, 2)).toBeUndefined()
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    await f.bots.service.answer(botId, rows[1]!.ask!.askId, 'not_now')
    const next = f.store.dispatch(activation.id, 2)!
    expect(next.prompt.text).toContain(`The owner allowed: read files in ${invoices}.`)
    expect(next.prompt.text).toContain(`The owner said not now: change files in ${notes}.`)
    expect(f.store.dispatch(activation.id, 3)).toBeUndefined()
  })

  it('an export_memory ask grants nothing', async () => {
    const before = f.store.activeGrant(botId)!.digest
    const { activation, payload, prepared } = await chat('Export your memory', 'm1')
    expect(prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })).toBe(BOT_ASK_DEFERRED_TEXT)
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
  it('never lists the starter grant (files folder, default tools)', async () => {
    expect(f.bots.service.get(botId).permissions).toEqual([])
    await runDispatch(f, (await f.bots.activate({ botId, input: 'x', clientRequestId: 'r1' })).id, 1, { text: 'ok' })
    expect(f.bots.service.get(botId).permissions).toEqual([])
  })
})

describe('asks across lanes and timing (review)', () => {
  it('a chat card is answered only once its message is there; until then the bot is not "needs you"', async () => {
    const { activation, payload, prepared } = await chat('ask me for my invoices', 'm-early')
    prepared.authority.escalate!({ permission: { path: invoices, access: 'read' }, reason: 'To sort them.' })
    const ask = f.store.openAsks(botId)[0]!
    expect(f.bots.service.get(botId).summary.state).toBe('working')
    await expect(f.bots.service.answer(botId, ask.id, 'allow')).rejects.toMatchObject({ code: 'ask_not_ready' })
    await finish(f, payload, 'completed', { text: 'May I read your invoices?' })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'needs_you', stateText: `Wants to read files in ${invoices}` })
  })

  it('a limit has one open ask whichever way it was raised', async () => {
    const { payload } = await run('limit-run')
    // A run that reached its time: it ends, with one ask for more.
    f.timers.at(-1)!.fn()
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.openAsks(botId).filter((ask) => ask.kind === 'budget')).toHaveLength(1)
    // The chat asking for the same limit takes that ask over rather than adding a second one.
    const turn = await chat('work longer please', 'm-limit')
    turn.prepared.authority.escalate!({ permission: { budget: { key: 'maxActiveMs', amount: 15 * 60_000 } }, reason: 'More time.' })
    expect(f.store.openAsks(botId).filter((ask) => 'budget' in ask.permission)).toHaveLength(1)
  })

  it('stopping a chat that took over a run\'s ask leaves that ask open for the owner', async () => {
    // The run's ask, raised by its refused call; the run ends done.
    const live = await run('r-moved')
    live.prepared.authority.check(readIn(notes))
    await finish(f, live.payload, 'completed', { text: 'Skipped the notes.' })
    const runAsk = f.store.openAsks(botId).find((ask) => 'path' in ask.permission)!
    expect(runAsk.mode).toBe('ask')
    // The chat hits the same permission: the run's ask becomes its wall.
    const turn = await chat('tidy my notes', 'm-moved')
    turn.prepared.authority.check(readIn(notes))
    expect(f.store.escalation(runAsk.id)).toMatchObject({ mode: 'wall', activationId: turn.activation.id, status: 'open' })
    await f.bots.service.chatStop(botId)
    expect(f.store.escalation(runAsk.id)).toMatchObject({ mode: 'ask', status: 'open' })
    expect(chatOf(f, botId).filter((message) => message.ask?.askId === runAsk.id).every((message) => message.ask!.status === 'open')).toBe(true)
  })

  it('a message sent while the chat waits at a limit starts a chat of its own', async () => {
    const turn = await chat('a long job', 'm-long')
    f.timers.at(-1)!.fn()
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
