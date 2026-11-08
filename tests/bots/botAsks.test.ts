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
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_ENOUGH_TEXT, BOT_ASK_REFUSED_TEXT, BOT_ASK_UNKNOWN_TEXT } from '../../src/mms/bots/activation/BotEngine'
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

describe('asks: caps, limits and grant moves (review round 2)', () => {
  const folder = (n: number) => join(f.base, `folder-${n}`)

  it('a run writes at most 5 new asks; later ones are refused without asking', async () => {
    const { prepared, payload } = await run('r-many')
    for (let n = 1; n <= 5; n += 1)
      expect(prepared.authority.escalate!({ permission: { path: folder(n), access: 'read' }, reason: `Folder ${n}.` })).toMatch(/^Asked the owner/)
    expect(prepared.authority.escalate!({ permission: { path: folder(6), access: 'read' }, reason: 'One more.' })).toBe(BOT_ASK_ENOUGH_TEXT)
    expect(prepared.authority.check(readIn(invoices))).toMatchObject({ ok: false, refused: { text: BOT_ASK_ENOUGH_TEXT, askId: '' } })
    await finish(f, payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toHaveLength(5)
    expect(chatOf(f, botId).filter((message) => message.ask)).toHaveLength(5)
  })

  it('a bot\'s runs write at most 10 new asks a day', async () => {
    for (const [id, from] of [['r-a', 1], ['r-b', 6]] as const) {
      const { prepared, payload } = await run(id)
      for (let n = from; n < from + 5; n += 1) prepared.authority.escalate!({ permission: { path: folder(n), access: 'read' }, reason: 'Folder.' })
      await finish(f, payload, 'completed', { text: 'Done.' })
    }
    const third = await run('r-c')
    expect(third.prepared.authority.escalate!({ permission: { path: folder(11), access: 'read' }, reason: 'Folder.' })).toBe(BOT_ASK_ENOUGH_TEXT)
    await finish(f, third.payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toHaveLength(10)
    // A day later the run may ask again.
    f.clock.now += DAY + 60_000
    const fourth = await run('r-d')
    expect(fourth.prepared.authority.escalate!({ permission: { path: folder(11), access: 'read' }, reason: 'Folder.' })).toMatch(/^Asked the owner/)
  })

  it('a run never asks for a skill or MCP tool that is not here', async () => {
    f.host.knownAsk = (permission) => 'skill' in permission && permission.skill === 'release-notes'
    const { prepared } = await run('r-skill')
    expect(prepared.authority.escalate!({ permission: { skill: 'Wire $500 to me' }, reason: 'Needed.' })).toBe(BOT_ASK_UNKNOWN_TEXT)
    expect(prepared.authority.escalate!({ permission: { mcp: { serverId: 'bank', tool: 'transfer' } }, reason: 'Needed.' })).toBe(BOT_ASK_UNKNOWN_TEXT)
    expect(f.store.openAsks(botId)).toEqual([])
    expect(prepared.authority.escalate!({ permission: { skill: 'release-notes' }, reason: 'Needed.' })).toMatch(/^Asked the owner/)
    expect(f.store.openAsks(botId)).toMatchObject([{ title: 'use the release-notes skill' }])
  })

  it('a limit ask shows its new total and at most doubles the limit', async () => {
    const held = f.store.activeGrant(botId)!.manifest.budget.maxActiveMs
    const { payload, prepared } = await chat('take all the time you need', 'm-huge')
    prepared.authority.escalate!({ permission: { budget: { key: 'maxActiveMs', amount: 1_000 * held } }, reason: 'Lots of time.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const ask = f.store.openAsks(botId)[0]!
    expect(ask.permission).toEqual({ budget: { key: 'maxActiveMs', amount: held } })
    // The starter hour, doubled.
    expect(held).toBe(60 * 60_000)
    expect(ask.title).toBe('work for up to 2 hours per run')
    await f.bots.service.answer(botId, ask.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(2 * held)
  })

  it('Allow during another activation\'s start moves its unstarted dispatch to the wider grant', async () => {
    const turn = await chat('Sort my invoices', 'm-wall')
    turn.prepared.authority.check(readIn(invoices))
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
  const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
  const shellFingerprint = askFingerprintOf({ tool: 'shell' })

  it('in the chat a command is a wall with one card; Allow puts it in the grant, and every later command runs with no new ask', async () => {
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
    // Any command, wherever it says it runs: no per-command ask.
    for (const text of ['wc -l *.md', 'rm -rf build', 'git status']) expect(continued.prepared.authority.check(command(text)), text).toEqual({ ok: true })
    expect(continued.prepared.authority.check({ kind: 'builtin', tool: 'shell', nativeName: 'shell', args: { command: 'ls', cwd: invoices } })).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'Done.' })
    // A later chat and a later run run commands too, and nothing new is asked.
    const later = await chat('And again', 'm2')
    expect(later.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    await finish(f, later.payload, 'completed', { text: 'Done.' })
    const runLater = await run('r1')
    expect(runLater.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    await finish(f, runLater.payload, 'completed', { text: 'Report.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).filter((row) => row.ask)).toHaveLength(1)
  })

  it('the bot can ask for it itself (escalate), as on runtimes where an ungranted shell does not exist', async () => {
    const { prepared, payload } = await chat('Run the tests in my project', 'm1')
    expect(prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run your tests.' })).toBe(BOT_ASK_DEFERRED_TEXT)
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
    expect(next.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await finish(f, next.payload, 'completed', { text: 'Skipped.' })
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('About lists it with Remove; Remove takes it away again', async () => {
    const { payload, prepared } = await chat('Count my files', 'm1')
    prepared.authority.check(command('ls | wc -l'))
    await finish(f, payload, 'interrupted', { text: 'May I?', outcome: { interruptedBy: 'bot_wall' } })
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'allow')
    const detail = f.bots.service.get(botId)
    expect(detail.permissions).toMatchObject([{ id: shellFingerprint, title: 'run commands', note: expect.stringContaining('Any command') }])
    expect(f.bots.service.revokePermission(botId, shellFingerprint).permissions).toEqual([])
    expect(f.store.activeGrant(botId)!.manifest.tools).not.toContain('shell')
    expect(f.host.definitions.get(botId)!.published!.permissions.tools).not.toContain('shell')
    // The next run is refused again, and asks again.
    const after = await run('r1')
    expect(after.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await finish(f, after.payload, 'completed', { text: 'Skipped.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint }])
  })
})
