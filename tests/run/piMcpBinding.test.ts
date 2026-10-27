import { afterEach, describe, expect, it } from 'vitest'
import { PiBridge } from '../../src/mms/harness/pi/bridge'
import mousseExtension from '../../src/mms/harness/pi/extension/index'
import { PI_BRIDGE_ENV, type PiTurnResponse } from '../../src/mms/harness/pi/extension/protocol'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

// Mousse's Pi extension calling the real Mousse MCP server and app-tool registry (PR 2 §2 `per_call`):
// each call carries the registered turn's token; a call made for an earlier turn reaches no handler.

type Tool = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }> }> }

describe('Pi extension → Mousse MCP registry', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  const bridges: PiBridge[] = []
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.stop()
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
    delete process.env[PI_BRIDGE_ENV]
  })

  /** Loads the extension with a bridge that answers `turn` with `current()`; returns its registered tools. */
  async function extension(current: () => PiTurnResponse): Promise<{ tools: Map<string, Tool>; startTurn(): Promise<void> }> {
    const bridge = new PiBridge()
    await bridge.start()
    bridges.push(bridge)
    const registration = bridge.register({
      catalog: async () => ({ provider: { id: 'openrouter', builtin: true, models: [] }, catalogRevision: 1 }),
      ready: () => {},
      turn: async () => current(),
      gate: async () => ({ allow: true }),
      quiesce: async () => ({ ok: true }),
      fatal: () => {}
    })
    process.env[PI_BRIDGE_ENV] = JSON.stringify(registration.address)
    const tools = new Map<string, Tool>()
    const handlers = new Map<string, (event: unknown) => unknown>()
    await mousseExtension({
      registerCommand: () => {},
      registerProvider: () => {},
      registerTool: (tool: Tool) => void tools.set(tool.name, tool),
      setActiveTools: () => {},
      on: (event: string, handler: (event: unknown) => unknown) => void handlers.set(event, handler)
    } as never)
    return { tools, startTurn: async () => void (await handlers.get('before_agent_start')!({ systemPrompt: '' })) }
  }

  it('a Pi call stamped with the turn token runs; a held call of the earlier turn is refused during the next one', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns } = appToolRegistry(fx.engine, fake.host)
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    const first = turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const bearer = (runId: string) => server!.bearerForTurn({ threadId: 'thread-a', instanceId: 'pi:openrouter', runId, modeCeiling: 'default', binding: 'per_call', generation: 'pi|private:pi:openrouter|0|0' })!
    const attachment = bearer(run.runId)
    let turn: PiTurnResponse = {
      attemptToken: first.turn.turnToken, sessionInstructions: '', activeBuiltins: [], catalogRevision: 1,
      mcp: { url: attachment.url, token: attachment.token },
      tools: [{ name: 'present_plan', description: 'plan', parameters: { type: 'object' }, class: 'read' }]
    }
    const loaded = await extension(() => turn)
    await loaded.startTurn()
    const plan = { title: 'P', markdown: '1.' }
    const result = await loaded.tools.get('present_plan')!.execute('call-1', plan)
    expect(result.content[0]?.text).not.toMatch(/earlier turn/)
    expect(fake.host.presentPlan).toHaveBeenCalledWith('thread-a', plan)

    // Turn N+1 on the same warm process (`per_call` keeps the bearer).
    fx.engine.markTerminal(run.runId, 'completed')
    const next = await fx.runningRun('thread-a')
    const second = turns.register(appTurn({ threadId: 'thread-a', runId: next.runId }))
    expect(bearer(next.runId).token).toBe(attachment.token)
    // A call the extension made for turn N, delivered now: refused before any handler.
    const held = await fetch(attachment.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${attachment.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'present_plan', arguments: { ...plan, [TURN_TOKEN_KEY]: first.turn.turnToken } } })
    }).then((response) => response.json() as Promise<{ error?: { code: number } }>)
    expect(held.error?.code).toBe(MCP_ERROR_CODES.mousse_caller_not_live)
    expect(fake.host.presentPlan).toHaveBeenCalledTimes(1)
    // The extension's next turn stamps the new token, and its call runs.
    turn = { ...turn, attemptToken: second.turn.turnToken }
    await loaded.startTurn()
    await loaded.tools.get('present_plan')!.execute('call-2', plan)
    expect(fake.host.presentPlan).toHaveBeenCalledTimes(2)
  })
})
