/**
 * What a thread's credential lists and what a turn may use (PR 2 §2 "Tool lists across turns"): the
 * list is stable for the thread whatever the turn's mode; the turn's own limits apply at call time.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { callTool, listTools, VendorAdapter, vendorDaemon, type Mcp, type ToolCallResult, type VendorDaemon } from './appToolVendorFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { piAdapter, waitFor } from './phase6Fixture'

/** The usable-tools note of a turn preamble, as a list of names. */
function usableNow(preamble: string): string[] {
  const match = /Usable now: (.*)\.$/m.exec(preamble)
  if (!match) throw new Error(`no usable-tools note in ${JSON.stringify(preamble)}`)
  return match[1].split(', ').sort()
}

describe('a vendor thread\'s tool list across a plan turn and an agent turn', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('lists the same tools on both; thread_fork is refused on the plan turn and accepted on the agent turn with the same bearer', async () => {
    const seen: Array<{ mcp: Mcp; tools: string[]; fork: ToolCallResult }> = []
    const vendor = new VendorAdapter(async ({ mcp }) => {
      seen.push({ mcp: mcp!, tools: await listTools(mcp!), fork: await callTool(mcp!, 'thread_fork', { seedFrom: 'current_head', title: 'Branch' }) })
      return 'Done.'
    })
    d = await vendorDaemon([vendor])
    const plan = await d.send('Plan the change', 'plan')
    const agent = await d.send('Now do it', 'agent')
    const [onPlan, onAgent] = seen

    expect(onPlan.tools).toEqual(onAgent.tools)
    expect(onPlan.tools).toContain('thread_fork')
    expect(onPlan.fork.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_ceiling_exceeded, data: { reason: 'mousse_ceiling_exceeded' } })

    // Claude's per_call binding keeps the bearer and re-binds it to the next run with that turn's ceiling.
    expect(onAgent.mcp.token).toBe(onPlan.mcp.token)
    expect(onAgent.mcp.turnToken).not.toBe(onPlan.mcp.turnToken)
    expect(onAgent.fork.error).toBeUndefined()
    expect(onAgent.fork.isError).toBeUndefined()
    const forked = JSON.parse(onAgent.fork.text!) as { threadId: string }
    expect(forked.threadId).toBeTruthy()
    expect(forked.threadId).not.toBe(d.thread.id)
    expect(d.credentials.listForThread(d.thread.id)).toEqual([
      expect.objectContaining({ runId: agent.runId, binding: 'per_call', modeCeiling: 'default', revokedAt: null })
    ])
    expect(plan.runId).not.toBe(agent.runId)

    // The usable-tools note names what each turn may use: thread_fork only on the agent turn.
    const planNote = usableNow(vendor.bridges[0].turnPreamble)
    const agentNote = usableNow(vendor.bridges[1].turnPreamble)
    expect(planNote).not.toContain('thread_fork')
    expect(agentNote).toContain('thread_fork')
    expect(agentNote.filter((name) => !planNote.includes(name))).toEqual(['thread_fork'])
    for (const name of agentNote) expect(onAgent.tools).toContain(name)
  }, 30_000)

  it('the usable-tools note leaves out tools Settings turned off and browser tools without a binding', async () => {
    const vendor = new VendorAdapter(() => 'Done.')
    d = await vendorDaemon([vendor])
    const browser: BrowserRuntimePort = { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) }
    d.orch.setBrowserRuntime(browser)
    const tools = d.settings().integrations.tools
    tools.enabledTools = tools.enabledTools!.filter((name) => name !== 'ask_user' && name !== 'create_task')
    await d.send('Hello')
    const note = usableNow(vendor.bridges[0].turnPreamble)
    expect(note).toEqual(expect.arrayContaining(['delegate_task', 'present_plan', 'list_tasks', 'thread_read', 'thread_fork', 'queue_enqueue']))
    expect(note).not.toContain('ask_user')
    expect(note).not.toContain('create_task')
    expect(note.filter((name) => name.startsWith('browser_'))).toEqual([])
    // The thread's list still has them: they are listed, and refused with a reason at call time.
    const listed = d.orch.mcpToolRegistry().listForThread(d.thread.id).map((tool) => tool.name)
    expect(listed).toEqual(expect.arrayContaining(['ask_user', 'create_task', 'browser_open']))
  }, 30_000)

  /** A vendor parent (in a project when `project`) that delegates a read-only (`shared`) plan-ceiling pi child. */
  const delegatedChild = async (project: boolean) => {
    let delegationId: string | undefined
    const vendor = new VendorAdapter(async ({ input, mcp }) => {
      if (input.prompt !== 'Survey it') return 'Noted.'
      const started = await callTool(mcp!, 'delegate_task', {
        prompt: 'Survey the run engine', title: 'Surveyor', provider: 'openai', model: 'gpt-replay',
        workspace: 'shared', role: 'research', modeCeiling: 'plan', clientRequestId: 'survey-1'
      })
      delegationId = JSON.parse(started.text!).delegationId
      return 'Delegated.'
    })
    d = await vendorDaemon([vendor, piAdapter(() => 'Surveyed.')])
    let parentId = d.thread.id
    if (project) {
      const projectDir = join(d.home, 'project')
      mkdirSync(projectDir)
      parentId = d.store.createThread('Parent', d.projects.openProject(projectDir).id).id
      d.orch.setThreadModelOverride(parentId, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    }
    await d.send('Survey it', 'agent', parentId)
    const delegation = d.engine.delegations.get(delegationId!)!
    expect(delegation).toMatchObject({ modeCeiling: 'plan', workspace: 'shared' })
    await waitFor(() => d!.engine.getRun(delegation.childRunId)?.status === 'completed', 'the child run')
    return { parentId, childThreadId: delegation.childThreadId }
  }

  const expectReadOnlyPlanListing = (parentId: string, childThreadId: string) => {
    const host = d!.orch.mcpToolHost()
    expect(host.threadCeiling!(childThreadId)).toBe('plan')
    expect(host.readOnlyThread!(childThreadId)).toBe(true)
    const listed = d!.orch.mcpToolRegistry().listForThread(childThreadId)
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.map((tool) => tool.name)).not.toContain('thread_fork')
    for (const tool of listed) expect(tool.access === 'reads' || tool.access === 'readsOthers' || tool.readOnlySafe === true, tool.name).toBe(true)
    // The parent's list is unaffected.
    expect(d!.orch.mcpToolRegistry().listForThread(parentId).map((tool) => tool.name)).toContain('thread_fork')
  }

  it('a delegated read-only plan child lists only reads and read-only-safe tools, never thread_fork', async () => {
    const { parentId, childThreadId } = await delegatedChild(true)
    expectReadOnlyPlanListing(parentId, childThreadId)
  }, 30_000)
})

describe('listing and per-turn availability over the server', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async (hostOverrides: Parameters<typeof fakeAppToolHost>[0] = {}, turn: Partial<Parameters<typeof appTurn>[0]> = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost(hostOverrides)
    const { registry, turns } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, ...turn }))
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    const bearer = (modeCeiling: 'plan' | 'default' = 'default') =>
      server!.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, modeCeiling, binding: 'drained_turn', generation: 'g' })!
    return { run, registry, bearer, ...fake }
  }

  it('a tool the turn cannot use now is a tool error that says why, not a protocol error', async () => {
    const browser: BrowserRuntimePort = { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) }
    const { bearer, host } = await setup({ browserRuntime: () => browser }, { settingsEnabled: (name) => name !== 'ask_user' })
    const mcp = bearer()
    const tools = await listTools(mcp)
    expect(tools).toEqual(expect.arrayContaining(['ask_user', 'browser_open']))
    const off = await callTool(mcp, 'ask_user', { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }] })
    expect(off).toMatchObject({ status: 200, error: undefined, isError: true, text: 'Tool "ask_user" is disabled in Settings → Skills & MCP.' })
    expect(host.askUser).not.toHaveBeenCalled()
    const unbound = await callTool(mcp, 'browser_open', {})
    expect(unbound).toMatchObject({ status: 200, error: undefined, isError: true, text: expect.stringMatching(/^Browser tools are not bound for this turn/) })
  })

  it('the list follows the thread\'s ceiling, not the credential\'s turn ceiling', async () => {
    const { bearer } = await setup()
    const onAgent = await listTools(bearer('default'))
    const onPlan = await listTools(bearer('plan'))
    expect(onPlan).toEqual(onAgent)
    expect(onPlan).toContain('thread_fork')
  })

  it('a thread whose delegation gave it a plan ceiling never lists thread_fork', async () => {
    const { bearer, registry } = await setup({ threadCeiling: () => 'plan' })
    const tools = await listTools(bearer('default'))
    expect(tools).not.toContain('thread_fork')
    expect(tools).toContain('queue_enqueue')
    expect(registry.listForThread('thread-a').some((tool) => tool.access === 'startsThreads')).toBe(false)
  })

  it('a read-only child lists only reads and read-only-safe tools, and the others are refused', async () => {
    const { bearer, registry } = await setup({ readOnlyThread: () => true })
    const mcp = bearer()
    const tools = await listTools(mcp)
    const expected = registry.listFor({ readOnly: false, modeCeiling: 'default' }).filter((tool) => tool.access === 'reads' || tool.access === 'readsOthers' || tool.readOnlySafe).map((tool) => tool.name).sort()
    expect(tools).toEqual(expected)
    expect(tools).toEqual(expect.arrayContaining(['thread_read', 'queue_list', 'ask_user', 'present_plan']))
    expect(tools).not.toContain('thread_fork')
    expect(tools).not.toContain('queue_enqueue')
    const refused = await callTool(mcp, 'queue_enqueue', { content: 'x' })
    expect(refused.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_read_only })
  })
})
