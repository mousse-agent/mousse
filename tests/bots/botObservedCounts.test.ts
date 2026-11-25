/**
 * A bot activation's counts (`bot_counters`) and spend (`bot_spend`) show what its turns did, whatever the runtime.
 * Pi charges each model request through its budget (`PreparedBotTurn.runtimeCounters`) and settles a reservation where
 * a spend limit runs; Claude Code, Codex and Antigravity do neither, so what their usage reports name is counted for
 * them (`recordObservedUsage`), never twice. The engine runs over a real `bots.db`; which runtime a turn has is what it
 * charged, as the orchestrator hands `runtimeCounters` to the runtime's budget (the hop is covered in
 * `botTurnUsage.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, createBot, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { reply: 'Hello! I am ready.' }))
})
afterEach(() => f.close())

async function chatTurn(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

const spent = (activationId: string) =>
  f.store.get('SELECT committed_input, committed_output, committed_usd_micros FROM bot_spend WHERE activation_id = ?', activationId)

describe('what a turn\'s runtime reports is counted for it, once', () => {
  // One request's report: 1,000 new tokens, 9,000 read from the cache and 200 written to it, 50 out, $0.0123.
  const report = { input: 1_000, output: 50, cacheRead: 9_000, cacheWrite: 200, costUsd: 0.0123 }
  const tokens = { inputTokens: 10_200, outputTokens: 50 }
  const spend = { committed_input: 10_200, committed_output: 50, committed_usd_micros: 12_300 }
  const none = { committed_input: 0, committed_output: 0, committed_usd_micros: 0 }

  it.each([
    // Claude Code, Codex, Antigravity: no budget of their own, no reservation.
    ['a runtime that counts nothing itself', { runtimeRequest: false, imageRequest: false, spendLimit: false }, { requests: 1, ...tokens }, spend],
    // An image tool charges its own request on the activation's counts; the runtime still counted none.
    ['the same, after an image tool made a request', { runtimeRequest: false, imageRequest: true, spendLimit: false }, { requests: 2, ...tokens }, spend],
    // Pi with no spend limit: its budget counted the request, and nothing settles the tokens.
    ['Pi with no spend limit', { runtimeRequest: true, imageRequest: false, spendLimit: false }, { requests: 1, ...tokens }, spend],
    // Pi under a spend limit: its reservation settles the tokens and cost on the activation's ledger.
    ['Pi under a spend limit', { runtimeRequest: true, imageRequest: false, spendLimit: true }, { requests: 1, inputTokens: 0, outputTokens: 0 }, none]
  ] as const)('%s', async (_name, runtime, counted, ledger) => {
    if (runtime.spendLimit) f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 1_000_000 } }))
    const turn = await chatTurn('What is on today?', 'u1')
    expect(Boolean(turn.prepared.authority.spend)).toBe(runtime.spendLimit)
    if (runtime.runtimeRequest) expect(turn.prepared.runtimeCounters!.charge('request')).toMatchObject({ ok: true })
    if (runtime.imageRequest) expect(turn.prepared.authority.counters.charge('request')).toMatchObject({ ok: true })
    turn.prepared.usage!(report)
    expect(f.store.counters(turn.activation.id)).toMatchObject(counted)
    expect(spent(turn.activation.id)).toEqual(ledger)
  })

  it('every report adds up, a report with no cost adds none, and a count past the bot\'s limit raises no wall', async () => {
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxTurns: 1 } }))
    const turn = await chatTurn('What is on today?', 'u1')
    turn.prepared.usage!(report)
    turn.prepared.usage!({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })
    expect(f.store.counters(turn.activation.id)).toMatchObject({ requests: 2, inputTokens: 10_300, outputTokens: 70 })
    expect(spent(turn.activation.id)).toEqual({ committed_input: 10_300, committed_output: 70, committed_usd_micros: 12_300 })
    // A measurement: the turn goes on, and nothing is asked of the owner.
    expect(f.store.activation(turn.activation.id)).toMatchObject({ status: 'running' })
    expect(f.store.openAsks(botId)).toEqual([])
  })
})
