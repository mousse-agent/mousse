import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { PiRpcDriverOptions } from '../../harness/drivers/pi/engines/rpc'
import type { PiBridgeAddress, PiGateResponse, PiReadyRequest, PiTurnResponse } from '../../harness/pi/extension/protocol'
import type { PiLaunch, PiRuntimePaths } from '../../harness/pi/launch'
import type { ReplayTransport } from './ReplayTransport'

/**
 * Pi RPC boundary: the JSON lines on a Pi process's stdio (`--mode rpc`), replayed in place of Pi's
 * agent. The engine spawns a real process (`piRpcRelay.cjs`) through its real launcher, RPC client
 * and process tree, so Stop, kill and the warm period run for real; the relay pipes its stdio to
 * this replay over a local socket and hands over the bridge address and environment the engine gave
 * it. The relay reaches nothing but this replay; the replay reaches only the engine's bridge, both
 * on 127.0.0.1.
 *
 * - out `{ kind: 'command', command }`: a command the engine sent, without its `id`. The startup
 *   handshake, the context gauge and the turn's leaf (`get_available_models`, `get_state`,
 *   `get_session_stats`, `get_entries`) are answered without a frame; every other command is answered `success` at once, as Pi
 *   acknowledges it (`clear_queue` with the steers the replay has not seen taken yet).
 * - in: a Pi RPC event (`{ type, ... }`), written to the process's stdout as one line; the next
 *   scenario runner awaits `flush()` before a cue, so the cue acts on what the engine read.
 * - in `{ kind: 'turn' }`: as the extension's `before_agent_start`, the replay fetches `/pi/turn`
 *   and sends out `{ kind: 'turn', activeBuiltins, tools }` (tool names).
 * - in `{ kind: 'gate', toolName, toolCallId, input }`: as the extension's `tool_call`, the replay
 *   asks `/pi/gate` with the turn's attempt token and sends out `{ kind: 'gate', toolName, allow }`.
 * - in `{ kind: 'exit', code }`: the process exits (a crash).
 *
 * Inbound frames go to the process that sent the last outbound frame.
 */
export const PI_RPC_BOUNDARY = 'Pi RPC on stdio: commands out (without ids); events in'

const RELAY = join(__dirname, 'piRpcRelay.cjs')

/** What a relay saw at start: the launcher's environment and arguments, as Pi would. */
export interface PiRpcRelayStart {
  bridge: PiBridgeAddress | null
  aws: PiReadyRequest['aws']
  offline: string | null
  /** Pi's arguments after its entry (`--provider`, `--no-extensions`, ...). */
  args: string[]
}

interface RelayConnection {
  socket: Socket
  start: PiRpcRelayStart
  sessionId: string
  /** Steers sent and not yet taken (a user `message_start` naming them). */
  steers: string[]
  attemptToken: string
  leaves: number
  /** Inbound lines written and not yet acknowledged, by sequence number. */
  acks: Map<number, () => void>
}

export interface PiRpcReplayOptions {
  /** Provider ids the stand-in extension reports guarded (default: none; the replay offers no model). */
  guarded?: string[]
}

export interface PiRpcReplay {
  /** The driver's `rpc` options: the runtime, and the launch with Pi's entry replaced by the relay. */
  driverOptions(overrides?: Partial<PiRpcDriverOptions>): PiRpcDriverOptions
  /** What each relay saw at start, in start order. */
  readonly starts: PiRpcRelayStart[]
  /**
   * Resolves once every event written so far reached Pi's stdout and the engine had a turn to read
   * it. The scenario runner awaits it before a cue, so Stop and steer act on what the engine saw.
   */
  flush(): Promise<void>
  close(): Promise<void>
}

async function post<T>(bridge: PiBridgeAddress, name: string, body: unknown): Promise<T> {
  const response = await fetch(`${bridge.url}/pi/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

function withoutId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command
  return rest
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: { type?: string; text?: string }) => (block?.type === 'text' ? block.text ?? '' : '')).join('')
}

/** A replay of Pi's RPC mode; one relay process per thread, as the engine starts them. */
export async function replayPiRpc(transport: ReplayTransport, options: PiRpcReplayOptions = {}): Promise<PiRpcReplay> {
  const connections = new Set<RelayConnection>()
  const starts: PiRpcRelayStart[] = []
  let current: RelayConnection | undefined
  let sessions = 0
  let sequence = 0
  let pumping = false

  const write = (connection: RelayConnection, line: string): void => {
    if (!connection.socket.destroyed) connection.socket.write(`${line}\n`)
  }

  /** Events written and not yet acknowledged by their relay. */
  const unacked = new Set<Promise<void>>()

  /** Writes an inbound line; the relay acknowledges it once it is on Pi's stdout (`flush`). */
  const deliver = (connection: RelayConnection, line: string): void => {
    if (connection.socket.destroyed) return
    const seq = ++sequence
    const acked = new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        connection.acks.delete(seq)
        resolve()
      }
      const timer = setTimeout(done, 2_000)
      connection.acks.set(seq, done)
    })
    unacked.add(acked)
    void acked.then(() => unacked.delete(acked))
    write(connection, `\u0000${seq}\u0000${line}`)
  }

  const respond = (connection: RelayConnection, id: unknown, command: string, data?: unknown): void =>
    write(connection, JSON.stringify({ type: 'response', ...(id === undefined ? {} : { id }), command, success: true, ...(data === undefined ? {} : { data }) }))

  const pump = (): void => {
    if (pumping) return
    pumping = true
    void (async () => {
      try {
        for (;;) {
          const frame = (await transport.receive()) as Record<string, unknown> | undefined
          if (frame === undefined) return
          const connection = current
          if (!connection) continue
          switch (frame.kind) {
            case 'exit':
              write(connection, `\u0000exit:${typeof frame.code === 'number' ? frame.code : 1}`)
              break
            case 'turn': {
              if (!connection.start.bridge) throw new Error('The relay reported no bridge')
              const turn = await post<PiTurnResponse>(connection.start.bridge, 'turn', {})
              connection.attemptToken = turn.attemptToken
              transport.send({ kind: 'turn', activeBuiltins: turn.activeBuiltins, tools: turn.tools.map((tool) => tool.name) })
              break
            }
            case 'gate': {
              if (!connection.start.bridge) throw new Error('The relay reported no bridge')
              const decision = await post<PiGateResponse>(connection.start.bridge, 'gate', {
                attemptToken: connection.attemptToken,
                toolCallId: frame.toolCallId,
                toolName: frame.toolName,
                input: frame.input ?? {}
              })
              transport.send({ kind: 'gate', toolName: frame.toolName, allow: decision.allow })
              break
            }
            default: {
              const message = frame.message as { role?: string } | undefined
              if (frame.type === 'message_start' && message?.role === 'user') {
                const text = textOf(message)
                connection.steers = connection.steers.filter((steer) => !text.includes(steer))
              }
              deliver(connection, JSON.stringify(frame))
            }
          }
        }
      } catch {
        // The transport keeps the first mismatch; the scenario asserts it.
      } finally {
        pumping = false
      }
    })()
  }

  const command = (connection: RelayConnection, raw: Record<string, unknown>): void => {
    const type = String(raw.type)
    switch (type) {
      case 'get_available_models':
        return respond(connection, raw.id, type, { models: [] })
      case 'get_state':
        return respond(connection, raw.id, type, { sessionId: connection.sessionId })
      case 'get_session_stats':
        return respond(connection, raw.id, type, {})
      case 'get_entries':
        // The session's leaf after a turn (the engine keeps it as a fork point).
        return respond(connection, raw.id, type, { entries: [], leafId: `${connection.sessionId}-leaf-${++connection.leaves}` })
    }
    current = connection
    try {
      transport.send({ kind: 'command', command: withoutId(raw) })
    } catch {
      // The mismatch is kept on the transport; Pi answers nothing, as a broken process would.
      return
    }
    if (type === 'steer') connection.steers.push(String(raw.message))
    if (type === 'clear_queue') respond(connection, raw.id, type, { steering: connection.steers.splice(0), followUp: [] })
    else if (type !== 'extension_ui_response') respond(connection, raw.id, type)
    pump()
  }

  const server: Server = createServer((socket) => {
    let buffer = ''
    let connection: RelayConnection | undefined
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => {
      if (!connection) return
      connections.delete(connection)
      for (const done of [...connection.acks.values()]) done()
      if (current === connection) current = undefined
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (!connection) {
          // The handshake: the bridge, as the extension reads it at load, then its ready report.
          const hello = parsed as { bridge: string | null; aws: PiReadyRequest['aws']; offline: string | null; args: string[] }
          const start: PiRpcRelayStart = { bridge: hello.bridge ? (JSON.parse(hello.bridge) as PiBridgeAddress) : null, aws: hello.aws, offline: hello.offline, args: hello.args }
          sessions += 1
          connection = { socket, start, sessionId: `replay-session-${sessions}`, steers: [], attemptToken: '', leaves: 0, acks: new Map() }
          connections.add(connection)
          starts.push(start)
          const ready: PiReadyRequest = { guarded: options.guarded ?? [], aws: hello.aws, reason: 'startup' }
          if (start.bridge) void post(start.bridge, 'ready', ready).catch(() => {})
          continue
        }
        if (typeof parsed.ack === 'number' && !('type' in parsed)) {
          connection.acks.get(parsed.ack)?.()
          continue
        }
        command(connection, parsed)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    starts,
    flush: async () => {
      while (unacked.size) await Promise.all([...unacked])
      // The engine reads the relay's stdout on its next turns of the event loop.
      await new Promise((resolve) => setTimeout(resolve, 10))
    },
    driverOptions: (overrides = {}) => ({
      runtime: (): PiRuntimePaths => ({ root: process.cwd(), entry: 'pi-rpc-replay', extension: 'pi-rpc-replay' }),
      catalog: (providerId: string) => ({ revision: 1, provider: { id: providerId, builtin: true, models: [] } }),
      ...overrides,
      engine: {
        readyDeadlineMs: 10_000,
        commandDeadlineMs: 5_000,
        ...overrides.engine,
        // The real launch (environment included), with Pi's entry replaced by the relay.
        adjustLaunch: (launch: Extract<PiLaunch, { runs: 'yes' }>) => ({ ...launch, command: process.execPath, args: [RELAY, String(port), ...launch.args.slice(1)] })
      }
    }),
    close: async () => {
      for (const connection of connections) connection.socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
