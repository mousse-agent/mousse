import { runInWorkScope } from '../../execution/workScope'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ANTIGRAVITY_INSTANCE_ID } from '../../../shared/providerInstances'
import { mousseVersion } from '../../appVersion'
import { McpToolError, refusalOutcome, type JsonSchema, type McpCredentialAuthority, type MousseTool, type ToolOutcome, type ToolRegistry } from './appTools'
import { mousseOrchestrationInstructions } from './instructions'
import type { BearerTurn, CredentialRecord, McpCredentials, TurnSettlement } from './McpCredentials'
import type { CallAttribution } from '../nativeHelpers'
import { RELAY_BOT_INSTRUCTIONS, RELAY_INSTRUCTIONS, type RelayHandler } from './relay/handler'

/** The `tools/list` `_meta` key that keeps a tool out of Claude Code's tool search (`MousseTool.alwaysLoad`). */
export const ALWAYS_LOAD_META = 'anthropic/alwaysLoad'

/** Max top-level tool description length when compacting `tools/list` for tight-budget runtimes (Antigravity). */
const COMPACT_DESCRIPTION_CHARS = 120
/** Max nested property description length kept when compacting schemas. */
const COMPACT_PROPERTY_DESCRIPTION_CHARS = 50

function compactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const sentence = /^.{15,}?[.!?](?=\s|$)/.exec(text)
  if (sentence && sentence[0].length <= maxChars) return sentence[0]
  return `${text.slice(0, maxChars - 1).trimEnd()}…`
}

function compactSchemaNode(node: unknown, depth: number): unknown {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => compactSchemaNode(item, depth + 1))
  const record = node as Record<string, unknown>
  // Collapse TypeBox literal unions (`anyOf: [{ const: 'a', type: 'string' }, ...]`) into a compact string enum.
  if (
    Array.isArray(record.anyOf) &&
    record.anyOf.length > 0 &&
    record.anyOf.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as { const?: unknown }).const === 'string' &&
        (entry as { type?: unknown }).type === 'string'
    )
  ) {
    const out: Record<string, unknown> = {
      type: 'string',
      enum: record.anyOf.map((entry) => (entry as { const: string }).const)
    }
    if (typeof record.description === 'string') {
      if (depth === 0) out.description = compactText(record.description, COMPACT_DESCRIPTION_CHARS)
      else if (record.description.length <= COMPACT_PROPERTY_DESCRIPTION_CHARS && !/retry the same call/i.test(record.description)) {
        out.description = record.description
      }
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'description' && typeof value === 'string') {
      if (depth >= 1 && (value.length > COMPACT_PROPERTY_DESCRIPTION_CHARS || /retry the same call/i.test(value))) continue
      out[key] = depth === 0 ? compactText(value, COMPACT_DESCRIPTION_CHARS) : value
      continue
    }
    out[key] = compactSchemaNode(value, depth + 1)
  }
  return out
}

/**
 * Compacts a Mousse tool's `tools/list` entry so runtimes with a tight eager MCP schema budget
 * (Antigravity `agy` drops larger tools once cumulative MCP schema bytes pass ~64 KiB) keep core
 * tools like `delegate_task` instead of silently omitting them. Parameter names, types, enums and
 * `required` fields stay intact; full prose already lives in `mousseOrchestrationInstructions`.
 */
export function compactListedTool<T extends Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'alwaysLoad'>>(tool: T): T {
  return {
    ...tool,
    description: compactText(tool.description, COMPACT_DESCRIPTION_CHARS),
    inputSchema: compactSchemaNode(tool.inputSchema, 0) as JsonSchema
  }
}

/** Default check for runtimes whose eager MCP tool budget needs compact Mousse schemas. */
export function isCompactSchemaProvider(provider: string): boolean {
  return provider === ANTIGRAVITY_INSTANCE_ID || provider.startsWith(`${ANTIGRAVITY_INSTANCE_ID}:`)
}

/** One Mousse tool as `tools/list` gives it; an `alwaysLoad` tool says so in its `_meta`. */
export function listedTool(tool: Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'alwaysLoad'>, options?: { compact?: boolean }) {
  const effective = options?.compact ? compactListedTool(tool) : tool
  return {
    name: effective.name,
    description: effective.description,
    inputSchema: effective.inputSchema as { type: 'object'; properties?: Record<string, object> },
    ...(effective.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META]: true } } : {})
  }
}

/** The MCP relay (`mousse-relay`) a turn attaches: its URL on the same listener, and the catalogue revision. */
export interface McpRelayAttachment {
  url: string
  /** The relay catalogue's revision; a runtime that caches the tool list reopens when it changes. */
  revision: string
}

/** Where a provider runtime reaches the server, and the bearer token of one thread's turn. */
export interface McpAttachment {
  url: string
  token: string
  /** The MCP relay, under the same bearer; absent: the turn attaches only `mousse`. */
  relay?: McpRelayAttachment
  /**
   * What decides the tools the server lists under this bearer: the caller's policy (and a recorded access level), as the
   * gateway keys the credential epoch on them. Equal for two bearers that differ only by a rotation, so a runtime that
   * caches the tool list knows a new bearer alone from new tools; absent counts as one value.
   */
  tools?: string
}

/**
 * What the harness gateway needs to give a turn its bridge (PR 2 §2 `TurnBridge`): a bearer for the
 * turn under the driver's turn binding, the turn's end (the drained-turn check, then in-flight calls
 * abort), and revocation when a thread is deleted or switches instance.
 */
export interface McpAttachmentProvider {
  /** `relayUrl`: where the same listener serves the MCP relay (`RELAY_PATH`). */
  bearerForTurn(input: BearerTurn): (McpAttachment & { tokenHash: string; relayUrl: string }) | null
  turnEnded(input: { threadId: string; runId: string; tokenHash?: string; settlement: TurnSettlement }): 'kept' | 'rotated' | undefined
  revokeThread(threadId: string): void
}

/**
 * Notices a running turn gets with the result of one of its Mousse tool calls (docs/plans/tool-api.md §2.2): its
 * pending subagent results and requests, on a runtime that has no native steer. `release` gives them back when the
 * result never reached the model.
 */
export interface McpToolBoundary {
  deliver(caller: { threadId: string; runId: string }): { text: string; release(): void } | null
}

/** The line that opens the notices a tool result carries, so they are never read as the tool's own output. */
export const BOUNDARY_NOTICE_HEADER = 'Mousse notices that arrived while you were working (not part of the tool result above):'

/**
 * JSON-RPC error codes the server uses (implementation-defined range), for protocol and credential faults only: a
 * tool's refusal is an error result in the refusal shape (`appTools/refusal.ts`).
 */
export const MCP_ERROR_CODES: Record<'mousse_unauthorized' | 'mousse_caller_not_live' | 'mousse_unknown_tool', number> = {
  mousse_unauthorized: -32001,
  mousse_caller_not_live: -32002,
  mousse_unknown_tool: -32601
}

const MCP_PATH = '/mcp'
/** Where the same listener serves the MCP relay (`mousse-relay`), under the same bearer. */
export const RELAY_PATH = '/mcp/relay'
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * The profile's Mousse MCP server (docs/run-engine/SPEC.md §15.1): MCP Streamable HTTP on
 * `127.0.0.1` with a random port, through the SDK's `Server` and stateless
 * `StreamableHTTPServerTransport` (one pair per POST; responses are JSON, the SSE GET stream is
 * not offered). Every request carries `Authorization: Bearer <token>`; the token resolves to the
 * credential it acts under (`McpCredentials`), and the tools come from the app-tool registry.
 */
export class MousseMcpServer implements McpAttachmentProvider {
  private http: HttpServer | null = null
  private address: AddressInfo | null = null
  private readonly sockets = new Set<Socket>()
  /** In-flight tool calls per caller thread; aborted when its turn ends or it is revoked. */
  private readonly inFlight = new Map<string, Set<AbortController>>()

  constructor(
    private readonly options: {
      credentials: McpCredentials
      registry: ToolRegistry
      /** The MCP relay served at `RELAY_PATH`; absent: that path is not found. */
      relay?: RelayHandler
      /** Notices handed over with `mousse` tool results; relayed tools carry none. Absent: none are. */
      boundary?: McpToolBoundary
      /**
       * Who made a call that arrived under a thread's credential, from the ids its runtime put in `_meta`: the run itself,
       * one of its native helpers, or nobody it can tell while a helper may be running (docs/plans/tool-api.md §2.7). Absent:
       * every call is the run's own.
       */
      attribute?: (threadId: string, meta: unknown) => Promise<CallAttribution>
      /** Whether `tools/list` should compact tool schemas for `provider` (defaults to Antigravity instances). */
      compactToolSchemas?: (provider: string) => boolean
      /** Defaults to `127.0.0.1`. */
      host?: string
      /** Defaults to 0 (a random free port). */
      port?: number
    }
  ) {}

  get url(): string {
    if (!this.address) throw new Error('The Mousse MCP server is not running')
    return `http://${this.address.address}:${this.address.port}${MCP_PATH}`
  }

  /** The MCP relay's URL on the same listener (`RELAY_PATH`). */
  get relayUrl(): string {
    if (!this.address) throw new Error('The Mousse MCP server is not running')
    return `http://${this.address.address}:${this.address.port}${RELAY_PATH}`
  }

  get running(): boolean {
    return this.http !== null
  }

  async start(): Promise<void> {
    if (this.http) return
    // Started as the profile's work: a server first started inside a turn would otherwise hand that turn's thread
    // (`currentWorkScope`) to every request it ever serves.
    return runInWorkScope(null, () => this.startOwned())
  }

  private async startOwned(): Promise<void> {
    if (this.http) return
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent) jsonRpcError(res, 500, -32603, error instanceof Error ? error.message : String(error))
        else res.end()
      })
    })
    http.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
    this.http = http
    this.address = http.address() as AddressInfo
  }

  async stop(): Promise<void> {
    const http = this.http
    if (!http) return
    this.http = null
    this.address = null
    for (const controllers of this.inFlight.values()) for (const controller of controllers) controller.abort(new Error('The Mousse MCP server stopped'))
    this.inFlight.clear()
    const closed = new Promise<void>((resolve) => http.close(() => resolve()))
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await closed
  }

  /** The turn's bearer (`McpCredentials.bearerForTurn`); null when the server is not running. */
  bearerForTurn(input: BearerTurn): (McpAttachment & { tokenHash: string; relayUrl: string }) | null {
    if (!this.http) return null
    const { token, tokenHash } = this.options.credentials.bearerForTurn(input)
    return { url: this.url, token, tokenHash, relayUrl: this.relayUrl }
  }

  /**
   * The thread's turn ended: whether its bearer is kept for the next turn is settled first (a call
   * still running counts against a drained turn), then its in-flight tool calls abort (a blocked
   * `question_ask`).
   */
  turnEnded(input: { threadId: string; runId: string; tokenHash?: string; settlement: TurnSettlement }): 'kept' | 'rotated' | undefined {
    const settled = input.tokenHash ? this.options.credentials.settleTurn(input.tokenHash, input.runId, input.settlement) : undefined
    this.abortThread(input.threadId, new Error(`The turn of thread ${input.threadId} ended`))
    return settled
  }

  /** Revokes the thread's credentials (thread deleted, provider switched) and aborts its calls. */
  revokeThread(threadId: string): void {
    this.options.credentials.revokeForThread(threadId)
    this.abortThread(threadId, new Error(`Thread ${threadId} credentials were revoked`))
  }

  private abortThread(threadId: string, reason: Error): void {
    const controllers = this.inFlight.get(threadId)
    if (!controllers) return
    this.inFlight.delete(threadId)
    for (const controller of controllers) controller.abort(reason)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    const relay = path === RELAY_PATH ? this.options.relay : undefined
    if (path !== MCP_PATH && !relay) {
      res.writeHead(404).end()
      return
    }
    const credential = this.options.credentials.resolve(bearerToken(req) ?? '')
    if (!credential) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mousse"')
      jsonRpcError(res, 401, MCP_ERROR_CODES.mousse_unauthorized, 'mousse_unauthorized: missing, unknown, revoked or expired token')
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      jsonRpcError(res, 405, -32000, 'Method not allowed: this server answers POST only (no SSE stream)')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      jsonRpcError(res, 400, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const request = new AbortController()
    this.track(credential.threadId, request)
    // Notices handed over with a result that was never written out go back to pending.
    const handedOver: Array<() => void> = []
    const server = relay ? this.relayServer(relay, credential, request.signal) : this.mcpServer(credential, request.signal, handedOver)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => {
      if (!res.writableFinished) for (const release of handedOver) release()
      request.abort(new Error('The MCP request closed'))
      this.untrack(credential.threadId, request)
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** One SDK server per request, bound to the credential the request's token resolved to. */
  private mcpServer(resolved: CredentialRecord, requestSignal: AbortSignal, handedOver: Array<() => void> = []): Server {
    const { registry, credentials } = this.options
    // A bot's thread gets no orchestration guidance: it names delegation and thread tools no bot can hold.
    const server = new Server(
      { name: 'mousse', version: mousseVersion() },
      { capabilities: { tools: {} }, ...(registry.isBotThread(resolved.threadId) ? {} : { instructions: mousseOrchestrationInstructions() }) }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // For the thread's ceiling, not the turn's mode; the call-time check refuses a tool the list left out in any case.
      // A bot's thread tools follow the run the credential acts for now (`ToolListing.botTurnTools`).
      const current = credentials.current(resolved.tokenHash) ?? resolved
      const compact = (this.options.compactToolSchemas ?? isCompactSchemaProvider)(current.provider)
      return {
        tools: registry.listForThread(resolved.threadId, 'default', current.runId).map((tool) => listedTool(tool, { compact }))
      }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { clientRequestId, ...args } = (request.params.arguments ?? {}) as Record<string, unknown>
      const toolCallId = typeof clientRequestId === 'string' && clientRequestId.trim()
        ? `mcp:${clientRequestId.trim()}`
        : `mcp:${randomUUID()}`
      const signal = AbortSignal.any([requestSignal, extra.signal])
      return this.tracked(resolved, async (authority) => {
        // A call that is not the run's own (a native helper's, or one nothing ties to the run while a helper may be
        // running) holds the run's delegable authority only, and never takes the run's notices with its result.
        const helper = await this.attributed(authority.threadId, request.params._meta)
        const outcome = await registry.call(request.params.name, args, { credential: authority, toolCallId, signal, ...(helper ? { helper } : {}) })
        return helper ? outcome : this.withBoundaryNotices(outcome, authority, signal, handedOver)
      })
    })
    return server
  }

  /** The call's attribution when it is not the run's own; undefined for the run's own call. A failed check fails closed. */
  private async attributed(threadId: string, meta: unknown): Promise<Exclude<CallAttribution, { kind: 'host' }> | undefined> {
    const attribute = this.options.attribute
    if (!attribute) return undefined
    try {
      const attribution = await attribute(threadId, meta)
      return attribution.kind === 'host' ? undefined : attribution
    } catch (error) {
      console.warn('a Mousse tool call could not be attributed; it holds delegable authority only', { threadId, error: error instanceof Error ? error.message : String(error) })
      return { kind: 'unattributed' }
    }
  }
  /**
   * A `mousse` tool's outcome, followed by the caller's pending notices as a separate text block when its runtime has
   * no native steer (`McpToolBoundary`). Never inside the tool's own text, and never for a call whose request is gone.
   */
  private withBoundaryNotices(outcome: ToolOutcome, authority: McpCredentialAuthority, signal: AbortSignal, handedOver: Array<() => void>): McpOutcome {
    const boundary = this.options.boundary
    if (!boundary || signal.aborted) return outcome
    let delivered: ReturnType<McpToolBoundary['deliver']>
    try {
      delivered = boundary.deliver({ threadId: authority.threadId, runId: authority.runId })
    } catch (error) {
      console.warn('notices could not be handed over with a tool result', { threadId: authority.threadId, error: error instanceof Error ? error.message : String(error) })
      return outcome
    }
    if (!delivered) return outcome
    handedOver.push(delivered.release)
    return { ...outcome, notices: `${BOUNDARY_NOTICE_HEADER}\n\n${delivered.text}` }
  }

  /**
   * One SDK server per relay request (`mousse-relay`, SPEC §15.5): the catalogue's listing for the
   * credential's thread (never a connection to a server inside the request), and calls under the same
   * tracking as Mousse's own, so a drained turn counts them. A relayed tool's arguments are its
   * server's, so `clientRequestId` is passed through.
   */
  private relayServer(relay: RelayHandler, resolved: CredentialRecord, requestSignal: AbortSignal): Server {
    const server = new Server(
      { name: 'mousse-relay', version: mousseVersion() },
      { capabilities: { tools: {} }, instructions: relay.forBot(resolved) ? RELAY_BOT_INSTRUCTIONS : RELAY_INSTRUCTIONS }
    )
    const { credentials } = this.options
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: relay.list(credentials.current(resolved.tokenHash) ?? resolved).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, object> }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.tracked(resolved, (authority) =>
        relay.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, {
          credential: authority,
          toolCallId: `mcp:${randomUUID()}`,
          signal: AbortSignal.any([requestSignal, extra.signal])
        })
      )
    )
    return server
  }

  /**
   * Runs one tool call under the credential as it stands for it (the run it is bound to now, its
   * ceiling and relay grant), counted as received and running for the drained-turn check; a
   * refusal becomes an error result in the refusal shape, and a fault a JSON-RPC error.
   */
  private async tracked(resolved: CredentialRecord, run: (authority: McpCredentialAuthority) => Promise<McpOutcome>) {
    const { credentials } = this.options
    const record = credentials.current(resolved.tokenHash) ?? resolved
    credentials.callReceived(record.tokenHash, record.runId)
    credentials.callRunning(record.tokenHash, record.runId, 1)
    const authority: McpCredentialAuthority = {
      threadId: record.threadId,
      runId: record.runId,
      provider: record.provider,
      modeCeiling: record.modeCeiling,
      accessLevel: record.accessLevel,
      binding: record.binding,
      ...(record.relay ? { relay: record.relay } : {}),
      current: () => credentials.isCurrent(record)
    }
    try {
      return toolContent(await run(authority))
    } catch (error) {
      // A refusal is an error result in the refusal shape; only a fault (the credential's turn is over, no such tool)
      // is a JSON-RPC error.
      const refused = refusalOutcome(error)
      if (refused) return toolContent(refused)
      if (error instanceof McpToolError)
        throw Object.assign(new Error(error.message), { code: MCP_ERROR_CODES[error.code as keyof typeof MCP_ERROR_CODES], data: { ...error.details, reason: error.code } })
      throw error
    } finally {
      credentials.callRunning(record.tokenHash, record.runId, -1)
    }
  }

  private track(threadId: string, controller: AbortController): void {
    const set = this.inFlight.get(threadId) ?? new Set<AbortController>()
    set.add(controller)
    this.inFlight.set(threadId, set)
  }

  private untrack(threadId: string, controller: AbortController): void {
    const set = this.inFlight.get(threadId)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) this.inFlight.delete(threadId)
  }
}

/** A tool's outcome and the notices handed over with it (`McpToolBoundary`). */
type McpOutcome = ToolOutcome & { notices?: string }

/** A tool outcome as MCP content: its text, then its images, then any notices handed over with it as a block of their own. */
function toolContent(outcome: McpOutcome) {
  return {
    content: [
      { type: 'text' as const, text: outcome.text },
      ...(outcome.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
      ...(outcome.notices ? [{ type: 'text' as const, text: outcome.notices }] : [])
    ],
    ...(outcome.isError ? { isError: true } : {})
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
