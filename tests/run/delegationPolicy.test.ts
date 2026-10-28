/**
 * Review fixes on the delegation path (docs/run-engine/SPEC.md §14): a `shared` read-only child
 * keeps its policy when its session is rebuilt from storage, a follow-up on a child that already
 * ended publishes its final text, and an integration run that throws ends `failed` with a notice.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type {
  AdapterHost,
  ProviderAdapter,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../../src/mms/harness/adapter'
import { PI, phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

/** A pi-shaped adapter that records each turn's thread, cwd and tool access, and replies. */
class PolicyAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  readonly turns: Array<{ threadId: string; cwd: string | null; toolAccess: AdapterHost['tools']['toolAccess'] }> = []

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push({ threadId: input.threadId, cwd: input.cwd, toolAccess: host.tools.toolAccess })
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

describe('delegation policy fixes', () => {
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
    home = mkdtempSync(join(tmpdir(), 'mousse-delegation-policy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const adapter = new PolicyAdapter()
    const d = (daemon = phase6Daemon(home, [adapter]))
    return { d, adapter, home }
  }

  /** A parent thread (in a project) with one completed run. */
  const parentWithRun = async (d: Phase6Daemon, projectDir?: string) => {
    const project = projectDir ? d.projects.openProject(projectDir) : undefined
    const parent = d.store.createThread('Parent', project?.id)
    d.orch.setThreadModelOverride(parent.id, PI)
    const sent = await d.orch.send('Plan', false, { threadId: parent.id, clientRequestId: 'parent-1' })
    return { parent, parentRunId: sent.runId! }
  }

  it('a shared read-only child keeps SHARED_READER_POLICY after its session is rebuilt from storage', async () => {
    const { d, adapter, home: dir } = setup()
    const projectDir = join(dir, 'project')
    mkdirSync(projectDir)
    const { parent, parentRunId } = await parentWithRun(d, projectDir)
    const accepted = await d.engine.requestDelegation({
      parentThreadId: parent.id,
      parentRunId,
      clientRequestId: `delegation:${parentRunId}:call-1`,
      prompt: 'Read the module',
      role: 'research',
      workspace: 'shared',
      wake: 'settled_only'
    })
    expect(d.engine.delegations.get(accepted.delegationId)).toMatchObject({ workspace: 'shared', role: 'research' })
    await waitFor(() => d.engine.getRun(accepted.childRunId)?.status === 'completed', 'the child run')
    const readOnly = (turn: (typeof adapter.turns)[number] | undefined) => ({
      cwd: turn?.cwd,
      write: turn?.toolAccess?.allows('write_file'),
      read: turn?.toolAccess?.allows('read_file')
    })
    expect(readOnly(adapter.turns.at(-1))).toEqual({ cwd: projectDir, write: false, read: true })

    // The in-memory session is gone (a restart, an eviction): the policy comes back from the row.
    ;(d.orch as unknown as { sessions: Map<string, unknown> }).sessions.delete(accepted.childThreadId)
    await d.orch.send('Read it again', false, { threadId: accepted.childThreadId, clientRequestId: 'child-2' })
    expect(adapter.turns.at(-1)!.threadId).toBe(accepted.childThreadId)
    expect(readOnly(adapter.turns.at(-1))).toEqual({ cwd: projectDir, write: false, read: true })
  })

  it('an integration run whose start throws ends failed and leaves an integration_failed notice', async () => {
    const { d } = setup()
    const parent = d.store.createThread('Parent')
    d.orch.setThreadModelOverride(parent.id, PI)
    // Another run holds the thread, so the integration run cannot start.
    const holder = await d.engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'holder', source: 'gui' })
    if (holder.status !== 'accepted') throw new Error('send rejected')
    d.engine.markStarting(holder.runId)
    d.engine.markRunning(holder.runId)
    const integration = await d.engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'integration-1', source: 'integration' })
    if (integration.status !== 'accepted') throw new Error('send rejected')
    const effect = d.engine.outbox.enqueue({
      threadId: parent.id,
      runId: integration.runId,
      kind: 'turn.start',
      payload: { kind: 'integration', threadId: parent.id, runId: integration.runId, delegationId: 'delegation:missing' }
    })
    await waitFor(() => d.engine.outbox.get(effect.effectId)!.status !== 'pending' && d.engine.outbox.get(effect.effectId)!.status !== 'running', 'the integration effect')
    expect(d.engine.outbox.get(effect.effectId)!.status).toBe('succeeded')
    expect(d.engine.getRun(integration.runId)).toMatchObject({ status: 'failed', outcome: { error: expect.stringContaining('already has active run') } })
    const notices = d.engine.inbox.listPending(parent.id)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'reconcile_notice',
      runId: integration.runId,
      payload: { type: 'integration_failed', delegationId: 'delegation:missing' }
    })
    expect(String((notices[0].payload as { text: string }).text)).toContain('failed')
  })

  it('a delegation whose commit fails leaves no orphan thread; the retry creates exactly one', async () => {
    const { d } = setup()
    const { parent, parentRunId } = await parentWithRun(d)
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
    const threads = () => d.store.listAllThreads().map((thread) => thread.id).sort()
    const before = threads()
    const request = {
      parentThreadId: parent.id,
      parentRunId,
      clientRequestId: `delegation:${parentRunId}:call-1`,
      prompt: 'Inspect the module',
      workspace: 'isolated' as const,
      wake: 'settled_only' as const
    }
    await expect(d.engine.requestDelegation(request)).rejects.toThrow('injected')
    expect(threads()).toEqual(before)

    const accepted = await d.engine.requestDelegation(request)
    expect(threads()).toEqual([...before, accepted.childThreadId].sort())
    const replayed = await d.engine.requestDelegation(request)
    expect(replayed).toEqual({ ...accepted, replayed: true })
    expect(threads()).toHaveLength(before.length + 1)
  })
})
