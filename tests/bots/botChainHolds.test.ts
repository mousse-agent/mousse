/**
 * What a bot holds for its owner past the limit between bots (issue #1443), over a real engine and a real `bots.db`: a
 * message to another bot past `MAX_BOT_MESSAGES_UNANSWERED_BY_OWNER`, or the same wake set again, waits in the sender's
 * chat for the owner's Continue or Stop instead of being refused.
 *
 * What each case covers:
 * - a held message: what the bot is told, the card, nothing sent; Continue sends them in order and renews the budget
 * - Stop: nothing sent, a line the bot reads in its chat; a second answer, or one for another bot, is `hold_settled`
 * - an answer covers what was held when it came: what the bot holds while Continue sends waits under a new card
 * - a held wake: never set again beside it, even after the owner writes
 * - a reset, a delete and the purge: what was held goes, and nothing can send it
 * - a crash: what is held survives a restart, and Continue after a crash midway sends each message once
 * - who may answer: only a person at a window on this computer, never the CLI, an agent or another device
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotChainHold } from '../../src/mms/bots/store/BotStore'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { MAX_BOT_MESSAGES_UNANSWERED_BY_OWNER } from '../../src/shared/bots/personal/botMessages'
import { MAX_SAME_WAKES } from '../../src/shared/bots/personal/wakes'
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

const tools = new Map(botTools(() => ({ host: f.bots.tools })).map((tool) => [tool.name, tool]))
async function tool(name: string, prepared: PreparedBotTurn, threadId: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const ctx = {
    caller: { threadId, runId: 'r', provider: 'pi', accessLevel: 'lineage' },
    turn: { threadId, bot: prepared.authority },
    toolCallId: `call-${Math.random()}`,
    signal: new AbortController().signal,
    transport: 'mcp'
  } as unknown as ToolCallContext
  return (tools.get(name) as MousseTool).handler(args, ctx)
}

const send = (from: string, turn: string, to: string, message: string) => f.bots.tools.bots!.send(from, turn, { to, message })
/** The rows other bots' messages left in `botId`'s chat, as their text. */
const received = (botId: string) => chatOf(f, botId).filter((message) => message.id.startsWith('bm_botmsg_')).map((message) => message.text)
const card = (botId: string) => f.bots.service.list().bots.find((bot) => bot.id === botId)!.chainHold
const answer = (botId: string, holdId: string, choice: 'continue' | 'stop') => f.bots.service.answerChainHold(botId, holdId, choice)

/**
 * Plusy past its limit: its owner asked Alpha to report everything, Alpha sent Plusy the most messages a bot takes
 * without its owner, and the turn the first of them started runs in Plusy's chat.
 */
async function plusyPastItsLimit() {
  await f.bots.service.chatSend({ botId: alpha, text: 'Tell Plusy everything.', clientRequestId: 'm1' })
  const told = await start(f, f.store.laneActivations(alpha, 'chat', ['running'])[0]!.id)
  for (let n = 1; n <= MAX_BOT_MESSAGES_UNANSWERED_BY_OWNER; n += 1) await send(alpha, f.store.laneActivations(alpha, 'chat', ['running'])[0]!.id, 'Plusy', `Finding ${n}.`)
  await finish(f, told.payload, 'completed', { text: 'Told Plusy.' })
  await flush()
  const activation = f.store.laneActivations(plusy, 'chat', ['running']).find((row) => row.idempotencyKey.startsWith('botmsg:'))!
  return { activation, ...(await start(f, activation.id)) }
}

describe('a message past the limit waits for the owner', () => {
  it('is held, not refused: the bot is told it waits, the chat shows Continue and Stop, and Continue sends them in order and lets it go on', async () => {
    const turn = await plusyPastItsLimit()
    const held = JSON.parse((await tool('bot_send', turn.prepared, turn.payload.threadId, { bot: 'Alpha', message: 'First: the login page returns a 500.' })).text)
    expect(held).toMatchObject({ status: 'held', to: 'Alpha', holdId: expect.stringMatching(/^bhold_/), note: expect.stringContaining('Continue and Stop') })
    // What it sends next waits behind it; the same words again are a loop.
    expect(await send(plusy, turn.activation.id, 'Alpha', 'Second: signup fails too.')).toMatchObject({ to: 'Alpha', held: { holdId: expect.any(String) } })
    await expect(send(plusy, turn.activation.id, 'Alpha', 'Second: signup fails too.')).rejects.toThrow('already waits for your owner')
    expect(received(alpha)).toEqual([])
    expect(card(plusy)).toEqual({ holdId: held.holdId, held: 2, to: ['Alpha'], wakes: 0 })
    expect(f.bots.service.list().bots.find((bot) => bot.id === plusy)!.needsOwner).toBe(true)

    expect(await answer(plusy, held.holdId, 'continue')).toEqual({ sent: 2, stopped: 0, failed: 0 })
    expect(received(alpha)).toEqual([expect.stringContaining('First: the login page'), expect.stringContaining('Second: signup fails')])
    expect(card(plusy)).toBeUndefined()
    // Continue gave Plusy a new budget, as its owner's message would.
    expect(await send(plusy, turn.activation.id, 'Alpha', 'Third: and the logout button.')).toEqual({ to: 'Alpha' })
    // A second answer to the same card does nothing.
    await expect(answer(plusy, held.holdId, 'stop')).rejects.toMatchObject({ code: 'hold_settled' })
  })

  it('Stop sends nothing and leaves the bot a line in its chat; a stale or another bot\'s batch is hold_settled', async () => {
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    await expect(answer(alpha, held!.holdId, 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    await expect(answer(plusy, 'bhold_unknown', 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    expect(await answer(plusy, held!.holdId, 'stop')).toEqual({ sent: 0, stopped: 1, failed: 0 })
    expect(received(alpha)).toEqual([])
    expect(chatOf(f, plusy).find((message) => message.id === `bm_chainhold_${held!.holdId}`)).toMatchObject({ author: 'bot', kind: 'notice', text: 'Not sent, as you chose Stop: the message to Alpha.' })
    expect(card(plusy)).toBeUndefined()
    await expect(answer(plusy, held!.holdId, 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    expect(received(alpha)).toEqual([])
  })

  it('a bot it was for that is gone by Continue: nothing is sent, and the bot reads why', async () => {
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    f.bots.pauseBot(alpha)
    expect(await answer(plusy, held!.holdId, 'continue')).toEqual({ sent: 0, stopped: 0, failed: 1 })
    expect(chatOf(f, plusy).find((message) => message.id === `bm_chainhold_${held!.holdId}`)?.text).toBe('Continue could not send the message to Alpha: Alpha is paused.')
    expect(received(alpha)).toEqual([])
  })
})

describe('what an answer covers', () => {
  it('Continue sends only what was held when the owner clicked: a message held while it sends waits under a new card', async () => {
    const turn = await plusyPastItsLimit()
    const first = (await send(plusy, turn.activation.id, 'Alpha', 'First.')).held!
    await send(plusy, turn.activation.id, 'Alpha', 'Second.')
    // While Continue sends the first, Plusy's turn sends a third: it waits behind the second, still held.
    const engine = f.bots as unknown as { continueHeld(hold: BotChainHold): Promise<boolean> }
    const continueHeld = engine.continueHeld.bind(f.bots)
    let third: { held?: { holdId: string } } | undefined
    engine.continueHeld = async (hold) => {
      const sent = await continueHeld(hold)
      third ??= await send(plusy, turn.activation.id, 'Alpha', 'Third.')
      return sent
    }
    expect(await answer(plusy, first.holdId, 'continue')).toEqual({ sent: 2, stopped: 0, failed: 0 })
    expect(received(alpha)).toEqual([expect.stringContaining('First.'), expect.stringContaining('Second.')])
    expect(third?.held).toBeDefined()
    expect(card(plusy)).toEqual({ holdId: third!.held!.holdId, held: 1, to: ['Alpha'], wakes: 0 })
  })

  it('a held wake is never set again beside it: not after the owner writes, and Continue sets one', async () => {
    const turnOf = async (text: string, id: string) => {
      await f.bots.service.chatSend({ botId: plusy, text, clientRequestId: id })
      const activation = f.store.laneActivations(plusy, 'chat', ['running'])[0]!
      return { activation, ...(await start(f, activation.id)) }
    }
    const due = () => new Date(f.clock.now + 5 * 60_000).toISOString()
    const wake = (from: string) => f.bots.tools.wakes!.add(plusy, from, { brief: 'Check the deploy.', dueAt: due() })
    let turn = await turnOf('Keep checking the deploy', 'w1')
    for (let n = 0; n < MAX_SAME_WAKES; n += 1) await wake(turn.activation.id)
    const held = await wake(turn.activation.id) as { held: { holdId: string } }
    expect(held.held.holdId).toMatch(/^bhold_/)
    await finish(f, turn.payload, 'completed', { text: 'Watching.' })
    // The owner writes: the count starts again, the held one still waits.
    f.clock.now += 60_000
    turn = await turnOf('Any news?', 'w2')
    const count = f.store.wakesSetSince(plusy, '').length
    await expect(wake(turn.activation.id)).rejects.toThrow('already waits for your owner')
    expect(await answer(plusy, held.held.holdId, 'continue')).toEqual({ sent: 1, stopped: 0, failed: 0 })
    expect(f.store.wakesSetSince(plusy, '').length).toBe(count + 1)
  })
})

describe('a reset, a delete and the purge', () => {
  it('a reset drops what the bot held: no card, and the answer sends nothing', async () => {
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    await finish(f, turn.payload, 'completed', { text: 'It waits for you.' })
    await f.bots.service.reset(plusy)
    expect(card(plusy)).toBeUndefined()
    await expect(answer(plusy, held!.holdId, 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    expect(received(alpha)).toEqual([])
  })

  it('a delete removes its rows, and so does the purge 30 days on', async () => {
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    await finish(f, turn.payload, 'completed', { text: 'It waits for you.' })
    await f.bots.service.delete(plusy)
    expect(f.store.chainHold(held!.holdId)).toBeUndefined()
    // A row left by a build before this one goes with the purge.
    const left = f.store.holdChainStep(plusy, 'message', { to: alpha, toName: 'Alpha', message: 'Left behind.' })
    f.clock.now += 31 * 24 * 3_600_000
    expect(await f.bots.sweepDeleted()).toContain(plusy)
    expect(f.store.chainHold(left.holdId)).toBeUndefined()
  })
})

describe('a crash', () => {
  it('between the hold and the answer: the card is still there after a restart, and Continue sends it once', async () => {
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    await f.restart({ crashed: true })
    expect(card(plusy)).toMatchObject({ holdId: held!.holdId, held: 1 })
    expect(await answer(plusy, held!.holdId, 'continue')).toEqual({ sent: 1, stopped: 0, failed: 0 })
    await expect(answer(plusy, held!.holdId, 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    expect(received(alpha)).toEqual([expect.stringContaining('The login page returns a 500.')])
  })

  it('midway through Continue: what went is not sent again, and the rest goes on the next Continue', async () => {
    const turn = await plusyPastItsLimit()
    const first = (await send(plusy, turn.activation.id, 'Alpha', 'First.')).held!
    await send(plusy, turn.activation.id, 'Alpha', 'Second.')
    // Continue sent the first, then Mousse stopped before the second.
    const engine = f.bots as unknown as { continueHeld(hold: BotChainHold): Promise<boolean> }
    expect(await engine.continueHeld(f.store.chainHold(first.holdId)!)).toBe(true)
    await f.restart({ crashed: true })
    expect(received(alpha)).toEqual([expect.stringContaining('First.')])
    // The card now names what still waits; an answer to the old one says it was answered.
    const rest = card(plusy)!
    expect(rest).toMatchObject({ held: 1 })
    await expect(answer(plusy, first.holdId, 'continue')).rejects.toMatchObject({ code: 'hold_settled' })
    expect(await answer(plusy, rest.holdId, 'continue')).toEqual({ sent: 1, stopped: 0, failed: 0 })
    expect(received(alpha)).toEqual([expect.stringContaining('First.'), expect.stringContaining('Second.')])
  })
})

describe('who may answer', () => {
  const base = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } }

  it('only a person at a window on this computer: never the CLI, an agent, MCP or another device', async () => {
    const domains = new DomainHandlerRegistry()
    registerPersonalBotMethods(domains, () => f.bots.service)
    const turn = await plusyPastItsLimit()
    const { held } = await send(plusy, turn.activation.id, 'Alpha', 'The login page returns a 500.')
    const params = { botId: plusy, holdId: held!.holdId, answer: 'continue' }
    const callers = [
      ...['cli', 'agent', 'mcp', undefined].map((clientType) => ({ connection: { ...base.connection, clientType } })),
      { connection: { ...base.connection, clientType: 'gui', bridgeCaller: { node: 'phone' } } }
    ]
    for (const caller of callers) await expect(domains.dispatch(caller as unknown as HandlerContext, 'bots.chainHold.answer', params)).rejects.toMatchObject({ code: 'forbidden' })
    expect(card(plusy)).toMatchObject({ holdId: held!.holdId })
    expect(received(alpha)).toEqual([])
    const gui = { connection: { ...base.connection, clientType: 'gui' } } as unknown as HandlerContext
    await expect(domains.dispatch(gui, 'bots.chainHold.answer', { ...params, answer: 'maybe' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await domains.dispatch(gui, 'bots.chainHold.answer', params)).toEqual({ sent: 1, stopped: 0, failed: 0 })
  })
})
