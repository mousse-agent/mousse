/**
 * "Give each subagent its own worktree" (Settings > Agents > Experimental). Off, the main agent chooses each subagent's
 * workspace, as before. On, every subagent Mousse starts gets a worktree of its own under the Mousse home, on a
 * `mousse/` branch from the parent's HEAD at that moment. Either way the result is reported, pinned under
 * `refs/mousse/delegations/`, and never merged into the parent.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { DelegateTaskInput, DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { SubagentResultReport } from '../../src/shared/subagentResult'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { phase6Daemon, waitFor } from './phase6Fixture'

type Script = (input: TurnInput, host: AdapterHost) => Promise<string>

class ScriptedAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}
  configured(): boolean { return true }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    if (this.capabilities.historyInjection !== 'native') host.context.nativeHistoryAfterTurn(text)
    return {
      text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted',
      nativeMessages: this.capabilities.historyInjection === 'native' ? [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never] : [],
      providerRef
    }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> { return 'not_active' }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('Give each subagent its own worktree', () => {
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

  /**
   * A pi parent in a Git project. Its turn commits once in its own worktree (so its HEAD is ahead of the project's), then
   * runs `onParent` with the delegation tools. The child (Claude) writes `child.txt` where it runs.
   */
  const daemon = (subagentWorktrees: boolean, onParent: (delegation: DelegationToolHost) => Promise<void>) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-worktrees-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project'); mkdirSync(projectDir)
    git(projectDir, 'init', '-q'); git(projectDir, 'config', 'user.name', 'Test'); git(projectDir, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(projectDir, 'README'), 'base\n'); git(projectDir, 'add', '.'); git(projectDir, 'commit', '-qm', 'base')
    const state: { parentHead?: string; childCwds: Array<string | null> } = { childCwds: [] }
    const parent = new ScriptedAdapter('pi', PI_TEST_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return 'unexpected pi turn'
      writeFileSync(join(input.cwd!, 'parent.txt'), 'the parent\'s work\n')
      git(input.cwd!, 'add', 'parent.txt'); git(input.cwd!, 'commit', '-qm', 'parent work')
      state.parentHead = git(input.cwd!, 'rev-parse', 'HEAD')
      await onParent(host.tools.delegation!)
      return 'Delegated.'
    })
    const child = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input) => {
      state.childCwds.push(input.cwd)
      if (input.cwd && input.mode !== 'plan') writeFileSync(join(input.cwd, 'child.txt'), 'the child\'s work\n')
      return 'Done.'
    })
    const d = phase6Daemon(home, [parent, child])
    stops.push(d.stop)
    ;(d.settings as { experimental: { subagentWorktrees: boolean } }).experimental = { subagentWorktrees }
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Parent', project.id)
    return { d, thread, projectDir, state, child }
  }

  const delegate = (delegation: DelegationToolHost, patch: Partial<DelegateTaskInput>, id: string) =>
    delegation.delegateTask({ prompt: 'Look at it', title: id, instanceId: 'claude', workspace: 'isolated', ...patch }, { toolCallId: id }) as Promise<Record<string, unknown>>
  const workspaceOf = (d: ReturnType<typeof daemon>['d'], threadId: string) => new ThreadWorkspaceManager(d.store.getThreadDir(threadId)).load()
  const report = (d: ReturnType<typeof daemon>['d'], delegationId: string): SubagentResultReport | undefined =>
    (d.orch as unknown as { delegationResultReport(delegation: unknown): SubagentResultReport | undefined }).delegationResultReport(d.engine.delegations.get(delegationId))

  it('off: the main agent decides; a shared reader gets no worktree, and an isolated child starts from the project\'s HEAD', async () => {
    const outcomes: Record<string, Record<string, unknown>> = {}
    const { d, thread, projectDir, state } = daemon(false, async (delegation) => {
      outcomes.reader = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'reader')
      outcomes.worker = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'worker')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const key of ['reader', 'worker']) await waitFor(() => d.engine.getRun(outcomes[key].childRunId as string)?.status === 'completed', `the ${key} run`)

    expect(outcomes.reader).not.toHaveProperty('workspace')
    const reader = d.store.getThread(outcomes.reader.childThreadId as string)!
    expect(reader.workspaceBinding).toMatchObject({ policy: 'shared' })
    expect(reader.workspaceBinding?.startSha).toBeUndefined()
    expect(workspaceOf(d, reader.id)).toBeUndefined()

    const worker = d.store.getThread(outcomes.worker.childThreadId as string)!
    expect(worker.workspaceBinding).toEqual({ policy: 'isolated' })
    // Made at its first editing turn, from the project's committed HEAD, as before: not the parent's newer commit.
    expect(workspaceOf(d, worker.id)!.baseSha).toBe(git(projectDir, 'rev-parse', 'HEAD'))
    expect(workspaceOf(d, worker.id)!.baseSha).not.toBe(state.parentHead)
  }, 60_000)

  it('on: every subagent gets its own worktree from the parent\'s current HEAD, a reader and a planner included', async () => {
    const outcomes: Record<string, Record<string, unknown>> = {}
    const { d, thread, projectDir, state } = daemon(true, async (delegation) => {
      outcomes.reader = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'reader')
      outcomes.planner = await delegate(delegation, { workspace: 'isolated', role: 'plan', modeCeiling: 'plan' }, 'planner')
      outcomes.worker = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'worker')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const key of ['reader', 'planner', 'worker']) await waitFor(() => d.engine.getRun(outcomes[key].childRunId as string)?.status === 'completed', `the ${key} run`)

    // The reader asked for the parent's folder; the tool says where it went instead.
    expect(outcomes.reader).toMatchObject({ workspace: 'isolated', note: expect.stringContaining('worktree of its own') })
    const parentWorkspace = workspaceOf(d, thread.id)!
    for (const key of ['reader', 'planner', 'worker']) {
      const child = d.store.getThread(outcomes[key].childThreadId as string)!
      expect(child.workspaceBinding).toEqual({ policy: 'isolated', startSha: state.parentHead })
      const workspace = workspaceOf(d, child.id)!
      expect(workspace.lifecycle, key).toBe('ready')
      expect(workspace.branch.startsWith('mousse/'), key).toBe(true)
      expect(workspace.worktreePath.startsWith(home!), key).toBe(true)
      expect(workspace.worktreePath).not.toBe(parentWorkspace.worktreePath)
      // Its own checkout, at the parent's commit: the parent's committed work is there.
      expect(workspace.baseSha, key).toBe(state.parentHead)
      expect(existsSync(join(workspace.worktreePath, 'parent.txt')), key).toBe(true)
    }
    // Each ran in its own worktree, never in the parent's folder or the project.
    expect(state.childCwds.every((cwd) => cwd && !cwd.startsWith(parentWorkspace.worktreePath) && !cwd.startsWith(projectDir))).toBe(true)
    // Nothing was merged back: the parent's worktree and the project hold none of the children's files.
    expect(existsSync(join(parentWorkspace.worktreePath, 'child.txt'))).toBe(false)
    expect(existsSync(join(projectDir, 'child.txt'))).toBe(false)
    expect(git(projectDir, 'status', '--porcelain')).toBe('')
  }, 60_000)

  it('on: the result is reported with its base and result pinned under refs/mousse/delegations/, and never merged', async () => {
    const outcomes: Record<string, Record<string, unknown>> = {}
    const { d, thread, projectDir, state } = daemon(true, async (delegation) => {
      outcomes.worker = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'worker')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    await waitFor(() => d.engine.getRun(outcomes.worker.childRunId as string)?.status === 'completed', 'the child run')
    const result = report(d, outcomes.worker.delegationId as string)!
    expect(result).toMatchObject({ shared: false, baseSha: expect.any(String), resultSha: expect.any(String), changedFiles: ['child.txt'] })
    expect(result.baseRef).toMatch(new RegExp(`^refs/mousse/delegations/${outcomes.worker.childThreadId}/`))
    expect(git(projectDir, 'rev-parse', `${result.baseRef}^{commit}`)).toBe(result.baseSha)
    expect(git(projectDir, 'show', `${result.resultRef}:child.txt`)).toBe('the child\'s work')
    // The parent's commit is where the child started, and the parent is still there, unmerged.
    expect(git(projectDir, 'rev-parse', `${result.baseSha}^`) === state.parentHead || result.baseSha === state.parentHead).toBe(true)
    expect(existsSync(join(workspaceOf(d, thread.id)!.worktreePath, 'child.txt'))).toBe(false)
  }, 60_000)
})
