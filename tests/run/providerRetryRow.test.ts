/**
 * A turn whose provider requests fail: the real error and its retry count reach the transcript and the run, the
 * retries are one row that turns recovered or becomes the error, and a passing failure the runtime did not retry is
 * sent again only when nothing of the turn happened. A real `OrchestratorService` and Run Engine over a temporary
 * profile, with a scripted adapter in place of the provider.
 *
 * Inputs: the runtime's own retries (recovered, ran out); a passing failure with no retries (before any output, after
 * a tool started, after the provider answered); a Stop during Mousse's wait; a failure that is not the provider's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterHost, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { providerStatusError } from '../../src/mms/orchestrator/providerErrors'
import type { RunRecord } from '../../src/mms/run/types'
import type { ChatMessage } from '../../src/shared/types'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { PI, ScriptedAdapter, phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 30_000 })

const REFUSED = 'Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'
const unreachable = (details?: Record<string, unknown>) =>
  providerStatusError(undefined, REFUSED, { provider: 'claude', code: 'provider_unavailable', errorInfo: { category: 'unavailable', retryable: true }, ...(details ? { details } : {}) })

/** What one call of the provider does before the scripted reply: report frames, or throw. */
type Step = (sink: TurnSink) => Promise<void> | void

class RetryAdapter extends ScriptedAdapter {
  readonly steps: Step[] = []
  calls = 0
  constructor() {
    super('pi', PI_TEST_CAPABILITIES, (input) => `reply: ${input.prompt}`)
  }

  override async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.calls += 1
    await this.steps.shift()?.(sink)
    return super.startTurn(input, sink, ctl, host)
  }
}

describe('a turn whose provider requests fail', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const boot = (adapter: RetryAdapter): Phase6Daemon => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-provider-retry-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    const daemon = phase6Daemon(home, [adapter], { pid: 1 })
    daemons.push(daemon)
    return daemon
  }

  const run = async (adapter: RetryAdapter, options: { wait?: boolean } = {}) => {
    const d = boot(adapter)
    const thread = d.store.createThread('Retries')
    d.orch.setThreadModelOverride(thread.id, PI)
    const sent = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'send', awaitMode: options.wait === false ? 'ack' : 'settled' })
    const runOf = (): RunRecord => d.engine.getRun(sent.runId!)!
    const messages = (): ChatMessage[] => d.orch.getMessages(thread.id)
    return { d, thread, runOf, messages }
  }

  const retryRows = (messages: ChatMessage[]) => messages.filter((message) => message.kind === 'provider_retry')

  it('retries the runtime made and then got through leave one row that says the provider recovered', async () => {
    const adapter = new RetryAdapter()
    adapter.steps.push((sink) => {
      sink.retry(1, { maxAttempts: 10, delayMs: 10, cause: 'connection error' })
      sink.retry(2, { maxAttempts: 10, delayMs: 10, cause: 'connection error' })
    })
    const { runOf, messages } = await run(adapter)

    expect(runOf().status).toBe('completed')
    const rows = retryRows(messages())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ content: 'Provider recovered after 2 retries', streaming: false, providerRetry: { status: 'recovered', attempt: 2, maxAttempts: 10 } })
    // The row is Mousse's, never the model's: the reply after it is the turn's answer.
    expect(messages().at(-1)).toMatchObject({ role: 'assistant', content: 'reply: Do the work' })
    expect(adapter.calls).toBe(1)
  })

  it('retries that ran out turn their row into the turn\'s error, with the provider\'s message and the count', async () => {
    const adapter = new RetryAdapter()
    adapter.steps.push((sink) => {
      for (let attempt = 1; attempt <= 10; attempt += 1) sink.retry(attempt, { maxAttempts: 10, delayMs: 10, cause: 'connection error' })
      throw unreachable()
    })
    const { runOf, messages } = await run(adapter)

    expect(runOf()).toMatchObject({ status: 'failed', outcome: { error: `[provider_unavailable] ${REFUSED} (after 10/10 retries)` } })
    expect(retryRows(messages())).toEqual([])
    const failures = messages().filter((message) => message.error)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ role: 'system', error: { code: 'provider_unavailable', message: REFUSED, details: { retries: { attempt: 10, max: 10 } } } })
    expect(messages().some((message) => /Something went wrong/.test(message.content))).toBe(false)
    // The runtime retried already: Mousse does not send the turn again on top.
    expect(adapter.calls).toBe(1)
  })

  it('a passing failure before the provider answered is sent again after a wait, and the row says it recovered', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const adapter = new RetryAdapter()
    adapter.steps.push(() => { throw unreachable() })
    const { runOf, messages } = await run(adapter)

    expect(adapter.calls).toBe(2)
    expect(runOf().status).toBe('completed')
    expect(retryRows(messages())).toEqual([expect.objectContaining({ content: 'Provider recovered after 1 retry', providerRetry: expect.objectContaining({ status: 'recovered', attempt: 1 }) })])
    expect(messages().at(-1)).toMatchObject({ role: 'assistant', content: 'reply: Do the work' })
  })

  it('a passing failure after a tool started is never sent again: the tool may have acted', async () => {
    const adapter = new RetryAdapter()
    adapter.steps.push((sink) => {
      sink.tool({ phase: 'start', callId: 'call-1', kind: 'mcp_tool_call', title: 'Write file', summary: '', details: [] })
      throw unreachable()
    })
    const { runOf } = await run(adapter)

    expect(adapter.calls).toBe(1)
    expect(runOf()).toMatchObject({ status: 'failed', outcome: { error: `[provider_unavailable] ${REFUSED}` } })
  })

  it('a passing failure after the provider answered is never sent again', async () => {
    const adapter = new RetryAdapter()
    adapter.steps.push((sink) => {
      sink.progress()
      throw unreachable()
    })
    const { runOf } = await run(adapter)

    expect(adapter.calls).toBe(1)
    expect(runOf().status).toBe('failed')
  })

  it('a Stop during the wait ends the turn there: nothing is sent again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const adapter = new RetryAdapter()
    adapter.steps.push(() => { throw unreachable() })
    const { d, thread, runOf, messages } = await run(adapter, { wait: false })
    await waitFor(() => retryRows(messages()).some((row) => row.providerRetry?.status === 'retrying'), 'the retry row')
    expect(d.orch.getTurnState(thread.id)).toMatchObject({ phase: 'thinking', step: { kind: 'retrying', attempt: 1 } })

    await d.orch.stopThread(thread.id, 'user')
    await waitFor(() => runOf().status === 'interrupted', 'the run to end')

    expect(adapter.calls).toBe(1)
    expect(retryRows(messages())).toEqual([expect.objectContaining({ streaming: false, providerRetry: expect.objectContaining({ status: 'stopped', attempt: 1 }) })])
  })

  it('a failure that is not the provider\'s keeps the generic line and its reference, and is not retried', async () => {
    const adapter = new RetryAdapter()
    adapter.steps.push(() => { throw new Error('internal invariant broke') })
    const { runOf, messages } = await run(adapter)

    expect(adapter.calls).toBe(1)
    expect(runOf()).toMatchObject({ status: 'failed', outcome: { error: expect.stringMatching(/^\[orchestrator_turn_failed\] Something went wrong\. .*Reference: /) } })
    expect(messages().filter((message) => message.error)).toHaveLength(1)
  })
})
