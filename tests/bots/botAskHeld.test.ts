/**
 * Issue #983: a bot never shows an ask card for a permission its active grant already holds. A turn's permissions are
 * fixed when it starts, so a turn that was already running when the owner pressed Allow still lacks the permission.
 * Its `escalate` and its gate refusals are answered "you already have this" with no card and no count against the ask
 * caps; a chat turn hands the job to work, and running work continues in the same thread with the wider grant once its
 * turn ends.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_HELD_CHAT_TEXT, BOT_ASK_HELD_CONSULT_TEXT, BOT_ASK_HELD_NEXT_TEXT, BOT_ASK_HELD_UNAVAILABLE_TEXT, BOT_ASK_REFUSED_TEXT, BOT_WORK_HAS_TEXT, BotEngine } from '../../src/mms/bots/activation/BotEngine'
import type { BotBrowserHost } from '../../src/mms/bots/activation/dispatcher'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, PI, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
const browse: NormalisedCall = { kind: 'app', tool: 'browser_open', args: { url: 'https://example.com' } }
const shellFingerprint = askFingerprintOf({ tool: 'shell' })
const cards = () => chatOf(f, botId).filter((message) => message.ask)

beforeEach(async () => {
  f = botFixture()
  const browser: BotBrowserHost = {
    turn: () => ({ binding: { mode: 'structured' } as never, runtime: { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) } }),
    activationEnded: () => {}
  }
  f.host.browser = browser
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Learno', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

/** A chat turn hands work off and ends; the work starts, before anything is allowed. */
async function workStarted(text: string, id: string) {
  const turn = await chat(text, id)
  const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: text, brief: text, key: id })
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  return { workId, ...(await start(f, workId)) }
}

describe('work that was running when the owner pressed Allow', () => {
  it('asks for commands once: after Allow it gets no second card, and continues with commands in the same thread', async () => {
    const work = await workStarted('Is cua-driver installed?', 'm1')
    // The work asks; the owner allows while it still runs.
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check the program.' })).toMatch(/^Asked the owner/)
    expect(cards()).toHaveLength(1)
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
    // The same turn asks again, and calls a command: no new card, and it is told it has commands.
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    expect(work.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_NEXT_TEXT, askId: '' } })
    expect(cards()).toHaveLength(1)
    expect(f.store.openAsks(botId)).toEqual([])
    expect(f.store.escalations({ botId }).filter((row) => row.fingerprint === shellFingerprint)).toHaveLength(1)
    await finish(f, work.payload, 'completed', { text: 'I could not run commands yet.' })
    // It goes on in the same thread with commands, without being started again.
    expect(f.store.activation(work.workId)!.status).toBe('running')
    const continued = await start(f, work.workId, 2)
    expect(continued.payload.threadId).toBe(work.payload.threadId)
    expect(continued.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: true })
    expect(continued.prepared.prompt).toContain('run commands')
    await finish(f, continued.payload, 'completed', { text: 'cua-driver 1.2 is installed.' })
    expect(f.store.activation(work.workId)!.status).toBe('done')
    expect(chatOf(f, botId).filter((message) => message.kind === 'run_report').map((message) => message.text)).toEqual(['cua-driver 1.2 is installed.'])
    expect(cards()).toHaveLength(1)
  })

  it('asks for nothing the chat already got allowed: no card, and it continues with it', async () => {
    // The chat asks for commands and hands the work off in the same turn; the work starts at once, without commands.
    const turn = await chat('Run cua-driver', 'm1')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Run cua-driver', brief: 'Run cua-driver.', key: 'k' })
    await finish(f, turn.payload, 'completed', { text: 'I asked to run commands, and I am on it.' })
    const work = await start(f, workId)
    await f.bots.service.answer(botId, cards()[0]!.ask!.askId, 'allow')
    expect(work.prepared.authority.check(command('cua-driver'))).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_NEXT_TEXT, askId: '' } })
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    expect(cards()).toHaveLength(1)
    await finish(f, work.payload, 'completed', { text: 'Waiting for commands.' })
    const continued = await start(f, workId, 2)
    expect(continued.prepared.authority.check(command('cua-driver'))).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'Ran it.' })
    expect(cards()).toHaveLength(1)
  })

  it('gets the browser the same way through the app tools, though it never asks: one card, and its next turn has the browser', async () => {
    const work = await workStarted('Look up the weather', 'm1')
    // The work's browser calls go through the app-tool registry, as in the app.
    const fx = delegationFixture()
    try {
      const run = await fx.runningRun('bot-home')
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      turns.register(appTurn({ threadId: 'bot-home', runId: run.runId, bot: work.prepared.authority }))
      const open = () => registry.call('browser_open', { url: 'https://example.com' }, request({ threadId: 'bot-home', runId: run.runId }))
      // Not allowed yet: it is told how to ask, and nothing is asked for it.
      expect(await open()).toEqual({ text: 'Not allowed: you may not use the browser on this turn. If you need it, ask your owner with escalate (tool "browser").', isError: true })
      expect(cards()).toEqual([])
      // The owner allows the browser from the chat; the work never calls escalate.
      const other = await chat('Use the browser from now on', 'm2')
      expect(other.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'For the weather.' })).toBe(BOT_ASK_DEFERRED_TEXT)
      await finish(f, other.payload, 'completed', { text: 'Asked.' })
      await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
      expect(await open()).toEqual({ text: BOT_ASK_HELD_NEXT_TEXT, isError: true })
      expect(cards()).toHaveLength(1)
    } finally {
      fx.dispose()
    }
    await finish(f, work.payload, 'completed', { text: 'No browser yet.' })
    const continued = await start(f, work.workId, 2)
    expect(continued.prepared.authority.check(browse)).toEqual({ ok: true })
    expect(continued.prepared.browser).toBeDefined()
    expect(continued.prepared.prompt).toContain('use the browser')
    await finish(f, continued.payload, 'completed', { text: 'Sunny.' })
    expect(f.store.activation(work.workId)!.status).toBe('done')
    expect(cards()).toHaveLength(1)
  })

  it('a turn that ends without completing after Allow is followed by one that has it, and that one\'s report is the report', async () => {
    f.candidates = [{ instanceId: 'claude:main', model: 'claude-x' }, PI]
    const work = await workStarted('Is cua-driver installed?', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    // A usage limit ends the turn; it is tried again, now with commands.
    await finish(f, work.payload, 'failed', { outcome: { error: 'provider_usage_limit', usageLimitUntil: new Date(f.clock.now + 3_600_000).toISOString() } })
    const retried = await start(f, work.workId, 2)
    expect(retried.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: true })
    await finish(f, retried.payload, 'completed', { text: 'cua-driver 1.2 is installed.' })
    expect(f.store.dispatch(work.workId, 3)).toBeUndefined()
    expect(f.store.activation(work.workId)!.status).toBe('done')
    // Besides the card, only the report: no notice of a turn that had it, and no further turn.
    expect(chatOf(f, botId).filter((message) => message.activationId === work.workId && !message.ask).map((message) => [message.kind, message.text])).toEqual([['run_report', 'cua-driver 1.2 is installed.']])
  })

  it('a restart in the middle of the turn continues it once, with the permission, and no further turn follows', async () => {
    const work = await workStarted('Is cua-driver installed?', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    // Only 15 seconds of the prepaid allowance are charged, as a supervisor that saw the processes end records.
    const dispatch = f.store.dispatch(work.workId, 1)!
    f.store.run('UPDATE bot_dispatches SET prepaid_ms = 15000, exit_at = ? WHERE activation_id = ? AND n = 1', f.clock.now, work.workId)
    f.store.run('UPDATE bot_counters SET active_ms = active_ms - ? + 15000 WHERE activation_id = ?', dispatch.prepaidMs!, work.workId)
    // Mousse stops: the run ends interrupted, and the refusals kept in memory are gone with the old engine.
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush(12)
    const continued = await start(f, work.workId, 2)
    expect(continued.prepared.prompt).toContain('Mousse restarted')
    expect(continued.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'cua-driver 1.2 is installed.' })
    expect(f.store.dispatch(work.workId, 3)).toBeUndefined()
    expect(f.store.activation(work.workId)!.status).toBe('done')
  })

  it('with too little work time left it reports what it has, and does not continue', async () => {
    const work = await workStarted('Is cua-driver installed?', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    f.clock.now += f.store.activeGrant(botId)!.manifest.budget.maxActiveMs - 20_000
    await finish(f, work.payload, 'completed', { text: 'I could not check: no commands yet.' })
    expect(f.store.dispatch(work.workId, 2)).toBeUndefined()
    expect(f.store.activation(work.workId)!.status).toBe('done')
    expect(chatOf(f, botId).filter((message) => message.kind === 'run_report').map((message) => message.text)).toEqual(['I could not check: no commands yet.'])
  })

  it('on a runtime that would not offer commands, it is told it can\'t use them on this turn, and does not continue', async () => {
    f.host.harness.botWithheldTools = () => ['shell']
    const work = await workStarted('Is cua-driver installed?', 'm1')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })).toMatch(/^Asked the owner/)
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_HELD_UNAVAILABLE_TEXT)
    expect(cards()).toHaveLength(1)
    await finish(f, work.payload, 'completed', { text: 'Commands can\'t run here, so I skipped the check.' })
    expect(f.store.dispatch(work.workId, 2)).toBeUndefined()
    expect(f.store.activation(work.workId)!.status).toBe('done')
  })

  it('Not now and then Allow from the chat: it continues with it', async () => {
    const work = await workStarted('Is cua-driver installed?', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'not_now')
    const turn = await chat('Fine, run commands', 'm2')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'The owner agreed.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_NEXT_TEXT, askId: '' } })
    await finish(f, work.payload, 'completed', { text: 'Not yet.' })
    const continued = await start(f, work.workId, 2)
    expect(continued.prepared.authority.check(command('cua-driver --version'))).toEqual({ ok: true })
    expect(continued.prepared.prompt).toContain('run commands')
    await finish(f, continued.payload, 'completed', { text: 'cua-driver 1.2 is installed.' })
    expect(f.store.activation(work.workId)!.status).toBe('done')
    expect(cards()).toHaveLength(2)
  })

  it('gets file access the same way', async () => {
    const work = await workStarted('Read my notes', 'm1')
    const read: NormalisedCall = { kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'notes.md') } }
    expect(work.prepared.authority.check(read)).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.check(read)).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_NEXT_TEXT, askId: '' } })
    expect(work.prepared.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'Notes.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    expect(cards()).toHaveLength(1)
    await finish(f, work.payload, 'completed', { text: 'Not yet.' })
    const continued = await start(f, work.workId, 2)
    expect(continued.prepared.authority.check(read)).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'Read them.' })
  })

  it('work that never needed the new permission ends as it would have', async () => {
    const work = await workStarted('Sum my numbers', 'm1')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Maybe later.' })).toMatch(/^Asked the owner/)
    const other = await chat('Also check the browser', 'm2')
    expect(other.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'For later.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    await finish(f, other.payload, 'completed', { text: 'Asked.' })
    // The browser is allowed; the work only ever wanted commands, which are still not allowed.
    await f.bots.service.answer(botId, cards().find((message) => message.ask!.title === 'use the browser')!.ask!.askId, 'allow')
    await finish(f, work.payload, 'completed', { text: 'The sum is 42.' })
    expect(f.store.activation(work.workId)!.status).toBe('done')
  })

  it('a permission removed in About while the work waits is not used, and is asked for again', async () => {
    const work = await workStarted('Is cua-driver installed?', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Again.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    f.bots.service.revokePermission(botId, shellFingerprint)
    expect(f.store.activeGrant(botId)!.manifest.tools).not.toContain('shell')
    // Commands are not held any more: the running turn is refused and asks again, and it never continues with them.
    expect(work.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint }])
    await finish(f, work.payload, 'completed', { text: 'Stopped.' })
    expect(f.store.dispatch(work.workId, 2)).toBeUndefined()
    expect(f.store.activation(work.workId)!.status).toBe('done')
    // A later turn asks again, as it does today.
    const again = await chat('Run it now', 'm2')
    expect(again.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    await finish(f, again.payload, 'completed', { text: 'Asked.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: shellFingerprint }])
  })
})

describe('a chat turn that was running when the owner pressed Allow', () => {
  it('hands commands and the browser to work instead of making a second card', async () => {
    const work = await workStarted('Check cua-driver', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    work.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To read its page.' })
    expect(cards()).toHaveLength(2)
    // The owner writes again; that turn starts, and then the owner allows both cards.
    const turn = await chat('Now run it', 'm2')
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toBe(BOT_WORK_HAS_TEXT)
    expect(turn.prepared.authority.check(command('cua-driver'))).toEqual({ ok: false, refused: { text: BOT_WORK_HAS_TEXT, askId: '' } })
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'browser_open' }, reason: 'To look.' })).toBe(BOT_WORK_HAS_TEXT)
    expect(turn.prepared.authority.check(browse)).toEqual({ ok: false, refused: { text: BOT_WORK_HAS_TEXT, askId: '' } })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    expect(f.store.activation(turn.activation.id)!.status).toBe('done')
    expect(cards()).toHaveLength(2)
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('uses file access itself: it finishes its reply, then continues in the chat with it', async () => {
    const work = await workStarted('Sort my notes', 'm1')
    work.prepared.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'To read them.' })
    const turn = await chat('What do my notes say?', 'm2')
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    const read: NormalisedCall = { kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'notes.md') } }
    expect(turn.prepared.authority.check(read)).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_CHAT_TEXT, askId: '' } })
    expect(turn.prepared.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'To read them.' })).toBe(BOT_ASK_HELD_CHAT_TEXT)
    expect(cards()).toHaveLength(1)
    await finish(f, turn.payload, 'completed', { text: 'Let me look.' })
    const continued = await start(f, turn.activation.id, 2)
    expect(continued.prepared.prompt).toContain('use files on this computer')
    expect(continued.prepared.authority.check(read)).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'They list three errands.' })
    expect(f.store.activation(turn.activation.id)!.status).toBe('done')
    expect(chatOf(f, botId).filter((message) => message.activationId === turn.activation.id && message.author === 'bot').map((message) => message.text)).toEqual(['Let me look.', 'They list three errands.'])
    expect(cards()).toHaveLength(1)
  })

  it('a consult is told it can\'t use it, without a card, and not to hand work off', async () => {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
    const work = await workStarted('Check cua-driver', 'm1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To check.' })
    work.prepared.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'To read its notes.' })
    const turn = await chat('What does the doc say about it?', 'm2')
    const asked = turn.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await flush()
    const consultN = f.store.dispatches(turn.activation.id).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = f.bots.prepare(payloadOf(f, turn.activation.id, consultN))
    if ('refused' in consult) throw new Error(consult.refused)
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    expect(consult.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toBe(BOT_ASK_HELD_CONSULT_TEXT)
    expect(consult.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'To read it.' })).toBe(BOT_ASK_HELD_CONSULT_TEXT)
    expect(cards()).toHaveLength(2)
    void asked.catch(() => undefined)
  })
})
