/**
 * `TurnState.step`: what a running turn does while its transcript shows nothing yet (the line under
 * Working). A fake adapter drives the sink as a provider would; Claude's frames are read by `TurnFrames`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { ClaudeMetricsCollector } from '../../src/mms/harness/vendors/claude/metrics'
import { TurnFrames } from '../../src/mms/harness/vendors/claude/turnFrames'
import { getDefaultSettings } from '../../src/shared/settings'
import type { TurnState } from '../../src/shared/types'

type Seen = Pick<TurnState, 'phase' | 'step'>

class StepAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  orch!: OrchestratorService
  readonly seen: Array<{ at: string; state: Seen }> = []

  private look(at: string, threadId: string): void {
    const { phase, step } = this.orch.getTurnState(threadId)
    this.seen.push({ at, state: { phase, ...(step ? { step } : {}) } })
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    const providerRef = { provider: input.llmProvider, model: input.model, sessionId: 'fake-session' }
    sink.providerRef(providerRef)
    this.look('start', input.threadId)
    sink.status?.('waiting')
    this.look('waiting', input.threadId)
    sink.status?.('reasoning')
    this.look('reasoning', input.threadId)
    sink.retry(2, { maxAttempts: 5, delayMs: 3000 })
    this.look('retry', input.threadId)
    sink.progress()
    this.look('progress', input.threadId)
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: 'hello', contentIndex: 0 })
    this.look('text', input.threadId)
    sink.status?.('reasoning')
    this.look('reasoning after text', input.threadId)
    // A steered message reaches the model: it reads it next (the runtime reports output first, then the steer).
    sink.progress()
    sink.steerAccepted('also check the lint')
    this.look('steer', input.threadId)
    sink.text({ phase: 'complete', content: 'hello there', contentIndex: 0 })
    return {
      text: 'hello there',
      aborted: false,
      modelName: 'Fake Model',
      totalResponseTimeMs: 3,
      totalTokensUsed: 4,
      usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'fake-sig',
      nativeMessages: input.messages,
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('a running turn reports its step', () => {
  let home: string
  let engine: RunEngine
  let worker: EffectWorker
  let orch: OrchestratorService
  let store: ThreadDataStore
  let adapter: StepAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-steps-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(),
      new TaskQueue(),
      new WorktreeManager(home),
      new PtyManager(),
      { get: () => ({ ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, llmProvider: 'openai', model: 'gpt-x' } }) } as never,
      {} as never
    )
    orch.setThreadStore(store)
    adapter = new StepAdapter()
    adapter.orch = orch
    orch.setHarness(testHarness({ adapters: [adapter], profileHome: home }))
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    orch.recoverRunEngineOnBoot()
    worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
  })

  afterEach(async () => {
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('starting, waiting, reasoning and retrying, each dropped by output or a new phase', async () => {
    const thread = store.createThread('steps')
    const emitted: TurnState[] = []
    orch.on('turn-state', (state: TurnState) => { if (state.threadId === thread.id) emitted.push(state) })
    await orch.send('hi', false, { threadId: thread.id, clientRequestId: 'send-steps' })
    const byPoint = Object.fromEntries(adapter.seen.map(({ at, state }) => [at, state]))
    expect(byPoint.start).toEqual({ phase: 'thinking', step: { kind: 'starting' } })
    expect(byPoint.waiting).toEqual({ phase: 'thinking', step: { kind: 'waiting' } })
    expect(byPoint.reasoning).toEqual({ phase: 'thinking', step: { kind: 'reasoning' } })
    // The wait goes as a duration, so a window on another computer counts it down on its own clock.
    expect(byPoint.retry).toEqual({ phase: 'thinking', step: { kind: 'retrying', attempt: 2, maxAttempts: 5, delayMs: 3000 } })
    // The live line says it; nothing about the retry is saved to the transcript.
    expect(orch.getMessages(thread.id).some((message) => /retrying/i.test(message.content))).toBe(false)
    // Output ends a step.
    expect(byPoint.progress).toEqual({ phase: 'thinking' })
    expect(byPoint.text).toEqual({ phase: 'streaming' })
    expect(byPoint['reasoning after text']).toEqual({ phase: 'streaming', step: { kind: 'reasoning' } })
    expect(byPoint.steer).toEqual({ phase: 'streaming', step: { kind: 'waiting' } })
    // Each step reached the window as a turn-state event, and the turn ended without one.
    expect(emitted.map((state) => state.step?.kind ?? null)).toEqual(expect.arrayContaining(['starting', 'waiting', 'reasoning', 'retrying']))
    expect(emitted.at(-1)).toMatchObject({ phase: 'completed' })
    expect(emitted.at(-1)!.step).toBeUndefined()
    expect(orch.getTurnState(thread.id).step).toBeUndefined()
  })
})

describe("Claude's frames", () => {
  const stream = (event: Record<string, unknown>, parent: string | null = null) =>
    ({ type: 'stream_event', event, parent_tool_use_id: parent, session_id: 's1' }) as unknown as SDKMessage

  function reader() {
    const statuses: string[] = []
    const retries: unknown[] = []
    const thoughts: string[] = []
    const frames = new TurnFrames(
      { onText: () => undefined, onThinking: (text) => thoughts.push(text), onStatus: (status) => statuses.push(status), onRetry: (retry) => retries.push(retry) },
      new ClaudeMetricsCollector()
    )
    return { frames, statuses, retries, thoughts }
  }

  it('say waiting at the turn\'s first frame, and reasoning when a thinking block begins with no text yet', () => {
    const { frames, statuses, thoughts } = reader()
    frames.observe({ type: 'system', subtype: 'init', session_id: 's1' } as unknown as SDKMessage)
    expect(statuses).toEqual(['waiting'])
    frames.observe(stream({ type: 'message_start', message: { id: 'm1' } }))
    frames.observe(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    // The omitted summary streams an empty delta: there is still no thought to show.
    frames.observe(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }))
    expect(statuses).toEqual(['waiting', 'reasoning'])
    expect(thoughts).toEqual([])
    // A subagent's thinking is not the turn's.
    frames.observe(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'tool-1'))
    expect(statuses).toEqual(['waiting', 'reasoning'])
  })

  it('say waiting once: when the prompt reached a ready process, not again at its first frame', () => {
    const { frames, statuses } = reader()
    frames.waiting()
    frames.observe(stream({ type: 'message_start', message: { id: 'm1' } }))
    frames.waiting()
    expect(statuses).toEqual(['waiting'])
  })

  const retryFrame = (extra: Record<string, unknown> = {}) =>
    ({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4800, error_status: 529, error: 'overloaded', session_id: 's1', ...extra }) as unknown as SDKMessage

  it('report a retry of a failed request with its attempts and delay', () => {
    const { frames, retries } = reader()
    frames.observe(retryFrame())
    expect(retries).toEqual([{ attempt: 2, maxAttempts: 10, delayMs: 4800 }])
  })

  it('leave out the attempt count of a retry after no response, which has a cap of its own', () => {
    const { frames, retries } = reader()
    frames.observe(retryFrame({ attempt: 1, max_retries: 1, no_response: { waited_ms: 30000, retry_wait_ms: 60000 } }))
    expect(retries).toEqual([{ attempt: 1, delayMs: 4800, noResponse: true }])
  })

  it("do not show a retry as the turn's while a subagent of the turn runs, or one a subagent names", () => {
    const { frames, retries } = reader()
    frames.observe(retryFrame({ parent_tool_use_id: 'agent-call' }))
    frames.observe(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'agent-call', name: 'Agent', input: {} } }))
    frames.observe(retryFrame())
    expect(retries).toEqual([])
    // The subagent's call ended: a retry now is the turn's own.
    frames.observe({ type: 'user', parent_tool_use_id: null, session_id: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'done' }] } } as unknown as SDKMessage)
    frames.observe(retryFrame({ attempt: 3 }))
    expect(retries).toEqual([{ attempt: 3, maxAttempts: 10, delayMs: 4800 }])
  })
})
