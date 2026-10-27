/**
 * `approval_respond` end to end (docs/run-engine/SPEC.md §15.1, §17): a real `OrchestratorService`, Run Engine,
 * effect worker and Mousse MCP server, with scripted runtimes whose turns call the tool over HTTP. A request is a
 * saved approval of another thread whose provider callback waits in the same process, so an answer is seen
 * reaching it exactly once. Covers the gate (level, project, switch), the bound of the agent's own mode, "always",
 * the caller's own thread and lineage, the record on the target thread, races, replays, bot and channel callers,
 * and the continuation after a restart.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { AgentAccessLevel } from '../../src/shared/settings'
import type { ChatMessage, PendingUserQuestions } from '../../src/shared/types'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

type Mcp = { url: string; token: string; turnToken?: string }
type Script = (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon) => Promise<string>
type Rpc = Awaited<ReturnType<typeof rpc>>

/** A provider stand-in whose script gets the turn's MCP bridge. */
class VendorAdapter implements ProviderAdapter {
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: (input: TurnInput, host: AdapterHost) => Promise<string>) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return await response.json() as {
    result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
    error?: { code: number; message: string; data?: { reason: string; conflict?: string; [key: string]: unknown } }
  }
}

const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}) =>
  rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args })
const names = async (mcp: Mcp): Promise<string[]> => (await rpc(mcp, 'tools/list', {})).result!.tools!.map((tool) => tool.name)

/** What a call came back with, whether it was an answer, an error result or a refusal before the handler. */
function outcome(response: Rpc): { isError: boolean; body: Record<string, unknown>; text: string; rpcError?: NonNullable<Rpc['error']> } {
  if (response.error) return { isError: true, body: {}, text: response.error.message, rpcError: response.error }
  const text = response.result?.content?.[0]?.text ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { isError: response.result?.isError === true, body, text }
}

const COMMAND_PROMPT = 'Allow Claude Code to run a command (Bash)?\nnpm test'
const questionFor = (prompt = COMMAND_PROMPT): PendingUserQuestions['questions'] => [
  { id: 'permission', prompt, options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow_always', label: 'Always for this thread' }, { id: 'reject', label: 'Reject' }] }
]
const tagFor = (action: ApprovalTag['action'] = 'command', command = 'npm test'): ApprovalTag => ({
  action,
  permissionKey: action === 'edit' ? 'claude:edit' : 'claude:command',
  options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'allow_always', decision: 'allow', scope: 'always' }, { id: 'reject', decision: 'reject' }],
  tool: { name: 'Bash', input: { command }, cwd: '/work/app' }
})
const USER = { kind: 'user', via: 'gui' } as const

describe('approval_respond end to end (SPEC §15.1)', () => {
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

  const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

  /**
   * A daemon whose threads run on one scripted runtime that talks to the real MCP server. `agent` is the usual
   * caller (permission mode `full`) and `other` the thread whose approvals it answers; `thread` makes more.
   */
  const world = (script: Script, options: { level?: AgentAccessLevel; answerApprovals?: boolean } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-approval-respond-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    mkdirSync(join(home, 'project2'))
    let created: Phase6Daemon | undefined
    const adapter = new VendorAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host) => {
      const bridge = host.bridge
      return script(input, bridge?.mcp ? { ...bridge.mcp, turnToken: bridge.turnToken } : undefined, created!)
    })
    const d = phase6Daemon(home, [adapter])
    created = d
    const credentials = new McpCredentials(d.engine.store)
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
    stops.push(async () => {
      d.questions.shutdown()
      d.orch.setMcpAttachment(null)
      await server.stop()
      await d.stop()
    })
    const project = d.projects.openProject(join(home, 'project'))
    const project2 = d.projects.openProject(join(home, 'project2'))
    const thread = (name: string, mode: PermissionMode = 'full', projectId = project.id) => {
      const made = d.store.createThread(name, projectId)
      d.orch.setThreadModelOverride(made.id, MODEL)
      d.orch.setThreadPermissionMode(made.id, mode)
      return made
    }
    const agent = thread('Orchestrator')
    const other = thread('Other work')
    const setProfile = (level: AgentAccessLevel, extra: { projectIds?: string[]; answerApprovals?: boolean } = {}): void => {
      ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = {
        level, projectIds: extra.projectIds ?? [], answerApprovals: extra.answerApprovals ?? false
      }
    }
    setProfile(options.level ?? 'manage', { answerApprovals: options.answerApprovals ?? true })
    /** A saved approval of `threadId` whose provider callback waits here; `settled()` says whether it has been answered. */
    const ask = (threadId: string, action: ApprovalTag['action'] = 'command', command = 'npm test') => {
      const outcomeOf: { value?: Record<string, string | string[]>; error?: Error; calls: number } = { calls: 0 }
      const waiter = d.questions.requestAnswers(questionFor(`Allow Claude Code to run a command (Bash)?\n${command}`), threadId, { approval: tagFor(action, command) })
        .then((value) => { outcomeOf.calls += 1; outcomeOf.value = value }, (error: Error) => { outcomeOf.error = error })
      return { requestId: d.questions.listPendingForThread(threadId).at(-1)!.requestId, waiter, outcome: outcomeOf }
    }
    const events = (threadId: string, type: string) => d.engine.listEvents(threadId).filter((event) => event.type === type)
    const messages = (threadId: string): ChatMessage[] => d.orch.getOrCreateSession(threadId).messages
    const rows = (threadId: string, prefix: string) => messages(threadId).filter((message) => message.role === 'system' && message.content.startsWith(prefix)).map((message) => message.content)
    const row = (requestId: string) => d.engine.approvals.get(requestId)!
    return {
      d, adapter, credentials, server, project, project2, agent, other, thread, setProfile, ask, events, messages, rows, row,
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      go: (threadId: string, key = `go-${threadId}`) => d.orch.send('Go', false, { threadId, clientRequestId: key })
    }
  }

  const respond = (mcp: Mcp, threadId: string, requestId: string, answer: string | string[] = 'allow', clientRequestId?: string) =>
    call(mcp, 'approval_respond', { threadId, requestId, answers: { permission: answer }, ...(clientRequestId ? { clientRequestId } : {}) })

  it('an agent answers another thread\'s approval once: the provider callback is answered exactly once, and the thread shows who decided', async () => {
    const seen: Record<string, unknown> = {}
    const ids: { requestId?: string } = {}
    const w = world(async (input, mcp, d) => {
      if (input.threadId !== w.agent.id) return 'noop'
      // What an agent reads first: the pending request with its option ids, without "Always for this thread".
      seen.listed = outcome(await call(mcp!, 'thread_list', { includeUnstarted: true })).body
      seen.answer = outcome(await respond(mcp!, w.other.id, ids.requestId!, 'allow', 'ans-1'))
      // The same call again, as after a timeout: the first result, nothing new.
      seen.retry = outcome(await respond(mcp!, w.other.id, ids.requestId!, 'allow', 'ans-1'))
      seen.runId = d.engine.getActiveRun(w.agent.id)!.runId
      return 'Answered.'
    })
    await w.attach()
    const asked = w.ask(w.other.id)
    ids.requestId = asked.requestId
    await w.go(w.agent.id)

    const listed = (seen.listed as { threads: Array<{ id: string; pendingQuestions?: Array<{ requestId: string; questions: Array<{ options: Array<{ id: string }> }> }> }> }).threads.find((thread) => thread.id === w.other.id)!
    expect(listed.pendingQuestions![0]).toMatchObject({ requestId: asked.requestId })
    expect(listed.pendingQuestions![0]!.questions[0]!.options.map((option) => option.id)).toEqual(['allow', 'reject'])

    expect((seen.answer as ReturnType<typeof outcome>).body).toEqual({ ok: true, threadId: w.other.id, requestId: asked.requestId, decision: 'allow' })
    expect((seen.retry as ReturnType<typeof outcome>).body).toEqual({ ok: true, threadId: w.other.id, requestId: asked.requestId, decision: 'allow', replayed: true })
    await asked.waiter
    expect(asked.outcome).toMatchObject({ value: { permission: 'allow' }, calls: 1 })

    // The record: the answer event names the agent's thread, run and call; the transcript row is no message from the user, and written once.
    expect(w.row(asked.requestId)).toMatchObject({
      status: 'answered', decision: 'allow', decisionScope: 'once', deliveredAt: expect.any(String),
      answeredBy: { kind: 'agent', threadId: w.agent.id, runId: seen.runId, toolCallId: 'mcp:ans-1' }
    })
    const answered = w.events(w.other.id, 'approval.answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]!.payload).toMatchObject({ requestId: asked.requestId, decision: 'allow', answeredBy: { kind: 'agent', threadId: w.agent.id, runId: seen.runId, toolCallId: 'mcp:ans-1' } })
    expect(w.rows(w.other.id, 'Approved by an agent')).toEqual([`Approved by an agent in thread «Orchestrator» (${w.agent.id}): Allow Claude Code to run a command (Bash)?`])
    expect(w.messages(w.other.id).some((message) => message.role === 'user')).toBe(false)
    // No second record: the approval's own event is the audit, and nothing was made a standing rule.
    expect(w.events(w.other.id, 'agent.action')).toEqual([])
    expect(w.d.engine.approvals.listRules(w.other.id)).toEqual([])
    expect(w.d.engine.store.getReceipt(`approval_respond:${w.agent.id}:mcp:ans-1`)).toMatchObject({ commandKind: 'approval_respond', threadId: w.other.id, result: { requestId: asked.requestId } })

    // A person who answers a moment later is told, and nothing is delivered twice.
    expect(w.d.questions.settle(asked.requestId, { permission: 'reject' }, USER)).toMatchObject({
      ok: false, reason: 'already_answered', decision: 'allow', answeredBy: { kind: 'agent', threadId: w.agent.id }
    })
    expect(asked.outcome.calls).toBe(1)
  })

  describe('the gate', () => {
    it('needs the profile switch, which is read at every call: off refuses and leaves the request for the user, on answers, lowering the level takes it away at once', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { first?: string; second?: string } = {}
      let listed: string[] = []
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.agent.id) return 'noop'
        seen.off = await respond(mcp!, w.other.id, ids.first!, 'allow', 'k-off')
        w.setProfile('manage', { answerApprovals: true })
        seen.on = await respond(mcp!, w.other.id, ids.first!, 'allow', 'k-on')
        w.setProfile('read', { answerApprovals: true })
        seen.lowered = await respond(mcp!, w.other.id, ids.second!, 'allow', 'k-lowered')
        listed = await names(mcp!)
        return 'done'
      }, { answerApprovals: false })
      await w.attach()
      const first = w.ask(w.other.id)
      const second = w.ask(w.other.id, 'command', 'npm run build')
      ids.first = first.requestId
      ids.second = second.requestId
      await w.go(w.agent.id)

      const off = outcome(seen.off!)
      expect(off.isError).toBe(true)
      expect(off.body).toMatchObject({ ok: false, reason: 'approvals_disabled', requestId: first.requestId })
      expect(off.body.message).toMatch(/not allowed agents to answer approvals on other threads/)
      expect(outcome(seen.on!).body).toMatchObject({ ok: true, decision: 'allow' })
      // Lowered to read: refused before the handler, by the central check.
      expect(outcome(seen.lowered!).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied, data: { reason: 'mousse_scope_denied' } })
      expect(w.row(second.requestId).status).toBe('pending')
      expect(second.outcome.calls).toBe(0)
      expect(listed).not.toContain('approval_respond')
      // The one the person has not seen is still theirs.
      expect(w.d.questions.settle(second.requestId, { permission: 'reject' }, USER)).toEqual({ ok: true, decision: 'reject' })
    })

    it('answers only in the projects the profile lists, read at every call', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { inList?: string; outside?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.agent.id) return 'noop'
        seen.outside = await respond(mcp!, elsewhere.id, ids.outside!, 'allow', 'k-out')
        seen.inList = await respond(mcp!, w.other.id, ids.inList!, 'allow', 'k-in')
        return 'done'
      })
      const elsewhere = w.thread('Elsewhere', 'full', w.project2.id)
      await w.attach()
      w.setProfile('manage', { projectIds: [w.project.id], answerApprovals: true })
      const outside = w.ask(elsewhere.id)
      const inList = w.ask(w.other.id)
      ids.outside = outside.requestId
      ids.inList = inList.requestId
      await w.go(w.agent.id)

      expect(outcome(seen.outside!).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
      expect(w.row(outside.requestId).status).toBe('pending')
      expect(outcome(seen.inList!).body).toMatchObject({ ok: true })
      expect(w.row(inList.requestId).status).toBe('answered')
      await w.d.questions.settle(outside.requestId, { permission: 'reject' }, USER)
    })

    it('a bot caller and a channel caller are refused: their turns are granted lineage whatever the profile says', async () => {
      const seen: Record<string, { call: Rpc; tools: string[] }> = {}
      const ids: { requestId?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.other.id) return 'noop'
        seen[input.threadId] = { call: await respond(mcp!, w.other.id, ids.requestId!, 'allow', `k-${input.threadId}`), tools: await names(mcp!) }
        return 'done'
      })
      const bot = w.thread('Bot activation')
      const channel = w.thread('Telegram chat')
      w.d.orch.setBotThreads({ roleOf: (threadId) => (threadId === bot.id ? 'activation' : undefined) })
      w.d.store.capAccessCeiling(channel.id, 'lineage')
      await w.attach()
      const asked = w.ask(w.other.id)
      ids.requestId = asked.requestId
      await w.go(bot.id)
      await w.go(channel.id)

      for (const caller of [bot, channel]) {
        expect(outcome(seen[caller.id]!.call).rpcError, caller.name).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
        expect(seen[caller.id]!.tools, caller.name).not.toContain('approval_respond')
      }
      expect(w.row(asked.requestId).status).toBe('pending')
      expect(asked.outcome.calls).toBe(0)
      await w.d.questions.settle(asked.requestId, { permission: 'reject' }, USER)
    })

    it('a bot\'s thread is not answered from another thread, and neither is a plain question for the user', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { bot?: string; plain?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.agent.id) return 'noop'
        seen.bot = await respond(mcp!, botThread.id, ids.bot!, 'allow', 'k-bot')
        seen.plain = await respond(mcp!, w.other.id, ids.plain!, 'a', 'k-plain')
        return 'done'
      })
      const botThread = w.thread('Bot context')
      w.d.orch.setBotThreads({ roleOf: (threadId) => (threadId === botThread.id ? 'context' : undefined) })
      await w.attach()
      const bot = w.ask(botThread.id)
      // `ask_user`: a question with no approval behind it, which only the user answers.
      const plain = w.d.questions.requestAnswers([{ id: 'permission', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], w.other.id)
      plain.catch(() => undefined)
      ids.bot = bot.requestId
      ids.plain = w.d.questions.listPendingForThread(w.other.id).at(-1)!.requestId
      await w.go(w.agent.id)

      expect(outcome(seen.bot!).rpcError!.message).toMatch(/belongs to a bot/)
      expect(outcome(seen.plain!).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
      expect(outcome(seen.plain!).text).toMatch(/not an approval; only the user answers it/)
      expect(w.d.questions.getPending(ids.plain!)).not.toBeNull()
      expect(w.row(bot.requestId).status).toBe('pending')
      await w.d.questions.settle(bot.requestId, { permission: 'reject' }, USER)
    })
  })

  describe('what the agent may approve', () => {
    it('only what its own mode would allow without asking: an Ask agent approves nothing, an Accept-edits agent approves edits and not commands', async () => {
      const seen: Record<string, Rpc[]> = {}
      const ids: { command?: string; edit?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.other.id) return 'noop'
        seen[input.threadId] = [
          await respond(mcp!, w.other.id, ids.command!, 'allow', `cmd-${input.threadId}`),
          await respond(mcp!, w.other.id, ids.edit!, 'allow', `edit-${input.threadId}`)
        ]
        return 'done'
      })
      const asker = w.thread('Asker', 'ask')
      const editor = w.thread('Editor', 'accept_edits')
      await w.attach()
      const command = w.ask(w.other.id, 'command', 'rm -rf build')
      const edit = w.ask(w.other.id, 'edit', 'edit a file')
      ids.command = command.requestId
      ids.edit = edit.requestId
      await w.go(asker.id)
      for (const response of seen[asker.id]!) expect(outcome(response).body, 'ask').toMatchObject({ ok: false, reason: 'mode_forbids' })
      expect(w.row(command.requestId).status).toBe('pending')
      expect(w.row(edit.requestId).status).toBe('pending')
      expect(command.outcome.calls + edit.outcome.calls).toBe(0)

      await w.go(editor.id)
      const [commandOutcome, editOutcome] = seen[editor.id]!.map(outcome)
      expect(commandOutcome!.body).toMatchObject({ ok: false, reason: 'mode_forbids' })
      expect(editOutcome!.body).toMatchObject({ ok: true, decision: 'allow' })
      expect(w.row(command.requestId).status).toBe('pending')
      expect(w.row(edit.requestId)).toMatchObject({ status: 'answered', answeredBy: { kind: 'agent', threadId: editor.id } })
      // Rejecting is held to the same mode: the agent widens nothing and narrows only within what it may do.
      expect(w.d.questions.settle(command.requestId, { permission: 'reject' }, USER)).toEqual({ ok: true, decision: 'reject' })
    })

    it('never "always for this thread": refused before the call and, if it got through, by the rule; no rule is made and the request stays', async () => {
      const seen: Record<string, unknown> = {}
      const ids: { requestId?: string } = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.agent.id) return 'noop'
        seen.byTool = await respond(mcp!, w.other.id, ids.requestId!, 'allow_always', 'k-always')
        // Past the tool's own check, the rule at the settlement refuses it as well.
        seen.byRule = d.orch.mcpToolHost().answerApproval!(w.other.id, ids.requestId!, { permission: 'allow_always' }, {
          clientRequestId: 'approval_respond:direct:1',
          actor: { kind: 'agent', threadId: w.agent.id, runId: d.engine.getActiveRun(w.agent.id)!.runId, toolCallId: 'mcp:direct' },
          accessLevel: 'manage'
        })
        return 'done'
      })
      await w.attach()
      const asked = w.ask(w.other.id)
      ids.requestId = asked.requestId
      await w.go(w.agent.id)

      expect(outcome(seen.byTool as Rpc).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
      expect(outcome(seen.byTool as Rpc).text).toMatch(/cannot approve "always for this thread"/)
      expect(seen.byRule).toEqual({ ok: false, reason: 'agent_no_standing_grant' })
      expect(w.row(asked.requestId)).toMatchObject({ status: 'pending', decision: null })
      expect(w.d.engine.approvals.listRules(w.other.id)).toEqual([])
      expect(asked.outcome.calls).toBe(0)
      await w.d.questions.settle(asked.requestId, { permission: 'reject' }, USER)
    })

    it('never its own thread: not under its own id, not through another thread\'s id, and not past the tool', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.agent.id) return 'noop'
        // The agent's own turn is waiting on this approval (a message sent to the thread would have denied it).
        const own = w.ask(w.agent.id)
        seen.byOwnId = await respond(mcp!, w.agent.id, own.requestId, 'allow', 'k-own')
        seen.byOtherId = await respond(mcp!, w.other.id, own.requestId, 'allow', 'k-own-2')
        seen.byRule = d.orch.mcpToolHost().answerApproval!(w.agent.id, own.requestId, { permission: 'allow' }, {
          clientRequestId: 'approval_respond:direct:2',
          actor: { kind: 'agent', threadId: w.agent.id, runId: d.engine.getActiveRun(w.agent.id)!.runId, toolCallId: 'mcp:direct-2' },
          accessLevel: 'manage'
        })
        seen.status = w.row(own.requestId).status
        seen.calls = own.outcome.calls
        // The person answers it, as they would.
        d.questions.settle(own.requestId, { permission: 'reject' }, USER)
        return 'done'
      })
      await w.attach()
      await w.go(w.agent.id)

      expect(outcome(seen.byOwnId as Rpc)).toMatchObject({ isError: true, text: expect.stringContaining('answers the approvals of other threads') })
      expect(outcome(seen.byOtherId as Rpc).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'request_not_pending' } })
      expect(seen.byRule).toEqual({ ok: false, reason: 'own_request' })
      expect(seen.status).toBe('pending')
      expect(seen.calls).toBe(0)
    })
  })

  describe('races and retries', () => {
    it('a person who answered first wins, and the agent is told who decided what; nothing is recorded for the agent', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { requestId?: string } = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.agent.id) return 'noop'
        // The person answers between the agent's read and its answer.
        d.questions.settle(ids.requestId!, { permission: 'reject' }, USER)
        seen.late = await respond(mcp!, w.other.id, ids.requestId!, 'allow', 'k-late')
        return 'done'
      })
      await w.attach()
      const asked = w.ask(w.other.id)
      ids.requestId = asked.requestId
      await w.go(w.agent.id)

      expect(outcome(seen.late!).body).toMatchObject({ ok: false, reason: 'already_answered', decision: 'reject', answeredBy: { kind: 'user', via: 'gui' } })
      expect(outcome(seen.late!).isError).toBe(false)
      await asked.waiter
      expect(asked.outcome).toMatchObject({ value: { permission: 'reject' }, calls: 1 })
      expect(w.row(asked.requestId).answeredBy).toEqual({ kind: 'user', via: 'gui' })
      expect(w.rows(w.other.id, 'Approved by an agent')).toEqual([])
      expect(w.rows(w.other.id, 'Rejected by an agent')).toEqual([])
    })

    it('the same author under another key lost; another caller under the same key lost and was told who won; the same key for another request is a conflict', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { first?: string; second?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.other.id) return 'noop'
        if (input.threadId === w.agent.id) {
          seen.won = await respond(mcp!, w.other.id, ids.first!, 'allow', 'shared')
          seen.otherKey = await respond(mcp!, w.other.id, ids.first!, 'reject', 'another-key')
          seen.conflict = await respond(mcp!, w.other.id, ids.second!, 'allow', 'shared')
        } else {
          seen.rival = await respond(mcp!, w.other.id, ids.first!, 'allow', 'shared')
        }
        return 'done'
      })
      const rival = w.thread('Rival orchestrator')
      await w.attach()
      const first = w.ask(w.other.id)
      const second = w.ask(w.other.id, 'command', 'npm run build')
      ids.first = first.requestId
      ids.second = second.requestId
      await w.go(w.agent.id)
      await w.go(rival.id)

      expect(outcome(seen.won!).body).toMatchObject({ ok: true, decision: 'allow' })
      // The same author, a different key and a different answer: a loss, not a replay.
      expect(outcome(seen.otherKey!).body).toMatchObject({ ok: false, reason: 'already_answered', decision: 'allow', answeredBy: { kind: 'agent', threadId: w.agent.id } })
      expect(outcome(seen.otherKey!).body.replayed).toBeUndefined()
      // The same call id from another caller's thread is not the first caller's answer.
      expect(outcome(seen.rival!).body).toMatchObject({ ok: false, reason: 'already_answered', answeredBy: { kind: 'agent', threadId: w.agent.id } })
      expect(outcome(seen.rival!).body.replayed).toBeUndefined()
      // The key the agent used for one approval cannot answer another.
      expect(outcome(seen.conflict!).rpcError).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'client_request_id_conflict' } })
      expect(w.row(second.requestId).status).toBe('pending')
      expect(w.rows(w.other.id, 'Approved by an agent')).toHaveLength(1)
      expect(first.outcome.calls).toBe(1)
      await w.d.questions.settle(second.requestId, { permission: 'reject' }, USER)
    })

    it('a request closed before the answer is told as cancelled, and nothing is recorded', async () => {
      const seen: Record<string, Rpc> = {}
      const ids: { requestId?: string } = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.agent.id) return 'noop'
        // The provider withdrew the request (its run ended).
        d.questions.dismiss(ids.requestId!)
        seen.late = await respond(mcp!, w.other.id, ids.requestId!, 'allow', 'k-cancelled')
        return 'done'
      })
      await w.attach()
      const asked = w.ask(w.other.id)
      ids.requestId = asked.requestId
      await w.go(w.agent.id)

      expect(outcome(seen.late!).body).toMatchObject({ ok: false, reason: 'cancelled', cancelReason: 'withdrawn' })
      expect(w.rows(w.other.id, 'Approved by an agent')).toEqual([])
      await asked.waiter
      expect(asked.outcome.error).toBeInstanceOf(Error)
    })
  })

  describe('after a restart', () => {
    const PI_ADAPTER_REPLY = 'ok'

    /** A daemon that dies while a run of `Approvals` waits for the user on `asks` requests; its callbacks die with it. */
    const crashWhileAsking = async (dir: string, asks: string[]) => {
      const first = phase6Daemon(dir, [piAdapter(() => 'unused')], { pid: 1 })
      const thread = first.store.createThread('Approvals')
      first.orch.setThreadModelOverride(thread.id, PI)
      const sent = await first.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'before-crash', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      first.engine.markStarting(sent.runId)
      const run = first.engine.markRunning(sent.runId)
      first.engine.recordExecutionBinding(run.runId, { instanceId: 'pi:openai', driver: 'pi', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'gpt-replay', policy: { mode: 'default', origin: 'interactive', approvals: 'ask', permissionMode: 'full' } })
      const requestIds: string[] = []
      for (const command of asks) {
        first.questions.requestAnswers(questionFor(`Allow Claude Code to run a command (Bash)?\n${command}`), thread.id, { approval: tagFor('command', command) }).catch(() => undefined)
        requestIds.push(first.questions.listPendingForThread(thread.id).at(-1)!.requestId)
      }
      await first.crash()
      first.questions.markInterruptedByDaemonRestart()
      return { threadId: thread.id, runId: run.runId, requestIds }
    }

    let dir: string | undefined
    let before: string | undefined
    const daemons: Phase6Daemon[] = []
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'mousse-approval-respond-restart-'))
      before = process.env.MOUSSE_HOME
      process.env.MOUSSE_HOME = dir
    })
    afterEach(async () => {
      for (const daemon of daemons.splice(0).reverse()) {
        daemon.questions.shutdown()
        await daemon.stop().catch(() => undefined)
      }
      if (before === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = before
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = undefined
    })

    /** The second daemon, with a caller that holds a live `full` run and the profile's answer switch on. */
    const reboot = async () => {
      const adapter = piAdapter(() => PI_ADAPTER_REPLY)
      const second = phase6Daemon(dir!, [adapter], { pid: 2 })
      daemons.push(second)
      ;(second.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level: 'manage', projectIds: [], answerApprovals: true }
      const caller = second.store.createThread('Caller')
      const sent = await second.engine.dispatch({ kind: 'send', threadId: caller.id, clientRequestId: 'caller-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      second.engine.markStarting(sent.runId)
      const run = second.engine.markRunning(sent.runId)
      second.engine.recordExecutionBinding(run.runId, { instanceId: 'pi:openai', driver: 'pi', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'gpt-replay', policy: { mode: 'default', origin: 'interactive', approvals: 'ask', permissionMode: 'full' } })
      const answer = (threadId: string, requestId: string, answer: string, key: string) => second.orch.mcpToolHost().answerApproval!(threadId, requestId, { permission: answer }, {
        clientRequestId: `approval_respond:${caller.id}:mcp:${key}`,
        actor: { kind: 'agent', threadId: caller.id, runId: run.runId, toolCallId: `mcp:${key}` },
        accessLevel: 'manage'
      })
      return { second, adapter, answer }
    }
    const runsOf = (daemon: Phase6Daemon, threadId: string) => daemon.engine.listRuns(threadId)

    it('answers given only by an agent record the decisions and start nothing: continuing after a restart is the person\'s click', async () => {
      const { threadId, requestIds } = await crashWhileAsking(dir!, ['npm test', 'npm run build'])
      const { second, adapter, answer } = await reboot()
      expect(answer(threadId, requestIds[0]!, 'allow', 'a1')).toMatchObject({ ok: true, decision: 'allow', replayed: false })
      expect(answer(threadId, requestIds[1]!, 'allow', 'a2')).toMatchObject({ ok: true, decision: 'allow', replayed: false })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(runsOf(second, threadId)).toHaveLength(1)
      expect(adapter.turns).toEqual([])
      expect(second.engine.approvals.get(requestIds[1]!)).toMatchObject({ status: 'answered', deliveredAt: null, answeredBy: { kind: 'agent' } })
    })

    it('an agent\'s answer to the last request of a dead run starts exactly one continuation when a person answered the rest, and a repeat starts none', async () => {
      const { threadId, runId, requestIds } = await crashWhileAsking(dir!, ['npm test', 'npm run build'])
      const { second, adapter, answer } = await reboot()
      expect(second.questions.settle(requestIds[0]!, { permission: 'allow' }, { kind: 'user', via: 'cli' })).toEqual({ ok: true, decision: 'allow' })
      expect(runsOf(second, threadId)).toHaveLength(1)

      expect(answer(threadId, requestIds[1]!, 'allow', 'last')).toMatchObject({ ok: true, decision: 'allow', replayed: false })
      await waitFor(() => runsOf(second, threadId).some((run) => run.clientRequestId === `approval-run:${runId}` && run.status === 'completed'), 'the continuation to complete')
      expect(runsOf(second, threadId)).toHaveLength(2)
      expect(runsOf(second, threadId).find((run) => run.clientRequestId === `approval-run:${runId}`)).toMatchObject({ outcome: { continuationOf: runId } })
      expect(adapter.turns).toHaveLength(1)

      // The same call retried finds its own answer; another call is a loss. Neither starts a run.
      expect(answer(threadId, requestIds[1]!, 'allow', 'last')).toMatchObject({ ok: true, replayed: true })
      expect(answer(threadId, requestIds[1]!, 'reject', 'again')).toMatchObject({ ok: false, reason: 'already_answered', answeredBy: { kind: 'agent' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(runsOf(second, threadId)).toHaveLength(2)
      expect(adapter.turns).toHaveLength(1)
    })
  })
})
