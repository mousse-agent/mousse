/**
 * Bot context phase 0 (docs/plans/bot-context.md): each main turn of a bot keeps what it cost and carried in
 * `bots.db` (`bot_turn_usage`), and About shows one line of it. The rows: what started the turn, its model and context,
 * its usage summed over the runtime's reports, the prompt it last sent, the gap since the bot's previous request, the
 * Mousse tools it was offered, and the plan's usage windows. The last hop (the orchestrator's turn sink feeding
 * `PreparedBotTurn.usage`/`metrics`, and the runtime's budget charging `PreparedBotTurn.runtimeCounters`) is covered at
 * the end, through the real sink.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { createOrchestrator, piAdapter } from '../run/phase6Fixture'
import { turnStartedBy } from '../../src/mms/bots/activation/turnUsage'
import { observeRateLimit, RejectedWindows } from '../../src/mms/harness/vendors/claude/usageLimit'
import { quotaOf } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

describe('a bot turn keeps what it cost', () => {
  let f: BotFixture
  let botId: string
  beforeEach(async () => {
    f = botFixture()
    f.host.toolList = () => ({ count: 3, chars: 1200 })
    ;({ botId } = await createBot(f, { reply: 'Hello! I am ready.' }))
  })
  afterEach(() => f.close())

  async function chatTurn(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  it('a chat turn sums its runtime\'s reports and keeps its last prompt, window, cache lifetime, model and plan use', async () => {
    const turn = await chatTurn('What is on today?', 'u1')
    turn.prepared.usage!({ input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0 })
    f.clock.now += 2_000
    turn.prepared.usage!({ input: 200, output: 80, cacheRead: 10_000, cacheWrite: 300 })
    turn.prepared.metrics!({
      totalResponseTimeMs: 3_000, realModelName: 'some/model-2026',
      context: { input: 200, cacheRead: 10_000, cacheWrite: 300, contextWindow: 200_000 },
      promptCache: { at: f.clock.now, ttlMs: 3_600_000 },
      quota: [{ kind: 'five_hour', usedPercent: 42, resetsAt: 1_800_000_000 }]
    })
    await finish(f, turn.payload, 'completed', { text: 'Two meetings.' })
    const row = f.store.turnUsage(turn.activation.id, 1)!
    expect(row).toMatchObject({
      botId, lane: 'chat', startedBy: 'chat', instanceId: 'pi:openrouter', model: 'some/model-2026', contextGen: turn.activation.id, freshContext: true,
      reports: 2, input: 1200, output: 130, cacheRead: 19_000, cacheWrite: 300,
      lastPrompt: 10_500, contextWindow: 200_000, cacheTtlMs: 3_600_000, tools: 3, toolsChars: 1200,
      quota: [{ kind: 'five_hour', usedPercent: 42, resetsAt: 1_800_000_000 }]
    })
    // What the turn carried: its system text, its pack and the owner's words.
    expect(row.systemChars).toBe(turn.prepared.instructions!.length)
    expect(row.preambleChars).toBe(turn.prepared.preamble!.length)
    expect(row.promptChars).toBe(turn.prepared.prompt.length)
    // About's context and cache: the last request's size and window, the turn's split, and when the cache was fed.
    expect(f.bots.service.get(botId).context).toEqual({
      used: 10_500, window: 200_000, model: 'some/model-2026', turn: { cacheRead: 19_000, cacheWrite: 300, fresh: 1200 },
      lastRequestAt: f.clock.now, cacheTtlMs: 3_600_000
    })
  })

  it('the gap is measured from the bot\'s previous request in the same lane, and About shows the week as one line', async () => {
    const first = await chatTurn('Hi', 'u1')
    first.prepared.usage!({ input: 4000, output: 10, cacheRead: 0, cacheWrite: 6000 })
    await finish(f, first.payload, 'completed', { text: 'Hi.' })
    const answeredAt = f.clock.now
    f.clock.now += 90_000
    const second = await chatTurn('And now?', 'u2')
    second.prepared.usage!({ input: 1000, output: 30, cacheRead: 9000, cacheWrite: 0 })
    await finish(f, second.payload, 'completed', { text: 'Still here.' })
    // The bot's first message reported nothing, so the first turn has no request to measure from.
    expect(f.store.turnUsage(first.activation.id, 1)!.gapMs).toBeUndefined()
    expect(f.store.turnUsage(second.activation.id, 1)!.gapMs).toBe(f.store.turnUsage(second.activation.id, 1)!.startedAt - answeredAt)
    // Two turns that sent 10k each, 9k of the 20k read from the cache.
    expect(f.bots.service.get(botId).usage).toMatchObject({ turns: 2, inputPerTurn: 10_000, cachedShare: 0.45 })
  })

  it('a turn with no report yet is not in About; a failing measurement never fails the turn', async () => {
    const turn = await chatTurn('Hi', 'u1')
    expect(f.bots.service.get(botId).usage).toBeUndefined()
    expect(f.bots.service.get(botId).context).toBeUndefined()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.host.toolList = () => { throw new Error('registry gone') }
    try {
      expect(() => turn.prepared.usage!({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).not.toThrow()
    } finally { warn.mockRestore() }
    expect(f.store.turnUsage(turn.activation.id, 1)).toMatchObject({ reports: 1, tools: null })
  })
})

it.each([
  [{ lane: 'chat', idempotencyKey: 'chat:abc', trigger: { kind: 'manual', input: '' } }, 'chat'],
  [{ lane: 'chat', idempotencyKey: 'answer:q1', trigger: { kind: 'manual', input: '' } }, 'answer'],
  [{ lane: 'chat', idempotencyKey: 'botmsg:x', trigger: { kind: 'manual', input: '' } }, 'botmsg'],
  [{ lane: 'chat', idempotencyKey: 'create:b1', trigger: { kind: 'manual', input: '' } }, 'create'],
  [{ lane: 'run', idempotencyKey: 'sched:1', trigger: { kind: 'schedule', input: '', scheduleId: 's', occurrenceAt: '' } }, 'schedule'],
  [{ lane: 'run', idempotencyKey: 'work:1', trigger: { kind: 'work', input: '', title: 't', from: 'a' } }, 'work']
] as const)('what started the turn: %o is %s', (row, startedBy) => {
  expect(turnStartedBy(row as never)).toBe(startedBy)
})

describe('the plan usage a runtime reports with a turn', () => {
  it('Claude Code: every rate-limit event with a utilization, the latest per window, whatever its status', () => {
    const seen = new RejectedWindows()
    const event = (info: Record<string, unknown>) => observeRateLimit({ type: 'rate_limit_event', rate_limit_info: info } as never, seen)
    event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: 1_800_000_000 })
    event({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1_800_000_000 })
    event({ status: 'allowed', rateLimitType: 'seven_day' })
    // A turn going on clears a rejection, never what was used.
    observeRateLimit({ type: 'assistant', message: {} } as never, seen)
    expect(seen.planUse()).toEqual([{ kind: 'five_hour', usedPercent: 82, resetsAt: 1_800_000_000 }])
  })

  it('Codex: the primary and secondary windows of its snapshot', () => {
    expect(quotaOf({ primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: null } })).toEqual([
      { kind: 'primary', usedPercent: 40, resetsAt: 1_800_000_000 },
      { kind: 'secondary', usedPercent: 7 }
    ])
    expect(quotaOf({ primary: null, secondary: null })).toBeUndefined()
    expect(quotaOf(undefined)).toBeUndefined()
  })
})

it('the real turn sink hands a bot turn its runtime\'s usage and measurements', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bot-turn-usage-'))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  const db = new ProfileDatabase({ profileHome: home })
  const threads = new ThreadDataStore(new ProjectManager())
  const orch = createOrchestrator(home, threads)
  try {
    const thread = threads.createThread('Bot usage')
    const usage = vi.fn()
    const metrics = vi.fn()
    const adapter = piAdapter(() => 'Done.')
    const original = adapter.startTurn.bind(adapter)
    adapter.startTurn = async (input, sink, ctl, host) => {
      // As Pi's engine does before each model request: its budget charges the turn's counts.
      host.budget?.request()
      sink.usage({ input: 120, output: 7, cacheRead: 3400, cacheWrite: 0, costUsd: 0.002, requests: 1 })
      sink.providerMetrics({ totalResponseTimeMs: 10, context: { input: 120, cacheRead: 3400, cacheWrite: 0, contextWindow: 128_000 } })
      return original(input, sink, ctl, host)
    }
    orch.setHarness(testHarness({ drivers: [{ ...adapterDriver(adapter), botAuthority: () => true }], profileHome: home }))
    // The runtime's budget charges `runtimeCounters`, so the engine knows the runtime counted its own request; an image
    // tool charges `authority.counters`.
    const runtimeCounters = { charge: vi.fn(() => ({ ok: true as const, count: 1 })) }
    const counters = { charge: vi.fn(() => ({ ok: true as const, count: 1 })) }
    const bot = {
      activationId: 'chat', dispatchN: 1, prompt: 'Hi', usage, metrics, runtimeCounters,
      selection: { instanceId: 'openai', model: 'gpt-replay' },
      policy: { approvals: 'grants', approve: 'host', tools: { allow: [] }, authority: { kind: 'bot', digest: 'd' } },
      authority: { time: { signal: new AbortController().signal }, appTools: new Set<string>(), check: () => ({ ok: true }), counters },
      scratch: home, skills: [], history: 'none'
    }
    const engine = new RunEngine({ store: new RunStore(db) })
    orch.setRunEngine(engine)
    const sent = await engine.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: 'usage', source: 'bot' }, runId => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'chat', dispatchN: 1 }))
    if (sent.status !== 'accepted') throw new Error('run refused')
    await (orch as any).runTurnOnSession(orch.getOrCreateSession(thread.id), { content: 'Hi', mode: 'agent' }, false, true, { bot, runId: sent.runId, source: 'bot' })
    expect(usage).toHaveBeenCalledWith({ input: 120, output: 7, cacheRead: 3400, cacheWrite: 0, costUsd: 0.002, requests: 1 })
    expect(runtimeCounters.charge).toHaveBeenCalledWith('request', undefined)
    expect(counters.charge).not.toHaveBeenCalled()
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ cacheRead: 3400, contextWindow: 128_000 }) }))
  } finally {
    await new Promise(resolve => setImmediate(resolve))
    orch.setRunEngine(null)
    db.close()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
