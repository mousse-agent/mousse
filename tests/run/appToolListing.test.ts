/**
 * What a thread's credential lists and what a turn may use (PR 2 §2 "Tool lists across turns"): the
 * list is stable for the thread whatever the turn's mode; the turn's own limits apply at call time.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import { canonicalToolName } from '../../src/shared/toolAliases'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { callTool, listTools, VendorAdapter, vendorDaemon, type VendorDaemon } from './appToolVendorFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { piAdapter, waitFor } from './phase6Fixture'

/** The usable-tools note of a turn preamble, as a list of names. */
function usableNow(preamble: string): string[] {
  const match = /Usable now: (.*)\.$/m.exec(preamble)
  if (!match) throw new Error(`no usable-tools note in ${JSON.stringify(preamble)}`)
  return match[1].split(', ').sort()
}

describe('a vendor thread\'s tool list', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('the usable-tools note leaves out tools Settings turned off and browser tools without a binding', async () => {
    const vendor = new VendorAdapter(() => 'Done.')
    d = await vendorDaemon([vendor])
    const browser: BrowserRuntimePort = { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) }
    d.orch.setBrowserRuntime(browser)
    const tools = d.settings().integrations.tools
    tools.enabledTools = tools.enabledTools!.filter((name) => name !== 'question_ask' && name !== 'task_create')
    await d.send('Hello')
    const note = usableNow(vendor.bridges[0].turnPreamble)
    expect(note).toEqual(expect.arrayContaining(['thread_create', 'task_list', 'thread_read', 'thread_fork', 'queue_enqueue']))
    expect(note).not.toContain('question_ask')
    expect(note).not.toContain('task_create')
    expect(note.filter((name) => name.startsWith('browser_'))).toEqual([])
    // The thread's list still has them: they are listed, and refused with a reason at call time.
    const listed = d.orch.mcpToolRegistry().listForThread(d.thread.id).map((tool) => tool.name)
    expect(listed).toEqual(expect.arrayContaining(['question_ask', 'task_create', 'browser_open']))
  }, 30_000)

  /** A vendor parent (in a project when `project`) that delegates a read-only (`shared`) pi child. */
  const delegatedChild = async (project: boolean) => {
    let delegationId: string | undefined
    const vendor = new VendorAdapter(async ({ input, mcp }) => {
      if (input.prompt !== 'Survey it') return 'Noted.'
      const started = await callTool(mcp!, 'delegate_task', {
        prompt: 'Survey the run engine', title: 'Surveyor', provider: 'openai', model: 'gpt-replay',
        workspace: 'shared', role: 'research', readOnly: true, clientRequestId: 'survey-1'
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
    expect(delegation).toMatchObject({ workspace: 'shared' })
    await waitFor(() => d!.engine.getRun(delegation.childRunId)?.status === 'completed', 'the child run')
    return { parentId, childThreadId: delegation.childThreadId }
  }

  const expectReadOnlyListing = (parentId: string, childThreadId: string) => {
    const host = d!.orch.mcpToolHost()
    expect(host.readOnlyThread!(childThreadId)).toBe(true)
    const listed = d!.orch.mcpToolRegistry().listForThread(childThreadId)
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.map((tool) => tool.name)).not.toContain('thread_fork')
    // A tool that sends a note to its family (`messageIntent`, thread_send) stays listed for a read-only child, as does one
    // whose old variant was read-only-safe (thread_stop, as task_cancel was listed; each call is still held to it).
    const viaVariant = readOnlySafeVariants(d!.orch.mcpToolRegistry())
    for (const tool of listed) expect(tool.access === 'reads' || tool.access === 'readsOthers' || tool.readOnlySafe === true || tool.messageIntent !== undefined || viaVariant.has(tool.name), tool.name).toBe(true)
    // The parent's list is unaffected.
    expect(d!.orch.mcpToolRegistry().listForThread(parentId).map((tool) => tool.name)).toContain('thread_fork')
  }

  it('a delegated read-only child lists only reads and read-only-safe tools, never thread_fork', async () => {
    const { parentId, childThreadId } = await delegatedChild(true)
    expectReadOnlyListing(parentId, childThreadId)
  }, 30_000)
})

/** The new tools listed for a read-only child through an old variant of theirs that was read-only-safe (`listsAsVariant`). */
const readOnlySafeVariants = (registry: { variantTools(): Array<{ name: string; readOnlySafe?: boolean }> }) =>
  new Set(registry.variantTools().filter((tool) => tool.readOnlySafe === true).map((tool) => canonicalToolName(tool.name)))

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
    const bearer = () =>
      server!.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, binding: 'drained_turn', generation: 'g' })!
    return { run, registry, bearer, ...fake }
  }

  it('a tool the turn cannot use now is a tool error that says why, not a protocol error', async () => {
    const browser: BrowserRuntimePort = { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) }
    const { bearer, host } = await setup({ browserRuntime: () => browser }, { settingsEnabled: (name) => name !== 'question_ask' })
    const mcp = bearer()
    const tools = await listTools(mcp)
    expect(tools).toEqual(expect.arrayContaining(['question_ask', 'browser_open']))
    const off = await callTool(mcp, 'question_ask', { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }] })
    expect(off).toMatchObject({ status: 200, error: undefined, isError: true })
    expect(refusalOf(off)).toMatchObject({ message: 'Tool "question_ask" is disabled in Settings → Skills & MCP.', refused: { code: 'unavailable' } })
    expect(host.askUser).not.toHaveBeenCalled()
    const unbound = await callTool(mcp, 'browser_open', {})
    expect(unbound).toMatchObject({ status: 200, error: undefined, isError: true })
    expect(refusalOf(unbound)?.message).toMatch(/^Browser tools are not bound for this turn/)
  })

  it('a read-only child lists only reads and read-only-safe tools, and the others are refused', async () => {
    const { bearer, registry } = await setup({ readOnlyThread: () => true })
    const mcp = bearer()
    const tools = await listTools(mcp)
    const viaVariant = readOnlySafeVariants(registry)
    const expected = registry.listFor({ readOnly: false }).filter((tool) => tool.access === 'reads' || tool.access === 'readsOthers' || tool.readOnlySafe || tool.messageIntent !== undefined || viaVariant.has(tool.name)).map((tool) => tool.name).sort()
    expect(tools).toEqual(expected)
    // thread_stop is listed for its subagent variant only: a Stop of a thread it names is refused, as before.
    expect(tools).toContain('thread_stop')
    expect(refusalOf(await callTool(mcp, 'thread_stop', { threadId: 'thread-b', runId: 'run-b' }))).toMatchObject({ code: 'mousse_read_only' })
    expect(tools).toEqual(expect.arrayContaining(['thread_read', 'queue_list', 'question_ask']))
    expect(tools).not.toContain('thread_fork')
    expect(tools).not.toContain('queue_enqueue')
    const refused = await callTool(mcp, 'queue_enqueue', { content: 'x' })
    expect(refusalOf(refused)).toMatchObject({ code: 'mousse_read_only', refused: { code: 'lacks_capability', lacks: 'threads.manage' } })
  })
})
