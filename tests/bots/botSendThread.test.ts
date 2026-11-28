/**
 * `bot_send` as `thread_send` to `bot:<name>` (S7d4b2, docs/plans/tool-api.md §2.1), through the registered tool dispatch
 * a runtime's call takes (`createAppToolRegistry`), over a real engine and a real `bots.db`.
 *
 * What each case covers:
 * - a retry: `bot_send` and `thread_send` to `bot:<name>` with the same clientRequestId are one message, in either order
 * - a retry of a held message: the same hold, never a second; Continue sends it once; a retry after that is that message
 * - a retry of a message the owner stopped: refused again, nothing held or sent
 * - who reaches a bot: a turn without bot messaging is told so; a thread's agent is refused, and reads no bot nor sends
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultIntegrationActor } from '../../src/shared/integrations/actor'
import { MAX_BOT_MESSAGES_UNANSWERED_BY_OWNER } from '../../src/shared/bots/personal/botMessages'
import { canonicalGrantName, grantHoldsCall } from '../../src/shared/toolAliases'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let plusy: string
let alpha: string

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  plusy = (await createBot(f, { name: 'Plusy', description: 'Test the app and report what breaks.', reply: 'Hello.' })).botId
  alpha = (await createBot(f, { name: 'Alpha', description: 'Keep track of bugs.', reply: 'Hello.' })).botId
})
afterEach(() => f.close())

type Started = Awaited<ReturnType<typeof start>>

/** Calls from `turn` through the registry, under the retry key `key` (`mcp:<clientRequestId>`). */
function registryFor(turn: Started) {
  const host = fakeAppToolHost({ botRole: (id) => (id === turn.payload.threadId ? 'activation' : undefined) })
  const { registry, turns, request } = appToolRegistry(f.runs, host.host, { bots: () => ({ host: f.bots.tools }) })
  turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
  return async (name: string, args: Record<string, unknown>, key: string) => {
    const outcome = await registry.call(name, args, request({ threadId: turn.payload.threadId, runId: turn.payload.runId, toolCallId: key }))
    const refusal = refusalOf(outcome)
    return refusal ? { refused: refusal } : outcome.isError ? { error: outcome.text } : JSON.parse(outcome.text) as Record<string, unknown>
  }
}

/** The rows other bots' messages left in `botId`'s chat, as their text. */
const received = (botId: string) => chatOf(f, botId).filter((message) => message.id.startsWith('bm_botmsg_')).map((message) => message.text)
/** The chat turns other bots' messages started in `botId`. */
const messageTurns = (botId: string) => f.store.listActivations(botId).filter((row) => row.idempotencyKey.startsWith('botmsg:'))

/** The owner writes to `botId`; the chat turn their message started, running. */
async function chat(botId: string, text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  return start(f, f.store.laneActivations(botId, 'chat', ['running'])[0]!.id)
}

/** Plusy past its limit: Alpha sent it the most messages a bot takes without its owner; the first one's turn runs. */
async function plusyPastItsLimit() {
  await f.bots.service.chatSend({ botId: alpha, text: 'Tell Plusy everything.', clientRequestId: 'm1' })
  const told = await start(f, f.store.laneActivations(alpha, 'chat', ['running'])[0]!.id)
  for (let n = 1; n <= MAX_BOT_MESSAGES_UNANSWERED_BY_OWNER; n += 1)
    await f.bots.tools.bots!.send(alpha, told.payload.activationId, { to: 'Plusy', message: `Finding ${n}.` })
  await finish(f, told.payload, 'completed', { text: 'Told Plusy.' })
  await flush()
  return start(f, f.store.laneActivations(plusy, 'chat', ['running']).find((row) => row.idempotencyKey.startsWith('botmsg:'))!.id)
}

describe('a retry is one message', () => {
  it.each([
    ['bot_send, retried as thread_send', ['bot_send', { bot: 'Alpha', message: 'The login page returns a 500.' }], ['thread_send', { thread: 'bot:alpha', content: 'The login page returns a 500.' }]],
    ['thread_send, retried as bot_send', ['thread_send', { thread: 'bot:Alpha', content: 'The login page returns a 500.' }], ['bot_send', { bot: 'alpha', message: 'The login page returns a 500.' }]]
  ] as const)('%s with the same clientRequestId', async (_name, [firstName, firstArgs], [retryName, retryArgs]) => {
    const call = registryFor(await chat(plusy, 'If it is a bug, tell Alpha.', 'm1'))
    expect(await call(firstName, { ...firstArgs }, 'mcp:tell-1')).toMatchObject({ sent: true, to: 'Alpha' })
    // The model never saw the answer and retries under the other name.
    expect(await call(retryName, { ...retryArgs }, 'mcp:tell-1')).toMatchObject({ sent: true, to: 'Alpha', replayed: true })
    expect(received(alpha)).toEqual([expect.stringContaining('The login page returns a 500.')])
    expect(messageTurns(alpha)).toHaveLength(1)
    // A new request is a new message.
    expect(await call('thread_send', { thread: 'bot:Alpha', content: 'Signup fails too.' }, 'mcp:tell-2')).toMatchObject({ sent: true, to: 'Alpha' })
    expect(received(alpha)).toHaveLength(2)
  })

  it('a held message retried is the same hold; Continue sends it once, and a retry after that is that message', async () => {
    const call = registryFor(await plusyPastItsLimit())
    const held = await call('bot_send', { bot: 'Alpha', message: 'First: the login page returns a 500.' }, 'mcp:held-1')
    expect(held).toMatchObject({ status: 'held', to: 'Alpha', holdId: expect.stringMatching(/^bhold_/) })
    expect(await call('thread_send', { thread: 'bot:Alpha', content: 'First: the login page returns a 500.' }, 'mcp:held-1')).toMatchObject({ status: 'held', holdId: held.holdId, replayed: true })
    expect(f.store.heldChainSteps(plusy)).toHaveLength(1)
    expect(received(alpha)).toEqual([])

    expect(await f.bots.service.answerChainHold(plusy, held.holdId as string, 'continue')).toEqual({ sent: 1, stopped: 0, failed: 0 })
    expect(received(alpha)).toEqual([expect.stringContaining('First: the login page')])
    // Continue sent it under the id it was held with (`bhold_<message id>`), the id its row in Alpha's chat ends with.
    const messageId = String(held.holdId).slice('bhold_'.length)
    expect(chatOf(f, alpha).filter((message) => message.id.startsWith('bm_botmsg_')).map((message) => message.id)).toEqual([`bm_botmsg_${plusy}_${messageId}`])
    // A retry now finds it sent.
    expect(await call('thread_send', { thread: 'bot:Alpha', content: 'First: the login page returns a 500.' }, 'mcp:held-1')).toMatchObject({ sent: true, to: 'Alpha', replayed: true })
    expect(received(alpha)).toHaveLength(1)
    expect(f.store.heldChainSteps(plusy)).toEqual([])
  })

  it('a retry of a message the owner stopped is refused again, and holds or sends nothing', async () => {
    const call = registryFor(await plusyPastItsLimit())
    const held = await call('thread_send', { thread: 'bot:Alpha', content: 'The login page returns a 500.' }, 'mcp:held-2')
    expect(await f.bots.service.answerChainHold(plusy, held.holdId as string, 'stop')).toEqual({ sent: 0, stopped: 1, failed: 0 })
    expect(await call('bot_send', { bot: 'Alpha', message: 'The login page returns a 500.' }, 'mcp:held-2')).toMatchObject({ refused: { message: expect.stringContaining('chose Stop') } })
    expect(f.store.heldChainSteps(plusy)).toEqual([])
    expect(received(alpha)).toEqual([])
  })
})

describe('what a bot is shown and granted', () => {
  it('lists thread_send with the bot form, and bot_send no more; a grant of bot_send keeps its name and holds only that form', async () => {
    const turn = await chat(plusy, 'Tell Alpha.', 'm1')
    const host = fakeAppToolHost({ botRole: (id) => (id === turn.payload.threadId ? 'activation' : undefined) })
    const { registry, turns } = appToolRegistry(f.runs, host.host, { bots: () => ({ host: f.bots.tools }) })
    turns.register(appTurn({ threadId: turn.payload.threadId, runId: turn.payload.runId, accessLevel: 'manage', actor: defaultIntegrationActor(false), bot: turn.prepared.authority }))
    const listed = registry.listForThread(turn.payload.threadId, turn.payload.runId)
    expect(listed.map((tool) => tool.name)).not.toContain('bot_send')
    const send = listed.find((tool) => tool.name === 'thread_send')!
    expect(send.description).toContain('With thread "bot:<name>"')
    expect(Object.keys((send.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['thread', 'content']))
    // The grant keeps the old name (so its digest), and holds the message to a bot under either name, nothing else.
    expect(canonicalGrantName('bot_send')).toBe('bot_send')
    expect(grantHoldsCall('bot_send', 'bot_send', { bot: 'Alpha', message: 'x' })).toBe(true)
    expect(grantHoldsCall('bot_send', 'thread_send', { thread: 'bot:Alpha', content: 'x' })).toBe(true)
    for (const args of [{ thread: 'Fix login', content: 'x' }, { threadId: 'mine', content: 'x' }, { content: 'x' }])
      expect(grantHoldsCall('bot_send', 'thread_send', args), JSON.stringify(args)).toBe(false)
  })
})

describe('who reaches a bot', () => {
  it('a turn without bot messaging is told so, and nothing reads the bots or sends', async () => {
    const manual = await f.bots.activate({ botId: plusy, input: 'Check the site.', clientRequestId: 'by-hand' })
    await flush()
    const run = await start(f, manual.id)
    expect(run.prepared.authority.appTools.has('bot_send')).toBe(false)
    const list = vi.spyOn(f.bots.tools.bots!, 'list')
    const send = vi.spyOn(f.bots.tools.bots!, 'send')
    const call = registryFor(run)
    for (const [name, args] of [['thread_send', { thread: 'bot:Alpha', content: 'x' }], ['bot_send', { bot: 'Alpha', message: 'x' }]] as const)
      expect(await call(name, { ...args }, `mcp:${name}`), name).toMatchObject({ refused: { code: 'unavailable', message: expect.stringContaining("can't message your owner's other bots") } })
    expect(list).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(received(alpha)).toEqual([])
  })

  it('a thread\'s agent is refused, and reads no bot nor sends', async () => {
    const list = vi.spyOn(f.bots.tools.bots!, 'list')
    const send = vi.spyOn(f.bots.tools.bots!, 'send')
    const host = fakeAppToolHost({ threadMeta: (id) => (id === 'agent' ? { id, name: 'Fix login', createdAt: '', updatedAt: '', startedAt: '', projectId: 'p1' } as never : undefined) })
    const fx = delegationFixture()
    try {
      const run = await fx.runningRun('agent')
      const { registry, turns, request } = appToolRegistry(fx.engine, host.host, { bots: () => ({ host: f.bots.tools }) })
      turns.register(appTurn({ threadId: 'agent', runId: run.runId }))
      const outcome = await registry.call('thread_send', { thread: 'bot:Alpha', content: 'The login page returns a 500.' }, request({ threadId: 'agent', runId: run.runId, toolCallId: 'mcp:agent-1' }))
      expect(refusalOf(outcome)).toMatchObject({ code: 'unknown_address' })
    } finally {
      fx.dispose()
    }
    expect(list).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(received(alpha)).toEqual([])
  })
})
