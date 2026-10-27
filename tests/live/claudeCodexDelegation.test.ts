/**
 * Live exit test for provider instances (SPEC §13.8, §15): a Claude parent delegates to a Codex
 * child over the Mousse MCP server, and the reverse. Uses the real Claude Code and Codex sign-ins
 * from the terminal (never signed in or out here) and costs a few short turns, so it only runs with
 * MOUSSE_LIVE_PROVIDERS=1. MOUSSE_LIVE_SCRATCH names the scratch directory; MOUSSE_CODEX_BINARY
 * and MOUSSE_CLAUDE_BINARY may name the CLI executables.
 *
 * Each direction runs two turns: the parent turn that calls `delegate_task`, and the child turn.
 * No reconciler runs, so the parent is not woken for a third turn.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { createCodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

// Skipped unless MOUSSE_LIVE_PROVIDERS=1: it signs in with the real Claude Code and Codex CLIs and costs a few turns.
const live = process.env.MOUSSE_LIVE_PROVIDERS === '1'
const scratch = process.env.MOUSSE_LIVE_SCRATCH ?? ''

async function waitFor(cond: () => boolean, label: string, timeoutMs = 240_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

const delegationPrompt = (instanceId: string, model: string) =>
  `Call the Mousse delegate_task tool exactly once with instanceId "${instanceId}", model "${model}", ` +
  'prompt "reply with the single word ok", workspace "shared", role "research" and a fresh clientRequestId. ' +
  'Do not wait for the result and do not call any other tool. Then reply with the single word delegated.'

describe.skipIf(!live)('live: Claude and Codex delegate to each other over the Mousse MCP server', () => {
  const run = async (label: string, parent: { instanceId: string; llmProvider: string; model: string }, child: { instanceId: string; model: string }) => {
    const home = join(scratch, `${label}-${Date.now()}`)
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'README.md'), 'Scratch project for a live delegation test.\n')
    process.env.MOUSSE_HOME = home
    // The test setup points CLAUDE_CONFIG_DIR at an empty directory so ordinary tests never see real
    // credentials; this opt-in test uses the terminal sign-in, as the default profile does.
    const isolatedClaudeConfig = process.env.CLAUDE_CONFIG_DIR
    if (process.env.MOUSSE_LIVE_CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = process.env.MOUSSE_LIVE_CLAUDE_CONFIG_DIR
    else delete process.env.CLAUDE_CONFIG_DIR
    if (process.env.MOUSSE_CODEX_BINARY) {
      mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
      writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: process.env.MOUSSE_CODEX_BINARY }))
    }
    if (process.env.MOUSSE_CLAUDE_BINARY) {
      mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
      writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: process.env.MOUSSE_CLAUDE_BINARY }))
    }

    const questions = new UserQuestionService()
    // Nothing in these turns needs approval; refuse anything that asks.
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }))
    const projects = new ProjectManager(home)
    const store = new ThreadDataStore(projects, home)
    const settings = getDefaultSettings()
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(project), new PtyManager(),
      { get: () => settings } as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, projects, { questions }
    )
    orch.setThreadStore(store)
    // Claude Code uses the terminal sign-in.
    const claude = new ClaudeSubscriptionProviderService(home, questions)
    const codex = createCodexProviderService(home, questions)
    orch.setHarness(createHarnessGateway({
      profileHome: home,
      installationHome: home,
      instanceMap: new ProviderInstanceService(),
      questions,
      drivers: [
        piDriver({ client: () => orch.piChatClient() }),
        claudeCodeDriver({ builtIn: () => claude }),
        codexDriver({ builtIn: () => codex })
      ]
    }))
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: process.pid })
    orch.setRunEngine(engine)
    engine.reconcileOnBoot()
    const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
    const server = new MousseMcpServer({ credentials: new McpCredentials(engine.store), registry: orch.mcpToolRegistry() })
    await server.start()
    orch.setMcpAttachment(server)
    try {
      const claudeStatus = await claude.status({ force: true })
      expect(claudeStatus.state, JSON.stringify(claudeStatus)).toBe('connected')
      const codexStatus = await codex.status({ force: true })
      expect(codexStatus.state, JSON.stringify(codexStatus)).toBe('connected')
      const opened = projects.openProject(project)
      const thread = store.createThread(`${label} parent`, opened.id, project)
      orch.setThreadModelOverride(thread.id, parent)
      const started = Date.now()
      const response = await orch.send(delegationPrompt(child.instanceId, child.model), false, { threadId: thread.id, clientRequestId: `${label}-send` })
      const [delegation] = engine.delegations.listForParentThread(thread.id)
      expect(delegation, `parent reply: ${response.message}`).toBeTruthy()
      await waitFor(() => ['completed', 'failed', 'interrupted', 'cancelled'].includes(engine.getRun(delegation.childRunId)?.status ?? ''), 'the child run')
      const childRun = engine.getRun(delegation.childRunId)!
      const childAttempt = childRun.activeAttemptId ? engine.store.getAttempt(childRun.activeAttemptId) : null
      const report = {
        label,
        seconds: Math.round((Date.now() - started) / 1000),
        parentReply: response.message,
        delegation: { provider: delegation.provider, model: delegation.model, status: engine.delegations.get(delegation.delegationId)?.status },
        childThreadOverride: store.getThread(delegation.childThreadId)?.modelOverride,
        childRun: { status: childRun.status, providerRef: childAttempt?.providerRef },
        childResult: engine.delegations.get(delegation.delegationId)?.result,
        usage: [thread.id, delegation.childThreadId].map((id) => ({
          thread: id === thread.id ? 'parent' : 'child',
          turns: orch.getNativeContext(id).messages.filter((message) => message.role === 'assistant').map((message) => {
            const usage = (message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }).usage
            return usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost?.total } : null
          })
        }))
      }
      writeFileSync(join(home, 'report.json'), JSON.stringify(report, null, 2))
      expect(delegation.provider).toBe(child.instanceId)
      expect(childRun.status).toBe('completed')
      expect(childAttempt?.providerRef?.instanceId).toBe(child.instanceId)
      expect(String(engine.delegations.get(delegation.delegationId)?.result?.text ?? '').trim().toLowerCase()).toMatch(/^ok\.?$/)
    } finally {
      orch.setMcpAttachment(null)
      await server.stop()
      await worker.stop()
      orch.attachEffectWorker(null)
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
      claude.stop()
      codex.stop()
      if (isolatedClaudeConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = isolatedClaudeConfig
    }
  }

  it('Claude parent → Codex child', async () => {
    await run('claude-to-codex', { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'haiku' }, { instanceId: 'codex', model: 'default' })
  }, 600_000)

  it('Codex parent → Claude child', async () => {
    await run('codex-to-claude', { instanceId: 'codex', llmProvider: 'codex', model: 'default' }, { instanceId: 'claude', model: 'haiku' })
  }, 600_000)
})
