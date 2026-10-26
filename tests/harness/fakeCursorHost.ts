import type { CursorHostTransport } from '../../src/mms/harness/cursor/hostClient'
import type { CursorHostMessage } from '../../src/mms/harness/hosts/cursorProtocol'

/**
 * A scripted Cursor host for driver tests: each method answers from a handler (or fails with the
 * error it throws), and the test can emit run events or end the host. Every request is recorded.
 */
export type FakeHandler = (params: Record<string, unknown>, host: FakeCursorHost) => unknown

export class FakeCursorHost {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly transports: CursorHostTransport[] = []
  private lines: Array<(line: string) => void> = []
  private exits: Array<(detail?: string) => void> = []

  constructor(readonly handlers: Record<string, FakeHandler> = {}) {}

  /** The driver's `connect` seam: a new host process each time. */
  connect = (): CursorHostTransport => {
    const lines: Array<(line: string) => void> = []
    const exits: Array<(detail?: string) => void> = []
    this.lines = lines
    this.exits = exits
    let dead = false
    const transport: CursorHostTransport = {
      write: (line) => {
        if (dead) return
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> }
        this.requests.push({ method: request.method, params: request.params })
        const handler = this.handlers[request.method]
        void Promise.resolve()
          .then(() => {
            if (!handler) throw Object.assign(new Error(`no handler for ${request.method}`), { name: 'Unhandled' })
            return handler(request.params, this)
          })
          .then(
            (result) => !dead && this.send({ id: request.id, result: result ?? {} }, lines),
            (error: Error & { activeRun?: boolean; auth?: boolean }) => !dead && this.send({ id: request.id, error: { message: error.message, name: error.name, ...(error.activeRun ? { activeRun: true } : {}), ...(error.auth ? { auth: true } : {}) } }, lines)
          )
      },
      onLine: (listener) => void lines.push(listener),
      onExit: (listener) => void exits.push(listener),
      kill: () => {
        if (dead) return
        dead = true
        for (const exit of exits) exit('killed')
      }
    }
    this.transports.push(transport)
    return transport
  }

  private send(message: CursorHostMessage, lines = this.lines): void {
    for (const listener of lines) listener(JSON.stringify(message))
  }

  /** A run event, as the host would write it. */
  emit(message: CursorHostMessage): void {
    this.send(message)
  }

  /** The current host process ends on its own (a crash). */
  crash(): void {
    this.transports.at(-1)?.kill()
  }

  calls(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((entry) => entry.method === method).map((entry) => entry.params)
  }
}

/** An SDK error the host reports. */
export function hostFailure(message: string, extra: { activeRun?: boolean; auth?: boolean; name?: string } = {}): Error {
  return Object.assign(new Error(message), { name: extra.name ?? 'CursorSdkError', ...extra })
}
