import type { AcpConnection, AcpConnectionFactory } from '../../harness/acp/connection'
import { ReplayMismatchError, type ReplayTransport } from './ReplayTransport'

/**
 * Agent Client Protocol boundary: the JSON-RPC traffic on the agent connection, replayed in place
 * of the spawned agent process (the ACP core's `AcpConnectionFactory` seam).
 *
 * - out `{ kind: 'request', method, params }` / `{ kind: 'notify', method, params }`: a call to the
 *   agent. `cwd` is dropped from params (it is a per-run temp path).
 * - in `{ kind: 'update', update }`: a `session/update` notification during the current request.
 * - in `{ kind: 'response', result }` / `{ kind: 'error', message }`: the current request settles.
 *
 * Closing the connection (Stop) rejects the pending request, as a dead agent process would.
 */
export const ACP_BOUNDARY = 'ACP JSON-RPC on the agent connection: calls out; session updates and responses in'

type AcpInbound =
  | { kind: 'update'; update: unknown }
  | { kind: 'response'; result: unknown }
  | { kind: 'error'; message: string }

/** The connection a replay hands the ACP core. */
export interface ReplayAcpProcess {
  child: { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: () => boolean }
  connection: {
    signal: AbortSignal
    close: (error?: unknown) => void
    agent: {
      request: (method: string, params: unknown) => Promise<unknown>
      notify: (method: string, params: unknown) => Promise<void>
    }
  }
  onUpdate?: (update: unknown, sessionId?: string) => void
}

function withoutCwd(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const { cwd: _cwd, ...rest } = params as Record<string, unknown>
  return rest
}

/** A fresh replayed agent process per connection the core opens. */
export function replayAcpProcess(transport: ReplayTransport): AcpConnectionFactory {
  return (request) => {
    const abort = new AbortController()
    const closed = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
    })
    closed.catch(() => undefined)
    const process: ReplayAcpProcess = {
      // Already exited: the service's close() never signals a real pid.
      child: { exitCode: 0, signalCode: null, kill: () => true },
      connection: {
        signal: abort.signal,
        close: (error) => {
          if (abort.signal.aborted) return
          abort.abort(error ?? new Error('ACP connection closed'))
          request.onExit?.()
        },
        agent: {
          request: async (method, params) => {
            abort.signal.throwIfAborted()
            transport.send({ kind: 'request', method, params: withoutCwd(params) })
            const settle = async (): Promise<unknown> => {
              for (;;) {
                const frame = (await transport.receive()) as AcpInbound | undefined
                if (abort.signal.aborted) throw abort.signal.reason
                if (!frame) throw new ReplayMismatchError(`Transcript ended before ${method} settled`)
                if (frame.kind === 'update') process.onUpdate?.(frame.update)
                else if (frame.kind === 'response') return frame.result
                else if (frame.kind === 'error') throw new Error(frame.message)
                else throw new ReplayMismatchError(`Unknown inbound frame ${JSON.stringify(frame)}`)
              }
            }
            const settled = settle()
            // A close settles the call first; the abandoned read must not surface as unhandled.
            settled.catch(() => undefined)
            return Promise.race([settled, closed])
          },
          notify: async (method, params) => {
            abort.signal.throwIfAborted()
            transport.send({ kind: 'notify', method, params: withoutCwd(params) })
          }
        }
      }
    }
    // The core calls the typed SDK surface; the replay answers every method the same way.
    return process as unknown as AcpConnection
  }
}
