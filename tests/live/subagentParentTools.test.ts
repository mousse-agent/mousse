/**
 * Live check that a general-purpose subagent has what its parent has, and a read-only one does not: a Claude parent in
 * Full access delegates the same task twice over the Mousse MCP server, once as a general-purpose subagent in its own
 * folder (`workspace: "shared"`, `role: "research"`, the start that used to make a reader) and once with
 * `readOnly: true`. The task runs a shell command and calls a tool of the user's own MCP server.
 *
 * Uses the real Claude Code sign-in from the terminal (never signed in or out here) and the MCP servers in its user
 * config, and costs a few short turns, so it only runs with MOUSSE_LIVE_PROVIDERS=1. MOUSSE_LIVE_SCRATCH names the
 * scratch directory, MOUSSE_CLAUDE_BINARY may name the CLI executable, and MOUSSE_LIVE_MCP_TOOL the MCP tool to call
 * (default `mcp__exa__web_search_exa`, with MOUSSE_LIVE_MCP_ARGS as its JSON arguments). Leave
 * MOUSSE_LIVE_CLAUDE_CONFIG_DIR unset for the default profile: pointing it at `~/.claude` hides the MCP servers kept in
 * `~/.claude.json`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
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

const live = process.env.MOUSSE_LIVE_PROVIDERS === '1'
const scratch = process.env.MOUSSE_LIVE_SCRATCH ?? ''
const mcpTool = process.env.MOUSSE_LIVE_MCP_TOOL ?? 'mcp__exa__web_search_exa'
const mcpArgs = process.env.MOUSSE_LIVE_MCP_ARGS ?? '{"query":"Electron app","numResults":1}'

async function waitFor(cond: () => boolean, label: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

const task = (title: string) =>
  `Your name is ${title}. Do exactly these two steps, each once, and nothing else. ` +
  `1) Run this shell command with your shell tool (Bash or PowerShell), in your working folder: node -e "require('fs').writeFileSync('${title}.txt', String(6*7)); console.log(6*7)" ` +
  `2) Call the tool ${mcpTool} with these arguments: ${mcpArgs} ` +
  'Then reply with one line: SHELL=<what the command printed, or DENIED with the reason> MCP=<OK if the tool returned a result, or DENIED with the reason>.'

/** What Claude Code itself recorded: each tool call of the session files under `project`, with its result. */
function claudeToolCalls(project: string): Array<{ session: string; title: string | null; name: string; isError: boolean; result: string }> {
  const root = join(process.env.MOUSSE_LIVE_CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const folder = readdirSync(root).find((name) => name === project.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!folder) return []
  const calls: Array<{ session: string; title: string | null; name: string; isError: boolean; result: string }> = []
  for (const file of readdirSync(join(root, folder)).filter((name) => name.endsWith('.jsonl'))) {
    const lines = readFileSync(join(root, folder, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { message?: { content?: unknown } })
    const text = JSON.stringify(lines)
    const title = /Your name is (Measurer|Explorer)./.exec(text)?.[1] ?? null
    const uses = new Map<string, string>()
    for (const line of lines) {
      const content = Array.isArray(line.message?.content) ? line.message!.content as Array<Record<string, unknown>> : []
      for (const block of content) {
        if (block.type === 'tool_use') uses.set(String(block.id), String(block.name))
        if (block.type === 'tool_result')
          calls.push({ session: file, title, name: uses.get(String(block.tool_use_id)) ?? '?', isError: block.is_error === true, result: JSON.stringify(block.content).slice(0, 300) })
      }
    }
  }
  return calls
}

const parentPrompt =
  'Call the Mousse delegate_task tool exactly twice, with a fresh clientRequestId each time, and no other tool. ' +
  `First: title "Measurer", workspace "shared", role "research", prompt ${JSON.stringify(task('Measurer'))}. ` +
  `Second: title "Explorer", workspace "shared", role "research", readOnly true, prompt ${JSON.stringify(task('Explorer'))}. ` +
  'Do not wait for the results. Then reply with the single word delegated.'

describe.skipIf(!live)('live: a subagent has its parent\'s shell and MCP tools unless it was asked read-only', () => {
  it('Claude parent → a general-purpose and a read-only Claude subagent', async () => {
    const home = join(scratch, `subagent-parent-tools-${Date.now()}`)
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'README.md'), 'Scratch project for a live subagent test.\n')
    process.env.MOUSSE_HOME = home
    // The test setup points CLAUDE_CONFIG_DIR at an empty directory so ordinary tests never see real
    // credentials; this opt-in test uses the terminal sign-in and its MCP servers, as the default profile does.
    const isolatedClaudeConfig = process.env.CLAUDE_CONFIG_DIR
    if (process.env.MOUSSE_LIVE_CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = process.env.MOUSSE_LIVE_CLAUDE_CONFIG_DIR
    else delete process.env.CLAUDE_CONFIG_DIR
    if (process.env.MOUSSE_CLAUDE_BINARY) {
      mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
      writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: process.env.MOUSSE_CLAUDE_BINARY }))
    }

    const questions = new UserQuestionService()
    // Full access asks nothing; refuse anything that does.
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }, { kind: 'user' }))
    const projects = new ProjectManager(home)
    const store = new ThreadDataStore(projects, home)
    const settings = getDefaultSettings()
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(project), new PtyManager(),
      { get: () => settings } as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, projects, { questions }
    )
    orch.setThreadStore(store)
    const claude = new ClaudeSubscriptionProviderService(home, questions)
    orch.setHarness(createHarnessGateway({
      profileHome: home,
      installationHome: home,
      instanceMap: new ProviderInstanceService(),
      questions,
      drivers: [piDriver(), claudeCodeDriver({ builtIn: () => claude })]
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
      const status = await claude.status({ force: true })
      expect(status.state, JSON.stringify(status)).toBe('connected')
      const opened = projects.openProject(project)
      const thread = store.createThread('Parent', opened.id, project)
      orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'haiku' })
      orch.setThreadPermissionMode(thread.id, 'full')
      const response = await orch.send(parentPrompt, false, { threadId: thread.id, clientRequestId: 'parent-send' })
      const delegations = engine.delegations.listForParentThread(thread.id)
      expect(delegations, `parent reply: ${response.message}`).toHaveLength(2)
      for (const delegation of delegations)
        await waitFor(() => ['completed', 'failed', 'interrupted', 'cancelled'].includes(engine.getRun(delegation.childRunId)?.status ?? ''), 'a child run')
      const calls = claudeToolCalls(project)
      const child = (title: string) => {
        const delegation = delegations.find((entry) => store.getThread(entry.childThreadId)?.name === title)!
        const thread = store.getThread(delegation.childThreadId)!
        const shell = calls.filter((call) => call.title === title && /^(Bash|PowerShell)$/.test(call.name))
        const mcp = calls.filter((call) => call.title === title && call.name === mcpTool)
        return {
          binding: thread.workspaceBinding,
          permissionMode: thread.permissionMode,
          run: engine.getRun(delegation.childRunId)?.status,
          result: String(engine.delegations.get(delegation.delegationId)?.result?.text ?? ''),
          // What Claude Code recorded the tools returning, and what the shell command left, not what the model says.
          shell,
          mcp,
          wroteFile: existsSync(join(project, `${title}.txt`)) ? readFileSync(join(project, `${title}.txt`), 'utf8') : null
        }
      }
      const general = child('Measurer')
      const reader = child('Explorer')
      writeFileSync(join(home, 'report.json'), JSON.stringify({ parentReply: response.message, general, reader }, null, 2))
      console.log(JSON.stringify({ general, reader }, null, 2))
      expect(general.binding).toMatchObject({ policy: 'shared', access: 'write' })
      expect(reader.binding).toMatchObject({ policy: 'shared', access: 'read-only' })
      expect(general.permissionMode).toBe('full')
      // The general-purpose subagent ran the command in the parent's folder and called the MCP tool.
      expect(general.wroteFile).toBe('42')
      expect(general.shell.some((call) => !call.isError && call.result.includes('42'))).toBe(true)
      expect(general.mcp.some((call) => !call.isError)).toBe(true)
      // The read-only one ran, and got neither: each tool was either not offered at all or refused, never run.
      expect(reader.run).toBe('completed')
      expect(reader.wroteFile).toBeNull()
      expect(reader.shell.filter((call) => !call.isError)).toEqual([])
      expect(reader.mcp.filter((call) => !call.isError)).toEqual([])
    } finally {
      orch.setMcpAttachment(null)
      await server.stop()
      await worker.stop()
      orch.attachEffectWorker(null)
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
      claude.stop()
      if (isolatedClaudeConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = isolatedClaudeConfig
    }
  }, 900_000)
})
