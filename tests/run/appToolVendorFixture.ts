/**
 * A real `OrchestratorService`, Run Engine and Mousse MCP server (`phase6Daemon`) driven by a
 * vendor-shaped adapter (Claude subscription capabilities, so driver `claude` with the `per_call`
 * turn binding): it receives the turn's `TurnBridge` and reaches Mousse only over MCP, stamping
 * every call with the bridge's turn token as Claude Code does under Mousse's hook.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, TurnBridge, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { getDefaultSettings } from '../../src/shared/settings'
import type { ChatMode } from '../../src/shared/types'
import { phase6Daemon } from './phase6Fixture'

/** The server and bearer a turn's bridge attaches, with the turn token stamped on each call (none: unstamped). */
export type Mcp = { url: string; token: string; turnToken?: string }

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolCallResult {
  status: number
  error?: { code: number; message: string; data?: { reason: string } }
  isError?: boolean
  text?: string
  content?: McpContent[]
}

export async function callTool(mcp: Mcp, name: string, args: Record<string, unknown> = {}, init: { id?: number; signal?: AbortSignal } = {}): Promise<ToolCallResult> {
  const response = await fetch(mcp.url, {
    method: 'POST',
    signal: init.signal,
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: init.id ?? 1, method: 'tools/call', params: { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args } })
  })
  const raw = await response.text()
  const body = raw ? JSON.parse(raw) as { result?: { content: McpContent[]; isError?: boolean }; error?: ToolCallResult['error'] } : {}
  const first = body.result?.content[0]
  return {
    status: response.status,
    error: body.error,
    isError: body.result?.isError,
    text: first && first.type === 'text' ? first.text : undefined,
    content: body.result?.content
  }
}

export async function listTools(mcp: Mcp): Promise<string[]> {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  const body = await response.json() as { result: { tools: Array<{ name: string }> } }
  return body.result.tools.map((tool) => tool.name).sort()
}

export interface VendorTurn {
  input: TurnInput
  host: AdapterHost
  bridge: TurnBridge
  /** The bridge's server with the turn token; null when the bridge attached none. */
  mcp: Mcp | null
}

/** A vendor runtime with its own loop; `script` is its model and returns the reply. */
export class VendorAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly bridges: TurnBridge[] = []
  readonly inputs: TurnInput[] = []

  constructor(private readonly script: (turn: VendorTurn) => Promise<string> | string) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    const bridge = host.bridge
    if (!bridge) throw new Error('expected a turn bridge')
    this.bridges.push(bridge)
    this.inputs.push(input)
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const mcp = bridge.mcp ? { ...bridge.mcp, turnToken: bridge.turnToken } : null
    const text = await this.script({ input, host, bridge, mcp })
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    host.context.nativeHistoryAfterTurn(text)
    return {
      text, aborted: false, modelName: 'vendor', totalResponseTimeMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'vendor', nativeMessages: [], providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/**
 * The daemon over a temporary `MOUSSE_HOME` with the Mousse MCP server attached, and a thread on the
 * vendor model. `send` runs one turn and resolves when it has settled; `dispose` undoes everything.
 */
export async function vendorDaemon(adapters: ProviderAdapter[]) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-app-tools-'))
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  const daemon = phase6Daemon(home, adapters)
  const { orch, engine, store } = daemon
  // The scripted daemon replaces the pi loop's client; the browser seam forwards to it.
  ;(orch as any).llm.setBrowserRuntime = () => {}
  const credentials = new McpCredentials(engine.store)
  const server = new MousseMcpServer({ credentials, registry: orch.mcpToolRegistry() })
  await server.start()
  orch.setMcpAttachment(server)
  const thread = store.createThread('App tools')
  orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
  let sends = 0
  const send = (content: string, mode: ChatMode = 'agent', threadId = thread.id) =>
    orch.send({ content, mode }, false, { threadId, clientRequestId: `send-${++sends}` })
  /** The thread's live Settings (the daemon's `settingsStore.get()` returns the same object). */
  const settings = () => (orch as any).settingsStore.get() as ReturnType<typeof getDefaultSettings>
  const dispose = async (): Promise<void> => {
    orch.setMcpAttachment(null)
    await server.stop().catch(() => undefined)
    await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
  return { ...daemon, home, credentials, server, thread, send, settings, dispose }
}

export type VendorDaemon = Awaited<ReturnType<typeof vendorDaemon>>
