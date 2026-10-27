/**
 * What a delegated child is created with (plan v2 §3.1): lineage in its thread metadata, the owner
 * in the lifecycle store, and the model and workspace it was started on, which later turns use
 * instead of re-resolving them from today's settings or the parent's session.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { PI, phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

/** A pi-shaped adapter that records the model and working directory of each turn. */
class RecordingAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  readonly turns: Array<{ threadId: string; model: string; provider: string; cwd: string | null }> = []

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    this.turns.push({ threadId: input.threadId, model: input.model, provider: input.llmProvider, cwd: input.cwd })
    sink.providerRef({ provider: input.llmProvider, model: input.model })
    const text = `answer to ${input.prompt}`
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never],
      providerRef: { provider: input.llmProvider, model: input.model }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('delegated child creation', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (home) {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
    home = undefined
  })

  const setup = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-creation-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const adapter = new RecordingAdapter()
    const d = (daemon = phase6Daemon(home, [adapter]))
    const settings = (d.orch as unknown as { settingsStore: { get: () => { provider: { model: string } } } }).settingsStore.get()
    return { d, adapter, home, settings }
  }

  /** A parent thread with one completed run. `explicitModel` pins the parent to PI; otherwise it follows the default. */
  const parentWithRun = async (d: Phase6Daemon, options: { projectDir?: string; explicitModel?: boolean } = {}) => {
    const project = options.projectDir ? d.projects.openProject(options.projectDir) : undefined
    const parent = d.store.createThread('Parent', project?.id)
    if (options.explicitModel) d.orch.setThreadModelOverride(parent.id, PI)
    const sent = await d.orch.send('Plan', false, { threadId: parent.id, clientRequestId: 'parent-1' })
    return { parent, parentRunId: sent.runId! }
  }

  const delegate = (d: Phase6Daemon, parentId: string, parentRunId: string, extra: Record<string, unknown> = {}) =>
    d.engine.requestDelegation({
      parentThreadId: parentId,
      parentRunId,
      clientRequestId: `delegation:${parentRunId}:${Math.random()}`,
      prompt: 'Inspect the module',
      workspace: 'isolated',
      wake: 'settled_only',
      ...extra
    })

  const evictSession = (d: Phase6Daemon, threadId: string) =>
    (d.orch as unknown as { sessions: Map<string, unknown> }).sessions.delete(threadId)

  it('writes lineage, the owner, the workspace policy and the model with the new child', async () => {
    const { d } = setup()
    const { parent, parentRunId } = await parentWithRun(d, { explicitModel: true })
    const accepted = await delegate(d, parent.id, parentRunId)
    const child = d.store.getThread(accepted.childThreadId)!
    expect(child).toMatchObject({
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' },
      workspaceBinding: { policy: 'isolated' },
      modelOverride: { llmProvider: PI.llmProvider, model: PI.model }
    })
    expect(d.store.lifecycleStore.require(child.id).parentTaskId).toBe(parent.id)
    expect(d.engine.delegations.getLineage(child.id)).toMatchObject({ parentThreadId: parent.id })
  })

  it('pins a child that inherited the default model, so a later settings change does not move it', async () => {
    const { d, adapter, settings } = setup()
    const { parent, parentRunId } = await parentWithRun(d)
    expect(d.store.getThread(parent.id)?.modelOverride).toBeUndefined()
    const accepted = await delegate(d, parent.id, parentRunId)
    expect(d.store.getThread(accepted.childThreadId)?.modelOverride).toMatchObject({ model: PI.model })
    await waitFor(() => d.engine.getRun(accepted.childRunId)?.status === 'completed', 'the child run')
    expect(adapter.turns.at(-1)).toMatchObject({ threadId: accepted.childThreadId, model: PI.model })

    // The default changes and the child's session is rebuilt from storage (a restart, an eviction).
    settings.provider.model = 'gpt-changed'
    evictSession(d, accepted.childThreadId)
    await d.orch.send('Again', false, { threadId: accepted.childThreadId, clientRequestId: 'child-2' })
    expect(adapter.turns.at(-1)).toMatchObject({ threadId: accepted.childThreadId, model: PI.model })
  })

  it('pins a child asked for a specific model to that model', async () => {
    const { d, adapter } = setup()
    const { parent, parentRunId } = await parentWithRun(d, { explicitModel: true })
    const accepted = await delegate(d, parent.id, parentRunId, { instanceId: 'pi:openai', model: 'gpt-special' })
    expect(d.store.getThread(accepted.childThreadId)?.modelOverride).toMatchObject({ instanceId: 'pi:openai', model: 'gpt-special' })
    await waitFor(() => d.engine.getRun(accepted.childRunId)?.status === 'completed', 'the child run')
    expect(adapter.turns.at(-1)).toMatchObject({ threadId: accepted.childThreadId, model: 'gpt-special' })
  })

  it('a shared child keeps the workspace path it was created with after the parent moves elsewhere', async () => {
    const { d, adapter, home: dir } = setup()
    const projectDir = join(dir, 'project')
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(projectDir)
    mkdirSync(elsewhere)
    const { parent, parentRunId } = await parentWithRun(d, { projectDir, explicitModel: true })
    const accepted = await delegate(d, parent.id, parentRunId, { role: 'research', workspace: 'shared' })
    expect(d.store.getThread(accepted.childThreadId)?.workspaceBinding).toEqual({ policy: 'shared', sharedPath: projectDir })
    await waitFor(() => d.engine.getRun(accepted.childRunId)?.status === 'completed', 'the child run')
    expect(adapter.turns.at(-1)?.cwd).toBe(projectDir)

    const parentSession = d.orch.getOrCreateSession(parent.id)
    parentSession.workspace = null
    parentSession.sharedWorkspace = undefined
    parentSession.projectCwd = elsewhere
    evictSession(d, accepted.childThreadId)
    await d.orch.send('Read it again', false, { threadId: accepted.childThreadId, clientRequestId: 'child-2' })
    expect(adapter.turns.at(-1)).toMatchObject({ threadId: accepted.childThreadId, cwd: projectDir })
  })

  it('a failed delegation commit leaves no thread and no lifecycle registration; the retry creates and owns exactly one', async () => {
    const { d } = setup()
    const { parent, parentRunId } = await parentWithRun(d, { explicitModel: true })
    const db = d.engine.store.db
    const checkpoint = db.checkpoint.bind(db)
    let failNext = true
    db.checkpoint = (point: string) => {
      if (failNext && point === 'delegation.beforeCommit') {
        failNext = false
        throw new Error('injected')
      }
      checkpoint(point)
    }
    const registered = () => d.store.lifecycleStore.list().map((record) => record.taskId).sort()
    const before = registered()
    const request = {
      parentThreadId: parent.id,
      parentRunId,
      clientRequestId: `delegation:${parentRunId}:call-1`,
      prompt: 'Inspect the module',
      workspace: 'isolated' as const,
      wake: 'settled_only' as const
    }
    await expect(d.engine.requestDelegation(request)).rejects.toThrow('injected')
    expect(registered()).toEqual(before)
    expect(d.store.listAllThreads().filter((thread) => thread.lineage)).toEqual([])

    const accepted = await d.engine.requestDelegation(request)
    expect(registered()).toEqual([...before, accepted.childThreadId].sort())
    expect(d.store.lifecycleStore.require(accepted.childThreadId).parentTaskId).toBe(parent.id)
    // The boot repair finds nothing to do for a child whose rows committed.
    expect(d.store.discardOrphanedSubagents((id) => d.engine.delegations.getLineage(id) !== null)).toEqual([])
  })
})
