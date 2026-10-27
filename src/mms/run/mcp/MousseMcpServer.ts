import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mousseVersion } from '../../appVersion'
import { McpToolError, type McpCredentialAuthority, type McpToolErrorCode, type ToolOutcome, type ToolRegistry } from './appTools'
import { mousseOrchestrationInstructions } from './instructions'
import type { BearerTurn, CredentialRecord, McpCredentials, TurnSettlement } from './McpCredentials'

/** Where a provider runtime reaches the server, and the bearer token of one thread's turn. */
export interface McpAttachment {
  url: string
  token: string
}

/**
 * What the harness gateway needs to give a turn its bridge (PR 2 §2 `TurnBridge`): a bearer for the
 * turn under the driver's turn binding, the turn's end (the drained-turn check, then in-flight calls
 * abort), and revocation when a thread is deleted or switches instance.
 */
export interface McpAttachmentProvider {
  bearerForTurn(input: BearerTurn): (McpAttachment & { tokenHash: string }) | null
  turnEnded(input: { threadId: string; runId: string; tokenHash?: string; settlement: TurnSettlement }): 'kept' | 'rotated' | undefined
  revokeThread(threadId: string): void
}

/** JSON-RPC error codes the server uses (implementation-defined range). */
export const MCP_ERROR_CODES: Record<McpToolErrorCode | 'mousse_unauthorized', number> = {
  mousse_unauthorized: -32001,
  mousse_caller_not_live: -32002,
  mousse_scope_denied: -32003,
  mousse_ceiling_exceeded: -32004,
  mousse_read_only: -32005,
  mousse_conflict: -32006,
  mousse_unknown_tool: -32601
}

const MCP_PATH = '/mcp'
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

  get running(): boolean {
    return this.http !== null
  }

  async start(): Promise<void> {
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
  bearerForTurn(input: BearerTurn): (McpAttachment & { tokenHash: string }) | null {
    if (!this.http) return null
    const { token, tokenHash } = this.options.credentials.bearerForTurn(input)
    return { url: this.url, token, tokenHash }
  }

  /**
   * The thread's turn ended: whether its bearer is kept for the next turn is settled first (a call
   * still running counts against a drained turn), then its in-flight tool calls abort (a blocked
   * `ask_user`).
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
    if (path !== MCP_PATH) {
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
    const server = this.mcpServer(credential, request.signal)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => {
      request.abort(new Error('The MCP request closed'))
      this.untrack(credential.threadId, request)
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** One SDK server per request, bound to the credential the request's token resolved to. */
  private mcpServer(resolved: CredentialRecord, requestSignal: AbortSignal): Server {
    const server = new Server(
      { name: 'mousse', version: mousseVersion() },
      { capabilities: { tools: {} }, instructions: mousseOrchestrationInstructions() }
    )
    const { registry, credentials } = this.options
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // For the thread's ceiling, not the turn's mode, and for the credential's agent access level as it
      // is now. A runtime that caches the list gets a new bearer when the level changes (the level is part
      // of the runtime generation), and the call-time check refuses a tool the list left out in any case.
      tools: registry.listForThread(resolved.threadId, 'default', (credentials.current(resolved.tokenHash) ?? resolved).accessLevel).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, object> }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { clientRequestId, ...args } = (request.params.arguments ?? {}) as Record<string, unknown>
      const toolCallId = typeof clientRequestId === 'string' && clientRequestId.trim()
        ? `mcp:${clientRequestId.trim()}`
        : `mcp:${randomUUID()}`
      // The credential as it stands for this call: the run it is bound to now, and its ceiling.
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
        current: () => credentials.isCurrent(record)
      }
      try {
        const outcome = await registry.call(request.params.name, args, {
          credential: authority,
          toolCallId,
          signal: AbortSignal.any([requestSignal, extra.signal])
        })
        return toolContent(outcome)
      } catch (error) {
        if (error instanceof McpToolError)
          throw Object.assign(new Error(error.message), { code: MCP_ERROR_CODES[error.code], data: { ...error.details, reason: error.code } })
        throw error
      } finally {
        credentials.callRunning(record.tokenHash, record.runId, -1)
      }
    })
    return server
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

/** A tool outcome as MCP content: its text, then its images. */
function toolContent(outcome: ToolOutcome) {
  return {
    content: [
      { type: 'text' as const, text: outcome.text },
      ...(outcome.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
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
