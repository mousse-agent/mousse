import type { CursorHostTransport } from '../../harness/cursor/hostClient'
import { ReplayMismatchError, type ReplayTransport } from './ReplayTransport'

/**
 * Cursor host boundary: the NDJSON protocol between the Cursor driver and its host process
 * (`harness/hosts/cursorProtocol.ts`), replayed in place of the host. The real driver, session
 * lifecycle and gateway run; only the host process is replaced.
 *
 * - out `{ kind: 'request', method, params }`: a call to the host. `cwd` and `storeDir` are dropped
 *   from params (per-run temp paths).
 * - in `{ kind: 'reply', method, result }` / `{ kind: 'error', method, error }`: the oldest pending
 *   call of `method` settles.
 * - in `{ kind: 'delta', runId, update }` / `{ kind: 'run_end', runId, status, … }`: run events.
 * - in `{ kind: 'exit', detail? }`: the host process ends (a crash); the next call starts a new one.
 */
export const CURSOR_HOST_BOUNDARY = 'Cursor host NDJSON on the host process: requests out; replies, run updates and exits in'

type CursorInbound =
  | { kind: 'reply'; method: string; result: unknown }
  | { kind: 'error'; method: string; error: Record<string, unknown> }
  | { kind: 'delta'; runId: string; update: unknown }
  | { kind: 'run_end'; runId: string; status: string; [key: string]: unknown }
  | { kind: 'exit'; detail?: string }

interface ReplayHost {
  lines: Array<(line: string) => void>
  exits: Array<(detail?: string) => void>
  pending: Array<{ id: number; method: string }>
  dead: boolean
}

function withoutLocalPaths(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const { cwd: _cwd, storeDir: _storeDir, ...rest } = params as Record<string, unknown>
  return rest
}

/** A connect function for the Cursor driver: each call is a fresh host on the same transcript. */
export function replayCursorHost(transport: ReplayTransport): () => CursorHostTransport {
  let current: ReplayHost | undefined
  /**
   * Readers delivering inbound frames. A cue (stop, steer) holds its reader until the user's action
   * settles, and that action may wait for frames that follow the cue (a cancel's reply): a second
   * reader delivers them meanwhile, as the other replays' per-request readers do.
   */
  let pumps = 0

  const exit = (host: ReplayHost, detail?: string) => {
    if (host.dead) return
    host.dead = true
    if (current === host) current = undefined
    for (const listener of host.exits) listener(detail)
  }

  const deliver = (frame: CursorInbound) => {
    const host = current
    if (frame.kind === 'exit') {
      if (host) exit(host, frame.detail ?? 'replayed crash')
      return
    }
    if (!host) throw new ReplayMismatchError(`Inbound ${frame.kind} frame with no host running`)
    const emit = (message: unknown) => {
      for (const listener of host.lines) listener(JSON.stringify(message))
    }
    if (frame.kind === 'reply' || frame.kind === 'error') {
      const index = host.pending.findIndex((entry) => entry.method === frame.method)
      if (index < 0) throw new ReplayMismatchError(`A ${frame.method} ${frame.kind} with no pending ${frame.method} call`)
      const [{ id }] = host.pending.splice(index, 1)
      emit(frame.kind === 'reply' ? { id, result: frame.result } : { id, error: frame.error })
    } else if (frame.kind === 'delta') emit({ event: 'delta', runId: frame.runId, update: frame.update })
    else if (frame.kind === 'run_end') {
      const { kind: _kind, ...end } = frame
      emit({ event: 'run_end', ...end })
    } else throw new ReplayMismatchError(`Unknown inbound frame ${JSON.stringify(frame)}`)
  }

  const pump = async () => {
    if (pumps >= 2) return
    pumps += 1
    try {
      for (;;) {
        const frame = (await transport.receive()) as CursorInbound | undefined
        if (!frame) return
        // Delivered the moment it is read: frames reach the driver in transcript order, also with
        // two readers.
        deliver(frame)
      }
    } catch {
      // The transport records the failure; `assertDone` reports it.
    } finally {
      pumps -= 1
    }
  }

  return () => {
    const host: ReplayHost = { lines: [], exits: [], pending: [], dead: false }
    current = host
    return {
      write: (line) => {
        if (host.dead) return
        const request = JSON.parse(line) as { id: number; method: string; params: unknown }
        host.pending.push({ id: request.id, method: request.method })
        void transport.sendInOrder({ kind: 'request', method: request.method, params: withoutLocalPaths(request.params) }).then(() => void pump(), () => undefined)
      },
      onLine: (listener) => void host.lines.push(listener),
      onExit: (listener) => void host.exits.push(listener),
      kill: () => exit(host, 'killed')
    }
  }
}
