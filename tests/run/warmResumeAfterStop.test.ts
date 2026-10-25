/**
 * Issue #142: a subagent that was stopped and is then continued resumes its native Claude session
 * instead of starting cold. A real orchestrator, run engine and adapter over the real provider
 * service, with only the SDK's `query` replaced.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CLAUDE, phase6Daemon, waitFor } from './phase6Fixture'

describe('stopping a Claude turn and continuing the thread (issue #142)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'vendor-session' }
  const started = { type: 'stream_event', session_id: 'vendor-session', parent_tool_use_id: null, event: { type: 'message_start' } }

  /** Turn 1 completes, turn 2 is stopped once the SDK has a session (or before, with `sessionFirst` false), turn 3 follows. */
  const stoppedThenContinued = async (sessionFirst: boolean) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-warm-resume-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const inputs: Array<{ options: Options; prompt: unknown }> = []
    let reachedSecondTurn = false
    const query = (input: { options: Options; prompt: unknown }): Query => {
      inputs.push(input)
      if (inputs.length !== 2) return Object.assign((async function* () { yield result })(), { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      // The second turn waits until it is stopped; stopping closes the query, which lets it end.
      let open!: () => void
      const gate = new Promise<void>((resolve) => { open = resolve })
      const events = (async function* () {
        if (sessionFirst) yield started
        reachedSecondTurn = true
        await gate
        yield started
      })()
      return Object.assign(events, { close: vi.fn(() => open()), interrupt: vi.fn(async () => {}) }) as unknown as Query
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(async () => service.stop())
    const d = phase6Daemon(home, [new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    const thread = d.store.createThread('Subagent')
    d.orch.setThreadModelOverride(thread.id, CLAUDE)

    await d.orch.send('one', false, { threadId: thread.id, clientRequestId: 'turn-1' })
    const second = d.orch.send('two', false, { threadId: thread.id, clientRequestId: 'turn-2' })
    second.catch(() => undefined)
    await waitFor(() => reachedSecondTurn, 'the second turn to start')
    const run = d.engine.listRuns(thread.id)[0]
    await d.orch.abortRun(run.runId, 'stop-2', thread.id)
    await second
    await waitFor(() => d.engine.getRun(run.runId)?.status === 'interrupted', 'the second run to end')
    await d.orch.send('three', false, { threadId: thread.id, clientRequestId: 'turn-3' })
    return { inputs, d, thread }
  }

  it('resumes the same native session on the turn after a stop', async () => {
    const { inputs } = await stoppedThenContinued(true)
    expect(inputs).toHaveLength(3)
    expect(inputs[1].options.resume).toBe('vendor-session')
    expect(inputs[2].options.resume).toBe('vendor-session')
  }, 30_000)

  it('starts the next turn fresh when the stop came before the SDK had a session', async () => {
    const { inputs } = await stoppedThenContinued(false)
    expect(inputs).toHaveLength(3)
    expect(inputs[1].options.resume).toBe('vendor-session')
    expect(inputs[2].options.resume).toBeUndefined()
  }, 30_000)
})
