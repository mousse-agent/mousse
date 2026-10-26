import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable, type Transform } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse
} from '@agentclientprotocol/sdk'

/**
 * One connection to an ACP agent process, and the factory that makes it. The factory is the
 * process boundary of the ACP core: a preset's factory starts its agent, while tests and replays
 * pass one that answers the protocol in place of a process.
 */

/** The JSON-RPC side of the connection, as the core uses it. */
export type AcpRpc = Pick<ClientConnection, 'signal' | 'close' | 'agent'>

/** The agent process, as far as the core touches it. */
export interface AcpChild {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface AcpConnection {
  child: AcpChild
  connection: AcpRpc
  /** Where the connection's `session/update` notifications go; set by the core. */
  onUpdate?: (update: unknown, sessionId?: string) => void
}

/** Requests the agent sends to Mousse. The fs handlers exist only when Mousse offers client fs. */
export interface AcpClientHandlers {
  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
  readTextFile?(request: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile?(request: WriteTextFileRequest): Promise<WriteTextFileResponse>
  /** `elicitation/create`: a sign-in link (URL mode) during sign-in; anything else is declined. */
  createElicitation?(request: CreateElicitationRequest): Promise<CreateElicitationResponse>
}

/** Why a connection opens. */
export type AcpPurpose = 'turn' | 'sign_in' | 'sign_out' | 'models' | 'handshake'

export interface AcpLaunchRequest {
  purpose: AcpPurpose
  handlers: AcpClientHandlers
  /** A sign-in link the agent announced outside the protocol (on stdout or through a helper). */
  onAuthUrl?: (url: string) => void
  /** The process ended (or the replayed connection closed). */
  onExit?: () => void
}

/** Opens a connection to the agent: a new process, or a replay of one. */
export type AcpConnectionFactory = (request: AcpLaunchRequest) => AcpConnection

/** How a started process is wired to the protocol. */
export interface AcpWiring {
  /** Rewrites stdout before it is parsed as ACP (an agent that prints other lines there). */
  stdout?: Transform
  /** Each complete stderr line, trailing whitespace removed. */
  stderrLine?: (line: string) => void
  onExit?: () => void
}

/**
 * Connects to a started agent process over NDJSON on its stdio and routes the agent's requests to
 * `handlers`. Closing the connection does not end the process: `closeAcpConnection` does both.
 */
export function connectAcpProcess(child: ChildProcessWithoutNullStreams, handlers: AcpClientHandlers, wiring: AcpWiring = {}): AcpConnection {
  const active: AcpConnection = { child, connection: undefined as unknown as AcpRpc }
  const app = acpClientApp(handlers, active)
  const output = wiring.stdout ? child.stdout.pipe(wiring.stdout) : child.stdout
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(output) as ReadableStream<Uint8Array>)
  const connection: ClientConnection = app.connect(stream)
  active.connection = connection
  child.stderr.setEncoding('utf8')
  let stderrPending = ''
  child.stderr.on('data', (chunk: string) => {
    const lines = `${stderrPending}${chunk}`.split('\n')
    stderrPending = lines.pop() ?? ''
    if (stderrPending.length > 20_000) stderrPending = ''
    if (!wiring.stderrLine) return
    for (const raw of lines) wiring.stderrLine(raw.trimEnd())
  })
  child.on('exit', () => {
    connection.close()
    wiring.onExit?.()
  })
  child.on('error', (error) => connection.close(error))
  return active
}

/** Mousse's side of an ACP connection: `handlers` answer the agent; updates go to `active.onUpdate`. */
export function acpClientApp(handlers: AcpClientHandlers, active: Pick<AcpConnection, 'onUpdate'>): ReturnType<typeof client> {
  const app = client({ name: 'Mousse' })
  app.onRequest(methods.client.session.requestPermission, async ({ params }) => handlers.requestPermission(params))
  if (handlers.readTextFile) {
    const read = handlers.readTextFile
    app.onRequest(methods.client.fs.readTextFile, async ({ params }) => read(params))
  }
  if (handlers.writeTextFile) {
    const write = handlers.writeTextFile
    app.onRequest(methods.client.fs.writeTextFile, async ({ params }) => write(params))
  }
  if (handlers.createElicitation) {
    const elicit = handlers.createElicitation
    app.onRequest(methods.client.elicitation.create, async ({ params }) => elicit(params))
  }
  app.onNotification(methods.client.session.update, ({ params }) => active.onUpdate?.(params.update, params.sessionId))
  return app
}

/** Closes the connection and ends the process: a polite signal, then a kill after 3 s. */
export function closeAcpConnection(active: Pick<AcpConnection, 'child' | 'connection'>): void {
  active.connection.close()
  if (active.child.exitCode === null && active.child.signalCode === null) {
    active.child.kill()
    const timer = setTimeout(() => {
      if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill('SIGKILL')
    }, 3_000)
    timer.unref?.()
  }
}
