/**
 * The browser tools over MCP (PR 2 §2): a turn's trusted browser binding decides what runs, and a
 * vendor runtime gets the browser through Mousse's MCP server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionPolicyService } from '../../src/mms/execution/ExecutionPolicyService'
import type { BrowserExecutionBinding } from '../../src/mms/orchestrator/browser'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool, type BrowserToolContext, type BrowserToolOutput } from '../../src/shared/browser/automation'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { callTool, listTools, VendorAdapter, vendorDaemon, type VendorDaemon } from './appToolVendorFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { waitFor } from './phase6Fixture'

const PROFILE = 'profile-1'
const PNG = 'iVBORw0KGgo='

/** A browser port that records what reached it; `hang` tools wait for their call's abort signal. */
function fakeBrowserPort(options: { access?: 'allowed'; hang?: BrowserAutomationTool[] } = {}) {
  const dispatched: Array<{ name: BrowserAutomationTool; args: unknown; context: BrowserToolContext }> = []
  const screenshots: Array<{ sessionId: string; artifactId: string }> = []
  const port: BrowserRuntimePort = {
    resolveTarget: () => ({ backend: 'managed-chromium' }),
    requestAccess: vi.fn(async () => options.access as 'allowed'),
    dispatch: async (context, name, args) => {
      dispatched.push({ name, args, context })
      if (options.hang?.includes(name))
        await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return {
        observation: { sessionId: 'session-1', tabId: 'tab-1', url: 'http://127.0.0.1/', title: 'Fixture', screenshot: { artifactId: 'shot-1', pixelWidth: 2, pixelHeight: 2 } }
      } as unknown as BrowserToolOutput
    },
    readScreenshot: async (_context, sessionId, artifactId) => {
      screenshots.push({ sessionId, artifactId })
      return { data: PNG, mimeType: 'image/png' }
    }
  }
  return { port, dispatched, screenshots }
}

/** A structured binding allowing every browser tool for `threadId`'s turn. */
function browserBinding(threadId: string, turnId: string, vision: boolean): BrowserExecutionBinding {
  const policy = new ExecutionPolicyService().snapshot(PROFILE, {
    allowedTools: [...BROWSER_AUTOMATION_TOOLS],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'external'],
    maxToolCalls: 100,
    maxElapsedMs: 60_000
  })
  return {
    execution: { profileId: PROFILE, threadId, turnId, runId: turnId, actor: { kind: 'main' }, policySnapshotId: policy.id, source: 'gui', cancellationId: turnId },
    policy,
    mode: 'structured',
    vision
  }
}

describe('browser tools over MCP', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async (input: { runtime?: boolean; vision?: boolean; bound?: boolean; settingsEnabled?: (name: string) => boolean; access?: 'allowed' } = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const browser = fakeBrowserPort({ access: input.access })
    const fake = fakeAppToolHost(input.runtime === false ? {} : { browserRuntime: () => browser.port })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({
      threadId: 'thread-a',
      runId: run.runId,
      ...(input.bound === false ? {} : { browser: browserBinding('thread-a', run.runId, input.vision ?? true) }),
      ...(input.settingsEnabled ? { settingsEnabled: input.settingsEnabled } : {})
    }))
    const ctx = (signal?: AbortSignal) => request({ threadId: 'thread-a', runId: run.runId, ...(signal ? { signal } : {}) })
    return { run, registry, ctx, ...browser }
  }

  it('a vision binding returns the screenshot as an image, also as MCP image content through the server', async () => {
    const { registry, ctx, dispatched, screenshots, run } = await setup({ vision: true })
    const outcome = await registry.call('browser_screenshot', { sessionId: 'session-1' }, ctx())
    expect(outcome.isError).toBeFalsy()
    expect(outcome.images).toEqual([{ data: PNG, mimeType: 'image/png' }])
    expect(dispatched.map((call) => call.name)).toEqual(['browser_screenshot'])
    expect(dispatched[0].context).toMatchObject({ vision: true, target: { backend: 'managed-chromium' }, execution: { threadId: 'thread-a', turnId: run.runId } })
    expect(screenshots).toEqual([{ sessionId: 'session-1', artifactId: 'shot-1' }])

    server = new MousseMcpServer({ credentials: new McpCredentials(fx!.store), registry })
    await server.start()
    const bearer = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, modeCeiling: 'default', binding: 'drained_turn', generation: 'g' })!
    const result = await callTool(bearer, 'browser_screenshot', { sessionId: 'session-1' })
    expect(result.error).toBeUndefined()
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: expect.any(String) }, { type: 'image', data: PNG, mimeType: 'image/png' }])
  })

  it('without vision no image comes back, and browser_screenshot is refused before it reaches the port', async () => {
    const { registry, ctx, dispatched, screenshots } = await setup({ vision: false })
    const observed = await registry.call('browser_observe', { sessionId: 'session-1', includeScreenshot: true }, ctx())
    expect(observed.isError).toBeFalsy()
    expect(observed.images).toBeUndefined()
    expect(dispatched.map((call) => call.name)).toEqual(['browser_observe'])
    expect(dispatched[0].context.vision).toBe(false)

    const shot = await registry.call('browser_screenshot', { sessionId: 'session-1' }, ctx())
    expect(shot).toMatchObject({ isError: true, text: expect.stringMatching(/does not support image input/) })
    expect(shot.images).toBeUndefined()
    expect(dispatched.map((call) => call.name)).toEqual(['browser_observe'])
    expect(screenshots).toEqual([])
  })

  it('a turn with no binding is told the browser is not bound, and nothing is dispatched', async () => {
    const { registry, ctx, dispatched, port } = await setup({ bound: false })
    const outcome = await registry.call('browser_open', { url: 'http://127.0.0.1/' }, ctx())
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toMatch(/^Browser tools are not bound for this turn/)
    expect(dispatched).toEqual([])
    expect(port.requestAccess).not.toHaveBeenCalled()
  })

  it('Settings turning browser_open off returns the disabled text; the other tools still run', async () => {
    const { registry, ctx, dispatched } = await setup({ settingsEnabled: (name) => name !== 'browser_open' })
    const off = await registry.call('browser_open', { url: 'http://127.0.0.1/' }, ctx())
    expect(off).toEqual({ text: 'Tool "browser_open" is disabled in Settings → Skills & MCP.', isError: true })
    expect(dispatched).toEqual([])
    expect((await registry.call('browser_tabs', { sessionId: 'session-1' }, ctx())).isError).toBeFalsy()
    expect(dispatched.map((call) => call.name)).toEqual(['browser_tabs'])
  })

  it('the user allowing access is noted in the result', async () => {
    const { registry, ctx, port } = await setup({ access: 'allowed' })
    const outcome = await registry.call('browser_open', {}, ctx())
    expect(port.requestAccess).toHaveBeenCalledTimes(1)
    expect(outcome.text).toMatch(/^The user selected Allow for agents browser access\./)
  })

  it('the call\'s abort signal is the one dispatch receives', async () => {
    const { registry, ctx, dispatched } = await setup()
    const controller = new AbortController()
    await registry.call('browser_find', { sessionId: 'session-1', query: 'Name' }, ctx(controller.signal))
    expect(dispatched[0].context.signal).toBe(controller.signal)
  })

  it('lists the browser tools only when the host has a browser runtime', async () => {
    const { registry } = await setup()
    const listed = registry.listForThread('thread-a').map((tool) => tool.name).filter((name) => name.startsWith('browser_'))
    expect(listed.sort()).toEqual([...BROWSER_AUTOMATION_TOOLS].sort())
    fx!.dispose()
    const bare = await setup({ runtime: false })
    expect(bare.registry.listForThread('thread-a').some((tool) => tool.name.startsWith('browser_'))).toBe(false)
    const outcome = await bare.registry.call('browser_open', {}, bare.ctx())
    expect(outcome).toMatchObject({ isError: true, text: expect.stringMatching(/^Browser runtime is not bound/) })
  })
})

describe('browser tools of a vendor turn', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('a Claude-shaped turn gets the factory\'s binding in its app turn, and its MCP call reaches the port', async () => {
    const browser = fakeBrowserPort()
    const seen: { turn?: unknown; tools?: string[]; result?: Awaited<ReturnType<typeof callTool>>; factory: unknown[] } = { factory: [] }
    const vendor = new VendorAdapter(async ({ input, mcp }) => {
      seen.turn = d!.orch.appToolTurns.get(input.runId)
      seen.tools = await listTools(mcp!)
      seen.result = await callTool(mcp!, 'browser_screenshot', { sessionId: 'session-1' })
      return 'Looked.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setBrowserRuntime(browser.port)
    d.orch.setMainAgentBrowserFactory((turn) => {
      seen.factory.push(turn)
      return browserBinding(turn.threadId, turn.turnId, true)
    })
    const response = await d.send('Take a look')
    expect(response.runId).toBeTruthy()
    expect(seen.factory).toEqual([expect.objectContaining({ threadId: d.thread.id, mode: 'agent' })])
    expect(seen.turn).toMatchObject({ runId: response.runId, browser: { mode: 'structured', vision: true, execution: { threadId: d.thread.id } } })
    expect(seen.tools).toEqual(expect.arrayContaining([...BROWSER_AUTOMATION_TOOLS]))
    expect(seen.result!.error).toBeUndefined()
    expect(seen.result!.isError).toBeUndefined()
    expect(seen.result!.content!.at(-1)).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' })
    expect(browser.dispatched.map((call) => call.name)).toEqual(['browser_screenshot'])
    expect(browser.dispatched[0].context.execution.threadId).toBe(d.thread.id)
    // The usable-tools note names the browser tools this turn may use.
    expect(vendor.bridges[0].turnPreamble).toMatch(/Usable now: .*browser_open/)
  }, 30_000)

  it('without a browser binding the vendor turn is told why, and nothing reaches the port', async () => {
    const browser = fakeBrowserPort()
    let result: Awaited<ReturnType<typeof callTool>> | undefined
    const vendor = new VendorAdapter(async ({ mcp }) => {
      result = await callTool(mcp!, 'browser_open', {})
      return 'Tried.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setBrowserRuntime(browser.port)
    await d.send('Open the browser')
    expect(result!.error).toBeUndefined()
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/^Browser tools are not bound for this turn/) })
    expect(browser.dispatched).toEqual([])
    expect(vendor.bridges[0].turnPreamble).not.toMatch(/browser_open/)
  }, 30_000)

  it('closing the MCP request aborts the signal dispatch was given', async () => {
    const browser = fakeBrowserPort({ hang: ['browser_wait'] })
    let outcome: unknown
    const vendor = new VendorAdapter(async ({ mcp }) => {
      const closing = new AbortController()
      const pending = callTool(mcp!, 'browser_wait', { sessionId: 'session-1' }, { signal: closing.signal }).catch((error: unknown) => error)
      await waitFor(() => browser.dispatched.length === 1, 'the browser_wait dispatch')
      expect(browser.dispatched[0].context.signal?.aborted).toBe(false)
      closing.abort()
      outcome = await pending
      await waitFor(() => browser.dispatched[0].context.signal?.aborted === true, 'the dispatch signal to abort')
      return 'Stopped waiting.'
    })
    d = await vendorDaemon([vendor])
    d.orch.setBrowserRuntime(browser.port)
    d.orch.setMainAgentBrowserFactory((turn) => browserBinding(turn.threadId, turn.turnId, false))
    await d.send('Wait for the page')
    expect(outcome).toBeInstanceOf(Error)
    expect(browser.dispatched.map((call) => call.name)).toEqual(['browser_wait'])
    expect(browser.dispatched[0].context.signal?.aborted).toBe(true)
  }, 30_000)
})
