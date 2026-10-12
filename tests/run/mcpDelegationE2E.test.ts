/**
 * Phase 5 end to end (docs/run-engine/SPEC.md §15): a real `OrchestratorService`, Run Engine,
 * effect worker, reconciler and Mousse MCP server. A vendor-shaped adapter with `caps.mcp` receives
 * `AdapterHost.mcp` and, inside its turn, calls `delegate_task` over HTTP for a pi child, then
 * `task_status`. The child inherits the caller's plan ceiling; a broader request is refused.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { MacroEngine } from '../../src/mms/macros/MacroEngine'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AdapterRegistry } from '../../src/mms/run/adapters/AdapterRegistry'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { createMousseToolRegistry } from '../../src/mms/run/mcp/toolRegistry'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

type Mcp = NonNullable<AdapterHost['mcp']>

async function callTool(mcp: Mcp, name: string, args: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await response.json() as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { code: number; message: string; data?: { reason: string } } }
  return { status: response.status, body, value: body.result ? JSON.parse(body.result.content[0].text) : undefined }
}

/** A vendor runtime that reaches Mousse only over MCP; `script` is its model. */
class McpVendorAdapter implements ProviderAdapter {
  readonly id = 'claude-subscription'
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly hosts: Array<AdapterHost['mcp']> = []
  constructor(private readonly script: (input: TurnInput, mcp: Mcp) => Promise<string>) {}

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.hosts.push(host.mcp)
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    if (!host.mcp) throw new Error('expected the Mousse MCP server')
    const text = await this.script(input, host.mcp)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    host.context.nativeHistoryAfterTurn(text)
    return {
      text, aborted: false, modelName: 'vendor', totalResponseTimeMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'vendor', nativeMessages: [], providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/** The pi child: answers once `release()` is called and records the modes it ran in. */
class ChildPiAdapter implements ProviderAdapter {
  readonly id = 'pi'
  readonly capabilities = PI_LOOP_CAPABILITIES
  readonly turns: TurnInput[] = []
  readonly hosts: Array<AdapterHost['mcp']> = []
  release!: () => void
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve })

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    this.hosts.push(host.mcp)
    await this.gate
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const text = 'Plan: read run/, then report.'
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text, aborted: false, modelName: 'pi', totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'pi',
      nativeMessages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Mousse MCP delegation end to end (SPEC §15)', () => {
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

  it('a plan-ceiling vendor parent delegates to a pi child over HTTP; the child inherits the ceiling', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-mcp-e2e-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projects = new ProjectManager()
    const store = new ThreadDataStore(projects)
    const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, llmProvider: 'openai', model: 'gpt-replay' } }
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine, { get: () => settings } as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, undefined, projects
    )
    orch.setThreadStore(store)
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'scripted' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'scripted' }),
      generateTitle: async () => 'Scripted',
      chat: async () => { throw new Error('the scripted adapters replace the pi loop') }
    }

    const seen: { started?: any; firstStatus?: any; broader?: any; wakeStatus?: any; token?: string } = {}
    const vendor = new McpVendorAdapter(async (input, mcp) => {
      if (input.prompt === 'Plan the refactor') {
        seen.token = mcp.token
        const started = await callTool(mcp, 'delegate_task', {
          prompt: 'Survey the run engine', provider: 'openai', model: 'gpt-replay', workspace: 'shared', role: 'research', clientRequestId: 'survey-1'
        })
        seen.started = started.value
        // A retry with the same clientRequestId replays the first delegation.
        const retried = await callTool(mcp, 'delegate_task', {
          prompt: 'Survey the run engine', provider: 'openai', model: 'gpt-replay', workspace: 'shared', role: 'research', clientRequestId: 'survey-1'
        }, 2)
        expect(retried.value.delegationId).toBe(started.value.delegationId)
        expect(retried.value.replayed).toBe(true)
        seen.firstStatus = (await callTool(mcp, 'task_status', { delegationId: started.value.delegationId }, 3)).value
        seen.broader = await callTool(mcp, 'delegate_task', { prompt: 'Edit everything', workspace: 'isolated', modeCeiling: 'default' }, 4)
        return 'Delegated the survey.'
      }
      if (input.prompt.startsWith('Delegated task')) {
        seen.wakeStatus = (await callTool(mcp, 'task_status', { delegationId: seen.started.delegationId })).value
        return 'The survey is in.'
      }
      return 'unexpected turn'
    })
    const child = new ChildPiAdapter()
    orch.setAdapterRegistry(new AdapterRegistry().register(vendor).register(child))
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: 1 })
    orch.setRunEngine(engine)
    engine.reconcileOnBoot()
    const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
    const credentials = new McpCredentials(engine.store)
    const server = new MousseMcpServer({ credentials, registry: createMousseToolRegistry({ engine, host: orch.mcpToolHost() }) })
    await server.start()
    orch.setMcpAttachment(server)
    const reconciler = new Reconciler({ store: engine.store, outbox: engine.outbox, tools: engine.tools, capabilitiesFor: (id) => orch.capabilitiesForThread(id), credentials })
    stops.push(async () => {
      orch.setMcpAttachment(null)
      await server.stop()
      await worker.stop()
      orch.attachEffectWorker(null)
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
    })

    const parent = store.createThread('Parent')
    orch.setThreadModelOverride(parent.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const response = await orch.send({ content: 'Plan the refactor', mode: 'plan' }, false, { threadId: parent.id, clientRequestId: 'parent-send' })
    expect(response.runId).toBeTruthy()

    // The vendor turn received the server URL and its thread's bearer token, pointing at this run with the plan ceiling.
    expect(vendor.hosts[0]).toMatchObject({ url: server.url })
    expect(credentials.listForThread(parent.id)).toEqual([
      expect.objectContaining({ runId: response.runId, provider: 'claude-subscription', modeCeiling: 'plan' })
    ])
    // The turn's end does not revoke, but with no active run on the thread the token acts for nothing.
    expect(credentials.listForThread(parent.id)[0].revokedAt).toBeNull()
    const idle = await callTool({ url: server.url, token: seen.token! }, 'list_tasks', {})
    expect(idle.status).toBe(200)
    expect(idle.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_caller_not_live })

    // delegate_task created the lineage, the delegation row (with the inherited ceiling) and the child run.
    const delegation = engine.delegations.get(seen.started.delegationId)!
    expect(delegation).toMatchObject({ parentThreadId: parent.id, parentRunId: response.runId, provider: 'openai', modeCeiling: 'plan' })
    expect(engine.delegations.getLineage(delegation.childThreadId)).toMatchObject({ parentThreadId: parent.id, parentRunId: response.runId, relationship: 'subagent' })
    expect(seen.firstStatus).toMatchObject({ delegationId: delegation.delegationId, childThreadId: delegation.childThreadId, status: 'running' })
    expect(seen.broader.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_ceiling_exceeded, data: { reason: 'mousse_ceiling_exceeded' } })
    expect(engine.delegations.listForParentThread(parent.id)).toHaveLength(1)

    // The pi child ran in plan mode (its ceiling) without an MCP attachment (in-process ToolHost).
    child.release()
    await waitFor(() => engine.getRun(delegation.childRunId)?.status === 'completed', 'the child run')
    const childTurn = child.turns.find((turn) => turn.threadId === delegation.childThreadId)!
    expect(childTurn.mode).toBe('plan')
    expect(child.hosts).toEqual([null])

    // The child's result is a stored inbox row; rule 4 wakes the idle parent, which reads it over MCP.
    expect(engine.inbox.listPending(parent.id)).toHaveLength(1)
    const wakeRunId = reconciler.runOnce().wakes.wakes[0]
    expect(wakeRunId).toBeTruthy()
    await waitFor(() => engine.getRun(wakeRunId)?.status === 'completed', 'the wake run')
    expect(seen.wakeStatus).toMatchObject({ status: 'acknowledged', childRunStatus: 'completed', result: { runStatus: 'completed' } })
    expect(engine.inbox.listForThread(parent.id).map((row) => row.status)).toEqual(['acknowledged'])
    // The wake turn reused the thread's token; the stored row now points at the wake run.
    expect(vendor.hosts.map((mcp) => mcp?.token)).toEqual([seen.token, seen.token])
    expect(credentials.listForThread(parent.id).map((row) => [row.runId, row.modeCeiling, Boolean(row.revokedAt)])).toEqual([
      [wakeRunId, 'plan', false]
    ])

    // Deleting the thread revokes it.
    orch.markThreadDeleted(parent.id)
    expect((await callTool({ url: server.url, token: seen.token! }, 'list_tasks', {})).status).toBe(401)
    expect(credentials.listForThread(parent.id)[0].revokedAt).not.toBeNull()
  }, 30_000)
})
