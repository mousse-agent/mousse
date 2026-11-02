import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context, AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { MmsProtocolServer, LocalMmsClient } from '../src/mms/protocol'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { delegationResultRefPrefix } from '../src/mms/agents/subagentResultReport'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'
import { providerResponse } from './fixtures/agent-platform/agent-runtime-policy/helpers'
import type { AdapterHost, ProviderAdapter, TurnInput, TurnResult, TurnSink, TurnControl } from '../src/mms/harness/adapter'
import { dispatchDelegationTool } from '../src/mms/run/mcp/appTools/delegation'
import { testHarness } from '../src/mms/run/testkit/harness'
import { PI_TEST_CAPABILITIES } from './support/piStub'

let f: ReturnType<typeof gitFoundationFixture>, mms: MousseMainService, server: MmsProtocolServer, client: LocalMmsClient
const captured: Context[] = []
/** The model's reply to each request of a turn, given the context it sees. */
type Respond = (context: Context, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>
let respond: Respond = () => { throw new Error('Named provider fixture exhausted') }

/**
 * A stand-in for Pi's agent, which runs the tool loop in its own process: each request's context is
 * captured as a provider sees it, `write` writes in the turn's folder under the host's writer, and
 * the delegation tools run on the turn's delegation host, as Pi's agent calls them over Mousse's MCP server.
 */
function toolLoopAdapter(): ProviderAdapter {
  const runTool = async (call: ToolCall, input: TurnInput, host: AdapterHost): Promise<unknown> => {
    if (call.name === 'write') {
      const write = async () => writeFileSync(join(input.cwd!, String(call.arguments.path)), String(call.arguments.content ?? ''))
      await (host.tools.toolAccess ? host.tools.toolAccess.execute('write', call.arguments, write) : write())
      return `Wrote ${String(call.arguments.path)}`
    }
    if (!host.tools.delegation) throw new Error(`Unknown tool: ${call.name}`)
    return dispatchDelegationTool(host.tools.delegation, call)
  }
  return {
    driver: 'pi',
    capabilities: PI_TEST_CAPABILITIES,
    configured: () => true,
    async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
      const providerRef = { provider: input.llmProvider, model: input.model }
      sink.providerRef(providerRef)
      // The transcript as a provider sees it.
      const messages = [...input.messages] as unknown as Context['messages']
      let text = ''
      const result = (aborted: boolean): TurnResult => {
        if (!aborted) host.context.nativeHistoryAfterTurn(text)
        return { text, aborted, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
      }
      for (;;) {
        if (input.signal.aborted) return result(true)
        const context: Context = { messages: structuredClone(messages) }
        captured.push(structuredClone(context))
        const reply = await respond(context, input.signal)
        if (input.signal.aborted) return result(true)
        messages.push(reply)
        const said = reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
        if (said) {
          sink.text({ phase: 'complete', content: said, contentIndex: 0 })
          text = said
        }
        const calls = reply.content.filter((block): block is ToolCall => block.type === 'toolCall')
        if (!calls.length) return result(false)
        for (const call of calls) {
          const outcome = await runTool(call, input, host).then(
            (value) => ({ text: typeof value === 'string' ? value : JSON.stringify(value), isError: false }),
            (error: unknown) => ({ text: error instanceof Error ? error.message : String(error), isError: true })
          )
          messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: outcome.text }], isError: outcome.isError, timestamp: Date.now() })
        }
      }
    },
    interrupt: async () => 'not_active'
  }
}
beforeEach(async () => {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  f = gitFoundationFixture()
  mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
  await mms.start()
  const ownerToken = mms.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
  const endpoint = await server.start()
  client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
  await client.connect()
  const provider = mms.providerAuth.models.getProviders().find((entry) => mms.providerAuth.models.getModels(entry.id).length > 0)!
  const model = mms.providerAuth.models.getModels(provider.id)[0]
  mms.orchestrator.setHarness(testHarness({ adapters: [toolLoopAdapter()], profileHome: mms.getProfileHomeDir() }))
  const settings = mms.settings.get()
  mms.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: { ...settings.integrations,
    tools: { enabled: true, enabledTools: ['read', 'write', 'bash'] }, skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false } } })
}, 30_000)
afterEach(async () => { await client?.close(); await server?.stop(); await mms?.stop(); vi.restoreAllMocks(); f?.dispose(); captured.length = 0; respond = () => { throw new Error('Named provider fixture exhausted') } })


/** Text of the latest user message in a provider context, without the preamble a subagent's first prompt starts with. */
function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === 'user')
  if (!user) return ''
  const content = typeof user.content === 'string' ? user.content : user.content.map((part) => ('text' in part ? part.text : '')).join('')
  return content.replace(/^You are a subagent of "[^"]*"\.[^\n]*\n\n/, '')
}
/** Tool results since the latest user message. */
function toolResultsSinceUser(context: Context) {
  const index = context.messages.map((message) => message.role).lastIndexOf('user')
  return context.messages.slice(index + 1).filter((message) => message.role === 'toolResult')
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const text = (value: string) => providerResponse([{ type: 'text', text: value }], 'stop')
const DELEGATION_ID = /finished task (delegation:[0-9a-f-]+)/
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// Phase 4 (SPEC §14): create_subagent is a wrapper over delegate_task. The parent no longer blocks
// inside the tool call: the child is a thread with lineage, its completion is an inbox row, and
// reconciler rule 4 wakes the parent with the result and what the child left in its worktree.
// Mousse merges nothing; the parent brings the work in itself.
it('delegates main to an isolated writer thread and wakes main with its result and its frozen files, merging nothing', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Nested writers', project.id)
  const wakes: string[] = []
  respond = (context) => {
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    if (prompt === 'Delegate the change.') return results.length ? text('Main delegated') : toolCall('create-worker', 'create_subagent', { name: 'Worker', task: 'Write value', access: 'write' })
    if (prompt === 'Write value') return results.length ? text('Worker done') : toolCall('worker-write', 'write', { path: 'value.txt', content: 'child result\n' })
    const delegationId = DELEGATION_ID.exec(prompt)?.[1]
    if (delegationId) {
      if (results.length === 0) { wakes.push(prompt); return toolCall('main-status', 'task_status', { delegationId }) }
      return text('Main read the result')
    }
    return text('unexpected')
  }
  const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Delegate the change.', mode: 'agent' })
  expect(result.message).toBe('Main delegated')
  const [delegation] = mms.orchestrator.listDelegations(thread.id)
  const child = mms.threads.getThread(delegation.childThreadId)!
  await vi.waitFor(() => {
    expect(mms.orchestrator.getMessages(thread.id).some((message) => message.role === 'assistant' && message.content === 'Main read the result')).toBe(true)
  }, { timeout: 20_000, interval: 50 })
  const childWorkspace = new ThreadWorkspaceManager(mms.threads.getThreadDir(child.id)).load()!
  const resultRef = `${delegationResultRefPrefix(child.id, delegation.delegationId)}/result`
  // The wake says where the child worked, what it changed and how to bring it in; task_status carries the same.
  expect(wakes[0]).toContain('Worker done')
  expect(wakes[0]).toContain(`Worked in: ${childWorkspace.worktreePath} (its own worktree)`)
  expect(wakes[0]).toContain('Files: 1 changed (value.txt)')
  expect(wakes[0]).toContain(resultRef)
  expect(wakes[0]).toMatch(/Mousse merged nothing\. To bring the files in: git diff --binary [0-9a-f]{40} [0-9a-f]{40} \| git apply --3way/)
  const status = captured.flatMap((context) => context.messages).find((message) => message.role === 'toolResult' && message.toolName === 'task_status')
  expect(JSON.stringify(status)).toContain('workspaceResult')
  // Nothing came into the parent; the result is pinned under a ref that outlives the child's worktree.
  expect(f.read(childWorkspace.worktreePath)).toBe('child result\n')
  const mainWorkspace = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()
  if (mainWorkspace) expect(f.read(mainWorkspace.worktreePath)).toBe('base\n')
  expect(f.read(f.repo)).toBe('base\n')
  expect(gitIn(f.repo, 'show', `${resultRef}:value.txt`)).toBe('child result')
}, 45_000)

it('provisions first-use task editor writes and commits only in the owned checkout', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('First editor save', project.id)
  await client.request('files.write', { threadId: thread.id, path: 'value.txt', content: 'editor-owned\n' })
  const metadata = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!
  expect(f.read(metadata.worktreePath)).toBe('editor-owned\n')
  expect(f.read(f.repo)).toBe('base\n')
  writeFileSync(join(metadata.worktreePath, 'value.txt'), 'manual owned change\n')
  await client.request('git.commit', { threadId: thread.id, message: 'Reviewed manual owned change' })
  expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).verify().lifecycle).toBe('ready')
  await expect(client.request('git.checkout', { threadId: thread.id, branch: 'master' })).rejects.toThrow('authoritative')
  expect(f.read(f.repo)).toBe('base\n')
}, 30_000)

// Phase 4: create_subagents starts every valid assignment as its own child thread and returns at
// once; a failed admission is reported per item and does not stop the others.
it('starts every valid parallel assignment without waiting and reports a failed admission', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Parallel batch', project.id)
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  let entered = 0
  respond = (context) => {
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    if (prompt === 'Run parallel agents') {
      if (results.length) return text('Batch started')
      return toolCall('parallel-batch', 'create_subagents', { agents: [
        { name: 'Empty', task: '   ', workspace: 'isolated' },
        { name: 'Slow A', task: 'slow-a', workspace: 'isolated' },
        { name: 'Slow B', task: 'slow-b', workspace: 'isolated' }
      ] })
    }
    if ((prompt === 'slow-a' || prompt === 'slow-b') && !results.length) {
      entered += 1
      return delayed.then(() => text(`${prompt} finished`))
    }
    return text('Batch settled')
  }
  try {
    const result = await client.request<{ message: string }>('orchestrator.send', { threadId: thread.id, content: 'Run parallel agents', mode: 'agent' })
    expect(result.message).toBe('Batch started')
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 15_000 })
    const batchResult = captured.flatMap((context) => context.messages).find((message) => message.role === 'toolResult' && message.toolName === 'create_subagents')
    expect(JSON.stringify(batchResult)).toContain('needs a prompt')
    const started = mms.orchestrator.listDelegations(thread.id)
    expect(started.map((entry) => entry.title).sort()).toEqual(['Slow A', 'Slow B'])
    expect(started.every((entry) => entry.status === 'running')).toBe(true)
    release()
    await vi.waitFor(() => {
      expect(mms.orchestrator.listDelegations(thread.id).every((entry) => entry.childRunStatus === 'completed' && entry.status !== 'running')).toBe(true)
    }, { timeout: 15_000, interval: 50 })
  } finally { release() }
}, 45_000)
// Phase 4: task_cancel stops a child and everything it delegated, depth-first; a cancelled
// descendant cannot publish its late result. The child ended its turn while its own subagent still
// runs, so its task is held (issue #142): it has not published, nothing woke the parent, and the
// cancel reaches both tasks.
it('cancels a delegated child and its nested delegation depth-first, aborting the live grandchild', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Cancel descendants', project.id)
  let release!: () => void, observeAbort!: () => void
  const draining = new Promise<void>((resolve) => { release = resolve })
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve })
  let nestedEntered = false
  respond = (context, signal) => {
    const prompt = lastUserText(context), results = toolResultsSinceUser(context)
    if (prompt === 'Delegate nested') return results.length ? text('Main delegated') : toolCall('main-create', 'create_subagent', { name: 'Parent cancel', task: 'Delegate deeper', access: 'write' })
    if (prompt === 'Delegate deeper') return results.length ? text('Child delegated') : toolCall('child-create', 'create_subagent', { name: 'Nested cancel', task: 'Wait for cancellation', access: 'write' })
    if (prompt === 'Wait for cancellation' && !results.length) {
      nestedEntered = true
      if (signal.aborted) observeAbort()
      else signal.addEventListener('abort', observeAbort, { once: true })
      return draining.then(() => text('Drained'))
    }
    return text('ok')
  }
  try {
    await client.request('orchestrator.send', { threadId: thread.id, content: 'Delegate nested', mode: 'agent' })
    await vi.waitFor(() => expect(nestedEntered).toBe(true), { timeout: 15_000 })
    const [child] = mms.orchestrator.listDelegations(thread.id)
    const [grandchild] = mms.orchestrator.listDelegations(child.childThreadId)
    expect(grandchild).toMatchObject({ title: 'Nested cancel', status: 'running' })
    await vi.waitFor(() => expect(mms.orchestrator.listDelegations(thread.id)[0].childRunStatus).toBe('completed'), { timeout: 15_000, interval: 50 })
    expect(mms.orchestrator.listDelegations(thread.id)[0]).toMatchObject({ status: 'running' })
    const cancelled = await mms.orchestrator.cancelDelegation(thread.id, child.delegationId)
    expect(cancelled.cancelled).toEqual([grandchild.delegationId, child.delegationId])
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Descendant did not receive cancellation')), 5_000))])
    release()
    await vi.waitFor(() => {
      const [nested] = mms.orchestrator.listDelegations(child.childThreadId)
      expect(nested.status).toBe('cancelled')
      expect(['interrupted', 'cancelled']).toContain(nested.childRunStatus)
    }, { timeout: 15_000, interval: 50 })
    expect(mms.orchestrator.listDelegations(thread.id)[0].status).toBe('cancelled')
  } finally { release() }
}, 45_000)

it('refuses to stop or merge a retired named agent from old task data and leaves it untouched', async () => {
  const project = mms.projects.openProject(f.repo), thread = mms.threads.createThread('Legacy named agent', project.id)
  const { agentId } = seedLegacyNamedEpisode(mms.threads.getThreadDir(thread.id), { worktreePath: f.repo })
  const registry = mms.orchestrator.getAgentsForThread(thread.id)
  registry.create({ cliType: 'mousse', executionMode: 'gui', task: 'Legacy named agent task', worktreePath: f.repo, status: 'ready' }, agentId)
  await expect(mms.orchestrator.stopAgentForThread(thread.id, agentId, true)).rejects.toThrow(/retired named agent/)
  const logs = await mms.orchestrator.stopAgentForThread(thread.id, agentId, false)
  expect(logs.join(' ')).toMatch(/retired named agent.*Nothing was stopped or changed/)
  expect(registry.get(agentId)?.status).toBe('ready')
}, 30_000)
