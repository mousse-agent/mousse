/**
 * Issue #983: a bot never shows an ask card for a permission its active grant already holds. A turn's permissions are
 * fixed when it starts, so a turn that was already running when the owner pressed Allow still lacks the permission.
 * Its `escalate` and its gate refusals are answered "you already have this" with no card and no count against the ask
 * caps; a chat turn hands the job to work, and running work continues in the same thread with the wider grant once its
 * turn ends.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_HELD_NEXT_TEXT, BOT_ASK_REFUSED_TEXT, BOT_WORK_HAS_TEXT } from '../../src/mms/bots/activation/BotEngine'
import type { BotBrowserHost } from '../../src/mms/bots/activation/dispatcher'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

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

  it('gets the browser the same way: one card, and its next turn has the browser', async () => {
    const work = await workStarted('Look up the weather', 'm1')
    expect(work.prepared.authority.check(browse)).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(work.prepared.authority.escalate!({ permission: { tool: 'browser_act' }, reason: 'To read the page.' })).toBe(BOT_ASK_HELD_NEXT_TEXT)
    expect(work.prepared.authority.check(browse)).toEqual({ ok: false, refused: { text: BOT_ASK_HELD_NEXT_TEXT, askId: '' } })
    expect(cards()).toHaveLength(1)
    await finish(f, work.payload, 'completed', { text: 'No browser yet.' })
    const continued = await start(f, work.workId, 2)
    expect(continued.prepared.authority.check(browse)).toEqual({ ok: true })
    expect(continued.prepared.browser).toBeDefined()
    expect(continued.prepared.prompt).toContain('use the browser')
    await finish(f, continued.payload, 'completed', { text: 'Sunny.' })
    expect(cards()).toHaveLength(1)
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
})
