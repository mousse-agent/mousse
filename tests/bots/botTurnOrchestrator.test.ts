/**
 * The orchestrator's hops of a bot turn, through the real `runTurnOnSession` and turn sink: `PreparedBotTurn.beforeBind`
 * is read right before the turn binds (a refusal binds and starts nothing; otherwise the policy it compiled then is the
 * one bound), and a bot's steer is attached only once its runtime runs (its first progress), so a note is never taken
 * by a turn whose setup then fails.
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

describe('a bot turn through the orchestrator', () => {
  let home: string
  let previousHome: string | undefined
  let db: ProfileDatabase
  let threads: ThreadDataStore
  let orch: ReturnType<typeof createOrchestrator>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bot-turn-orch-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    db = new ProfileDatabase({ profileHome: home })
    threads = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, threads)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise(resolve => setImmediate(resolve))
    orch.setRunEngine(null)
    db.close()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  const policyOf = (digest: string) => ({ approvals: 'grants', approve: 'host', tools: { allow: [] }, authority: { kind: 'bot', digest } })

  /** A bot turn on a Pi runtime (which takes steers) whose `startTurn` is `run`, then the real orchestrator. */
  async function botTurn(run: (sink: { progress(): void }, original: () => Promise<unknown>) => Promise<unknown>, bot: Record<string, unknown> = {}) {
    const thread = threads.createThread('Bot turn')
    const adapter = piAdapter(() => 'Done.')
    const original = adapter.startTurn.bind(adapter)
    const startTurn = vi.fn((input: Parameters<typeof original>[0], sink: Parameters<typeof original>[1], ctl: Parameters<typeof original>[2], host: Parameters<typeof original>[3]) => run(sink, () => original(input, sink, ctl, host)))
    adapter.startTurn = startTurn as unknown as typeof adapter.startTurn
    orch.setHarness(testHarness({ drivers: [{ ...adapterDriver(adapter), botAuthority: () => true }], profileHome: home }))
    const engine = new RunEngine({ store: new RunStore(db) })
    orch.setRunEngine(engine)
    const steer = { attached: vi.fn(), peek: () => undefined, take: () => undefined, accepted: vi.fn(), handedBack: vi.fn(), compacted: vi.fn() }
    const prepared = {
      activationId: 'work', dispatchN: 1, prompt: 'Hi', steer,
      selection: { instanceId: 'openai', model: 'gpt-replay' },
      policy: policyOf('prepared'),
      authority: { time: { signal: new AbortController().signal }, appTools: new Set<string>(), check: () => ({ ok: true }), counters: { charge: () => ({ ok: true as const, count: 1 }) } },
      scratch: home, skills: [], history: 'none',
      ...bot
    }
    const bindTurn = vi.spyOn(orch as any, 'bindTurn')
    const sent = await engine.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: 'turn', source: 'bot' }, runId => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'work', dispatchN: 1 }))
    if (sent.status !== 'accepted') throw new Error('run refused')
    const turn = (orch as any).runTurnOnSession(orch.getOrCreateSession(thread.id), { content: 'Hi', mode: 'agent' }, false, true, {
      bot: prepared, runId: sent.runId, source: 'bot', externalDrainSteer: () => undefined, externalPeekSteer: () => undefined
    }) as Promise<{ error?: unknown }>
    return { turn, steer, startTurn, bindTurn }
  }

  it.each([
    ['its runtime fails before it runs: never attached, so a note sent meanwhile is refused, not taken and lost', false],
    ['its runtime runs: attached at its first progress, once', true]
  ])('a bot\'s steer — %s', async (_name, runs) => {
    const { turn, steer, startTurn } = await botTurn(async (sink, original) => {
      if (!runs) throw new Error('the runtime could not start')
      sink.progress()
      sink.progress()
      return original()
    })
    await turn.catch(() => undefined)
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(steer.attached).toHaveBeenCalledTimes(runs ? 1 : 0)
  })

  it('beforeBind refusing: the turn fails with its code, and nothing binds or starts', async () => {
    const { turn, startTurn, bindTurn } = await botTurn((_sink, original) => original(), { beforeBind: () => ({ refused: 'Its grant was narrowed.', code: 'bot_grant_revoked' }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await turn).toMatchObject({ error: { code: 'bot_grant_revoked', message: 'Its grant was narrowed.' } })
    expect(bindTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('beforeBind allowing: the turn binds to the policy compiled then, not the one prepared earlier', async () => {
    const { turn, startTurn, bindTurn } = await botTurn((_sink, original) => original(), { beforeBind: () => ({ policy: policyOf('now') }) })
    await turn
    expect(bindTurn).toHaveBeenCalledTimes(1)
    expect(bindTurn.mock.calls[0]!.at(-1)).toMatchObject({ authority: { digest: 'now' } })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })
})
