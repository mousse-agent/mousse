/**
 * A bot activation's counts (`bot_counters`) and spend (`bot_spend`) show what its turns did, whatever the runtime.
 * Pi charges each model request through its budget (`PreparedBotTurn.runtimeCounters`) and settles a reservation where
 * a spend limit runs; Claude Code, Codex and Antigravity do neither, so what their usage reports name is counted for
 * them (`recordObservedUsage`), never twice. The engine runs over a real `bots.db`; which runtime a turn has is what it
 * charged, as the orchestrator hands `runtimeCounters` to the runtime's budget (the hop is covered in
 * `botTurnUsage.test.ts`). Their Mousse app and relayed MCP tool calls are counted the same way
 * (`recordObservedToolCall`): once per call, where it runs (`BotAuthority.callRuns`), however many points check it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { botFilesFolder } from '../../src/mms/bots/grants/compile'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import type { BotAuthority, NormalisedCall } from '../../src/shared/bots/personal/authority'
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

  it('a report counts the requests it names: Claude Code\'s turn and Codex\'s run name theirs, ACP\'s sum counts as one', async () => {
    const turn = await chatTurn('What is on today?', 'u1')
    // Claude Code: one report at the end of a turn that made three requests (two tool rounds, then the answer).
    turn.prepared.usage!({ ...report, requests: 3 })
    expect(f.store.counters(turn.activation.id).requests).toBe(3)
    // ACP: a prompt's usage, summed over requests it does not name: at least one.
    turn.prepared.usage!({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })
    expect(f.store.counters(turn.activation.id).requests).toBe(4)
    // Pi counted its own: a report that names requests adds none.
    turn.prepared.runtimeCounters!.charge('request')
    turn.prepared.usage!({ ...report, requests: 2 })
    expect(f.store.counters(turn.activation.id).requests).toBe(5)
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

describe('a turn\'s app and MCP calls are counted for it, once each', () => {
  beforeEach(() => {
    // The owner's one MCP server, as `BotMcp` reads it from the relay's catalogue.
    const readNote: McpToolDescriptor = {
      id: 'srv-notes:read_note', serverId: 'mousse:srv-notes', installationId: 'srv-notes', serverName: 'Notes', toolName: 'read_note',
      providerName: 'mcp__Notes__read_note__otes', description: 'read_note of Notes', inputSchema: { type: 'object', properties: {} }, readOnlyHint: true
    }
    f.host.mcp = new BotMcp({
      catalog: {
        ensure: async () => undefined,
        servers: () => [{ installationId: 'srv-notes', serverName: 'Notes', tools: [readNote], failing: false, starting: false }],
        listing: () => [{
          name: 'Notes__read_note', description: readNote.description ?? '', inputSchema: readNote.inputSchema ?? {},
          installationId: 'srv-notes', serverName: 'Notes', toolName: 'read_note', providerName: readNote.providerName
        }]
      },
      manager: { callTool: async () => ({ content: [] }) as never },
      enabled: () => true
    })
  })

  async function work(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Read my notes.', clientRequestId: id })
    return { activation, ...(await start(f, activation.id)) }
  }

  const app = (tool: string, args: Record<string, unknown> = {}): NormalisedCall => ({ kind: 'app', tool, args })
  const note = (args: Record<string, unknown>): NormalisedCall => ({ kind: 'mcp', server: 'srv-notes', tool: 'read_note', args })

  const signal = () => new AbortController().signal
  /** The relay's run of an MCP call (Claude Code, Codex): checked by the bot's authority, then sent to its server. */
  const relayed = (authority: BotAuthority, args: Record<string, unknown>) =>
    callForBot({ bot: authority, mcp: f.host.mcp!, name: 'Notes__read_note', args, signal: signal(), known: () => ({ server: 'srv-notes', tool: 'read_note', serverName: 'Notes' }) })

  it('two identical calls are two, each counted once when it runs, however often it was checked', async () => {
    const turn = await work('w1')
    const { authority } = turn.prepared
    const counted = () => f.store.counters(turn.activation.id).toolCalls
    for (const n of [1, 2]) {
      // Locked Claude checks an app call at PreToolUse and canUseTool; the registry runs it (`callRuns`).
      expect(authority.check(app('theme_read'))).toMatchObject({ ok: true })
      expect(authority.check(app('theme_read'))).toMatchObject({ ok: true })
      expect(counted()).toBe(n - 1)
      authority.callRuns!()
      expect(counted()).toBe(n)
    }
    // The same MCP call twice, a second apart, through the relay: two calls reach the server, two are counted.
    f.clock.now += 1_000
    expect((await relayed(authority, { name: 'today' })).isError).toBeFalsy()
    f.clock.now += 1_000
    expect((await relayed(authority, { name: 'today' })).isError).toBeFalsy()
    expect(counted()).toBe(4)
  })

  it('one call checked at points far apart is one', async () => {
    const turn = await work('w1')
    const { authority } = turn.prepared
    // Claude's PreToolUse checks it, the owner's server is slow to start, and the relay runs it ten seconds later.
    expect(authority.check(note({ name: 'today' }))).toMatchObject({ ok: true })
    f.clock.now += 10_000
    expect((await relayed(authority, { name: 'today' })).isError).toBeFalsy()
    expect(f.store.counters(turn.activation.id).toolCalls).toBe(1)
    // A built-in is counted by its runtime's own gate (Claude's PreToolUse), never here.
    const files = botFilesFolder(f.profile, botId)
    mkdirSync(files, { recursive: true })
    writeFileSync(join(files, 'notes.md'), 'x')
    expect(authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(files, 'notes.md') } })).toMatchObject({ ok: true })
    expect(f.store.counters(turn.activation.id).toolCalls).toBe(1)
  })

  it('a refused call is not counted', async () => {
    await f.bots.service.chatSend({ botId, text: 'What is in my notes?', clientRequestId: 'm1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const talk = await start(f, activation.id)
    // A chat turn hands MCP work on to work: the relay's check refuses the call before it reaches the server.
    expect((await relayed(talk.prepared.authority, { name: 'today' })).isError).toBe(true)
    expect(f.store.counters(activation.id).toolCalls).toBe(0)
  })

  it('Pi\'s calls are counted by its budget only: once it charged a request, a call that runs counts none here', async () => {
    const turn = await work('w1')
    turn.prepared.runtimeCounters!.charge('request')
    turn.prepared.authority.callRuns!()
    expect((await relayed(turn.prepared.authority, { name: 'today' })).isError).toBeFalsy()
    expect(f.store.counters(turn.activation.id)).toMatchObject({ requests: 1, toolCalls: 0 })
  })
})
