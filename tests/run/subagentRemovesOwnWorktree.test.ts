/**
 * A subagent that removes its own worktree before its turn ends (it merged its work and cleaned up) ends `completed`:
 * Mousse's end-of-turn snapshot has no folder to read, and that is not the task failing. The result report says the
 * worktree was removed and that the result is the last snapshot recorded. A worktree that is still there but that Git
 * refuses is a real failure and still fails the run.
 *
 * What the subagent does to its folder:
 * - removed: `git worktree remove --force`, then its branch deleted → completed, with the notice
 * - broken: the folder stays, its `.git` points nowhere → failed, as before
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { formatSubagentResultReport } from '../../src/mms/agents/subagentResultReport'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { SubagentResultReport } from '../../src/shared/subagentResult'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { phase6Daemon, waitFor } from './phase6Fixture'

type Script = (input: TurnInput, host: AdapterHost) => Promise<string>

class ScriptedAdapter implements ProviderAdapter {
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}
  configured(): boolean { return true }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
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

describe('a subagent that removes its own worktree', () => {
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

  /** A pi parent delegates one isolated task; the Claude child writes a file in its worktree, then `atEnd` runs on it. */
  const run = async (atEnd: (cwd: string, projectDir: string) => void) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-removes-worktree-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project'); mkdirSync(projectDir)
    git(projectDir, 'init', '-q'); git(projectDir, 'config', 'user.name', 'Test'); git(projectDir, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(projectDir, 'README'), 'base\n'); git(projectDir, 'add', '.'); git(projectDir, 'commit', '-qm', 'base')
    const outcome: { task?: Record<string, unknown>; childCwd?: string } = {}
    const parent = new ScriptedAdapter('pi', PI_TEST_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return 'unexpected pi turn'
      const delegation: DelegationToolHost = host.tools.delegation!
      outcome.task = await delegation.delegateTask({ prompt: 'Do the work', title: 'worker', instanceId: 'claude', workspace: 'isolated', role: 'implement' }, { toolCallId: 'worker' }) as Record<string, unknown>
      return 'Delegated.'
    })
    const child = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input) => {
      outcome.childCwd = input.cwd!
      writeFileSync(join(input.cwd!, 'child.txt'), 'the child\'s work\n')
      atEnd(input.cwd!, projectDir)
      return 'Done.'
    })
    const d = phase6Daemon(home, [parent, child])
    stops.push(d.stop)
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Parent', project.id)
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    await waitFor(() => ['completed', 'failed'].includes(d.engine.getRun(outcome.task?.childRunId as string)?.status ?? ''), 'the child run to end', 30_000)
    const childRun = d.engine.getRun(outcome.task!.childRunId as string)!
    const report = (d.orch as unknown as { delegationResultReport(delegation: unknown): SubagentResultReport | undefined })
      .delegationResultReport(d.engine.delegations.get(outcome.task!.delegationId as string))
    const actions = new ThreadActionService(d.store.getThreadDir(outcome.task!.childThreadId as string)).list()
    return { childRun, report, actions, childCwd: outcome.childCwd! }
  }

  it('removed: the run ends completed, and the report says no end snapshot was recorded', async () => {
    const { childRun, report, actions, childCwd } = await run((cwd, projectDir) => {
      const branch = git(cwd, 'branch', '--show-current')
      git(projectDir, 'worktree', 'remove', '--force', cwd)
      git(projectDir, 'branch', '-D', branch)
    })
    expect(existsSync(childCwd)).toBe(false)
    expect(childRun.status).toBe('completed')
    expect(childRun.outcome?.error ?? null).toBeNull()
    const turn = actions.find((action) => action.turnId === childRun.runId)!
    expect(turn).toMatchObject({ state: 'completed', workspaceRemoved: true, reversible: false })
    expect(turn.endSha).toBe(turn.startSha)
    expect(report).toMatchObject({ workspaceRemoved: true, resultSha: turn.startSha })
    expect(formatSubagentResultReport(report!)).toMatch(/removed before the task ended, so no snapshot of where it finished was recorded/)
  }, 60_000)

  it('broken: the folder is still there but Git refuses it, so the run still fails', async () => {
    const { childRun, actions } = await run((cwd) => {
      // Git for Windows marks a worktree's `.git` file hidden, which cannot be overwritten in place.
      rmSync(join(cwd, '.git'), { force: true })
      writeFileSync(join(cwd, '.git'), `gitdir: ${join(cwd, 'no-such-git-dir')}\n`)
    })
    expect(childRun.status).toBe('failed')
    expect(childRun.outcome?.error).toMatch(/not-a-repository/)
    expect(actions.find((action) => action.turnId === childRun.runId)?.workspaceRemoved).toBeUndefined()
  }, 60_000)
})
