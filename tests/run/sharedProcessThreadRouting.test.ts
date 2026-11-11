/**
 * One provider process serves several threads (Codex runs one app-server per profile). Its output events run in the
 * async context of the turn that spawned it, as a child's stdout does, so a turn's events must reach its own thread
 * whatever context delivers them: the sink, control and context calls a runtime makes belong to the turn they were
 * given to, never to the thread that happened to start the process.
 */
import { AsyncResource } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { createOrchestrator } from './phase6Fixture'

/** A runtime whose one process outlives turns and threads, its output delivered in the spawning turn's context. */
class SharedProcessAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  /** The process's output pipe: created by the first turn, as `spawn` creates it. */
  private stdout: AsyncResource | undefined

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.stdout ??= new AsyncResource('SharedProcessStdout')
    const stdout = this.stdout
    const reply = `Reply to ${input.prompt}`
    sink.providerRef({ provider: input.llmProvider, model: input.model, sessionId: `native-${input.threadId}` })
    // The process answers later, on its own output.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    stdout.runInAsyncScope(() => {
      sink.thinking({ phase: 'start', content: '' })
      sink.thinking({ phase: 'complete', content: `Thinking about ${input.prompt}` })
      sink.tool({ kind: 'mcp_tool_call', phase: 'start', callId: `cmd-${input.prompt}`, title: `Running sleep for ${input.prompt}`, summary: 'Bash', details: [] })
      sink.tool({ kind: 'mcp_tool_call', phase: 'complete', callId: `cmd-${input.prompt}`, title: `Running sleep for ${input.prompt}`, summary: 'Bash', details: [] })
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: reply, contentIndex: 0 })
      sink.text({ phase: 'complete', content: reply, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(reply)
    })
    return {
      text: reply,
      aborted: false,
      modelName: 'Shared',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'shared',
      nativeMessages: [],
      providerRef: { provider: input.llmProvider, model: input.model, sessionId: `native-${input.threadId}` }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('a provider process shared by threads', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-shared-proc-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store, [new SharedProcessAdapter()])
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const texts = (threadId: string): string[] =>
    orch.getMessages(threadId).map((message) => `${message.content ?? ''}${message.thinking?.content ?? ''}${message.toolCall?.title ?? ''}`)

  it('saves each turn in its own thread, not in the thread whose turn started the process', async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    const c = store.createThread('C')

    await orch.send('first in A', false, { threadId: a.id })
    await orch.send('first in B', false, { threadId: b.id })
    await orch.send('first in C', false, { threadId: c.id })

    for (const [thread, prompt] of [[a, 'first in A'], [b, 'first in B'], [c, 'first in C']] as const) {
      const own = texts(thread.id)
      expect(own).toContain(`Reply to ${prompt}`)
      expect(own).toContain(`Thinking about ${prompt}`)
      expect(own).toContain(`Running sleep for ${prompt}`)
      // Nothing of another thread's turn.
      for (const other of ['first in A', 'first in B', 'first in C'].filter((entry) => entry !== prompt))
        expect(own.filter((text) => text.includes(other))).toEqual([])
    }
    // Every turn ended: no thread is left working, and no row is left open.
    for (const thread of [a, b, c]) {
      expect(orch.isTurnActive(thread.id)).toBe(false)
      expect(orch.getMessages(thread.id).filter((message) => message.toolCall?.status === 'running' || message.thinking?.status === 'processing')).toEqual([])
    }
  })

  it('keeps a later turn in its own thread while the first thread runs again', async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    await orch.send('opening in A', false, { threadId: a.id })
    await Promise.all([
      orch.send('again in A', false, { threadId: a.id }),
      orch.send('meanwhile in B', false, { threadId: b.id })
    ])
    expect(texts(a.id).filter((text) => text.includes('meanwhile in B'))).toEqual([])
    expect(texts(b.id)).toContain('Reply to meanwhile in B')
    expect(texts(a.id)).toContain('Reply to again in A')
  })
})
