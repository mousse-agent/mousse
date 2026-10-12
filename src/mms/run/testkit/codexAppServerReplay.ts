import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CodexLaunch, CodexProcess } from '../../providers/codex/CodexAppServerClient'
import type { ReplayTransport } from './ReplayTransport'

/**
 * Codex app-server boundary: the JSON-RPC lines on the process's stdio, replayed in place of the
 * spawned `codex app-server` (the `launch` dependency of `CodexProviderService`). The real client
 * frames and parses every line, so the replay covers the wire format too.
 *
 * - out: a message the client wrote (request, notification, or its answer to a server request),
 *   parsed. `cwd` is dropped from `params` (it is a per-run temp path).
 * - in: a message the server writes (response, notification, or server request), written to
 *   stdout as one line.
 * - in `{ kind: 'exit', code }`: the process exits (crash mid-turn).
 * - in `{ kind: 'stdout', line }`: a raw stdout line, for malformed output.
 *
 * Inbound frames are pumped as soon as the client has sent the outbound frames before them; the
 * pump stops at the end of the transcript and resumes when the client writes again.
 */
export const CODEX_APP_SERVER_BOUNDARY =
  'Codex app-server JSON-RPC on stdio: client messages out; server responses, notifications and requests in'

function withoutCwd(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message
  const { params } = message as { params?: unknown }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return message
  const { cwd: _cwd, ...rest } = params as Record<string, unknown>
  return { ...(message as Record<string, unknown>), params: rest }
}

class ReplayCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private pumping = false
  private pending = ''

  constructor(private readonly transport: ReplayTransport) {
    super()
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        this.pending += chunk.toString()
        let end: number
        while ((end = this.pending.indexOf('\n')) !== -1) {
          const line = this.pending.slice(0, end)
          this.pending = this.pending.slice(end + 1)
          if (!line.trim()) continue
          try {
            this.transport.send(withoutCwd(JSON.parse(line)))
          } catch (error) {
            done(error as Error)
            return
          }
        }
        this.pump()
        done()
      }
    })
  }

  private get exited(): boolean {
    return this.exitCode !== null || this.signalCode !== null
  }

  private pump(): void {
    if (this.pumping || this.exited) return
    this.pumping = true
    void (async () => {
      try {
        for (;;) {
          const frame = await this.transport.receive()
          if (frame === undefined || this.exited) return
          const control = frame as { kind?: unknown; code?: unknown; line?: unknown }
          if (control.kind === 'exit') {
            this.exit(typeof control.code === 'number' ? control.code : 1, null)
            return
          }
          this.stdout.write((control.kind === 'stdout' ? String(control.line) : JSON.stringify(frame)) + '\n')
        }
      } catch {
        /* the transport keeps the first mismatch; the scenario asserts it */
      } finally {
        this.pumping = false
      }
    })()
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exitCode = code
    this.signalCode = signal
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false
    this.exit(null, signal)
    return true
  }
}

/** A fresh replayed app-server process per launch. */
export function replayCodexAppServer(transport: ReplayTransport): (launch: CodexLaunch) => CodexProcess {
  return () => new ReplayCodexProcess(transport)
}
