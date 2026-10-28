/**
 * A parent thread with scripted subagents (issue #142): a real `OrchestratorService`, Run Engine and
 * effect worker over a temporary profile, with one scripted pi adapter serving the parent and every
 * subagent. A parent's turn runs the step registered for its prompt with the turn's delegation
 * tools, the same host the pi loop and the Mousse MCP server use. Call `useSubagentWorld()` inside a
 * `describe`; it registers the clean-up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { phase6Daemon, waitFor } from './phase6Fixture'

export type Json = Record<string, any>

export class ScriptedPi implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  readonly turns: Array<{ threadId: string; prompt: string; mode: string }> = []
  constructor(private readonly script: (input: TurnInput, delegation: DelegationToolHost | undefined, host: AdapterHost) => Promise<string>) {}
  configured(): boolean {
    return true
  }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push({ threadId: input.threadId, prompt: input.prompt, mode: input.mode })
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host.tools.delegation, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted', providerRef,
      nativeMessages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never]
    }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

export function useSubagentWorld() {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /**
   * A parent thread. `steps` maps a parent prompt to what it does with the delegation tools;
   * `child` answers every turn of every subagent (default: a quick result), and `parentReply`
   * every other parent turn (a wake, a queued steer).
   */
  return (
    child: (input: TurnInput, delegation: DelegationToolHost | undefined) => Promise<string> | string = (input) => `done: ${input.prompt.split('\n').at(-1)}`,
    parentReply: (input: TurnInput) => Promise<string> | string = () => 'Parent done.'
  ) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-world-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const steps: Record<string, (tools: DelegationToolHost, input: TurnInput) => Promise<void>> = {}
    const out: Record<string, Json> = {}
    let parentId = ''
    const adapter = new ScriptedPi(async (input, delegation) => {
      if (input.threadId !== parentId) return child(input, delegation)
      const step = steps[input.prompt]
      if (!step) return parentReply(input)
      await step(delegation!, input)
      return 'Parent done.'
    })
    const d = phase6Daemon(home, [adapter])
    stops.push(d.stop)
    const parent = d.store.createThread('Parent')
    parentId = parent.id
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })
    const say = (prompt: string, extra: { source?: string; origin?: 'schedule' } = {}) => d.orch.send(prompt, false, { threadId: parent.id, clientRequestId: `send:${prompt}:${Math.random()}`, ...extra })
    const start = (tools: DelegationToolHost, title: string, extra: Json = {}, id = `start:${title}`) =>
      tools.delegateTask({ prompt: `Review ${title}`, title, workspace: 'shared', role: 'research', ...extra } as never, { toolCallId: id }) as Promise<Json>
    const settled = (runId: string) => waitFor(() => ['completed', 'failed'].includes(d.engine.getRun(runId)?.status ?? ''), `run ${runId}`)
    return { d, adapter, parent, steps, out, say, start, settled, reconciler }
  }
}
