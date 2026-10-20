import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/** Path prefix the Mousse ID approval page accepts for loopback callbacks. */
export const MOUSSE_ID_CALLBACK_PATH = '/mousse-id/callback/'
const LIFETIME_MS = 15 * 60_000

export type MousseIdCallbackResult = 'approved' | 'denied' | 'cancelled' | 'expired'

interface Listener {
  server: Server
  timer: NodeJS.Timeout
  result: Promise<MousseIdCallbackResult>
  settle: (result: MousseIdCallbackResult) => void
}

const page = (approved: boolean) => `<!doctype html><meta charset="utf-8"><title>Mousse ID</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee}main{text-align:center}p{color:#aaa}</style>
<main><h1>${approved ? 'Signed in to Mousse' : 'Sign-in denied'}</h1><p>You can close this tab and return to Mousse.</p></main>`

/**
 * One-shot loopback listeners (RFC 8252) that let the browser tell the app a
 * Mousse ID sign-in was decided. The callback carries no secret: the app still
 * finishes the sign-in with its own poll token and PKCE verifier, so a stray
 * request can only make it check sooner.
 */
export class MousseIdCallbacks {
  private readonly listeners = new Map<string, Listener>()
  /** Decisions that arrived before anyone waited, read once. */
  private readonly settled = new Map<string, MousseIdCallbackResult>()

  constructor(private readonly onDecided: () => void = () => undefined) {}

  async start(): Promise<{ id: string; url: string }> {
    const id = randomBytes(24).toString('base64url')
    let settle!: (result: MousseIdCallbackResult) => void
    const result = new Promise<MousseIdCallbackResult>((resolve) => { settle = resolve })
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== MOUSSE_ID_CALLBACK_PATH + id) {
        response.writeHead(404).end()
        return
      }
      const approved = url.searchParams.get('status') === 'approved'
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
        connection: 'close'
      }).end(page(approved))
      this.finish(id, approved ? 'approved' : 'denied')
      this.onDecided()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Mousse ID callback listener has no port')
    }
    const timer = setTimeout(() => this.finish(id, 'expired'), LIFETIME_MS)
    timer.unref()
    this.listeners.set(id, { server, timer, result, settle })
    return { id, url: `http://127.0.0.1:${address.port}${MOUSSE_ID_CALLBACK_PATH}${id}` }
  }

  /** Resolves when the browser reports a decision, or the listener is cancelled or expires. */
  wait(id: string): Promise<MousseIdCallbackResult> {
    const listener = this.listeners.get(id)
    if (listener) return listener.result
    const result = this.settled.get(id) ?? 'cancelled'
    this.settled.delete(id)
    return Promise.resolve(result)
  }

  cancel(id: string): void {
    this.finish(id, 'cancelled')
    this.settled.delete(id)
  }

  dispose(): void {
    for (const id of [...this.listeners.keys()]) this.finish(id, 'cancelled')
    this.settled.clear()
  }

  private finish(id: string, result: MousseIdCallbackResult): void {
    const listener = this.listeners.get(id)
    if (!listener) return
    this.listeners.delete(id)
    clearTimeout(listener.timer)
    listener.settle(result)
    if (result === 'approved' || result === 'denied') this.settled.set(id, result)
    // Stops accepting; the answered request still flushes and idle sockets close.
    listener.server.close()
  }
}

/**
 * Runtime `MOUSSE_ID_ORIGIN` (or the older `MOUSSE_PLUS_ORIGIN`) for the Mousse ID
 * service. Empty when unset, so the renderer falls back to the build default.
 */
export function runtimeMousseIdOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MOUSSE_ID_ORIGIN || env.MOUSSE_PLUS_ORIGIN || '').trim()
}
