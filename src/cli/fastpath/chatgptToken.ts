import { connect } from 'node:net'

/**
 * `mousse-cli engine chatgpt-token <endpoint> <leaseId>`: the token command a managed Codex runs
 * (`auth.command`). It asks the daemon's token broker for the lease's ChatGPT access token and
 * prints only the token. On failure it prints one line to stderr and exits 1.
 *
 * Codex runs it for every token it needs, so it is dispatched before the CLI loads anything else
 * and imports only Node's `net`. It keeps its own copy of the request format in
 * `src/mms/harness/codex/tokenProtocol.ts`; a test checks that both agree.
 */

const PROTOCOL_VERSION = 1
const LEASE_ID = /^[0-9a-f]{32}$/
const MAX_RESPONSE_BYTES = 64 * 1024
/** Inside Codex's 80 s budget for the command, so a typed failure reaches it before it gives up. */
export const RESPONSE_WAIT_MS = 78_000

export interface ChatgptTokenIo {
  stdout: Pick<NodeJS.WritableStream, 'write'>
  stderr: Pick<NodeJS.WritableStream, 'write'>
}

export function isChatgptTokenArgv(argv: readonly string[]): boolean {
  return argv[0] === 'engine' && argv[1] === 'chatgpt-token'
}

class HelperError extends Error {}

/**
 * Writes `text` and resolves only once the stream has flushed it (the write callback), so the
 * process can exit right after: `write()` returning true means buffer room, not delivery, and an
 * asynchronous stdout pipe would lose the token at `app.exit()`.
 */
function write(stream: Pick<NodeJS.WritableStream, 'write'>, text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write(text, () => resolve())
    } catch {
      resolve()
    }
  })
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, 300)
}

function requestToken(endpoint: string, leaseId: string, waitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    let received = Buffer.alloc(0)
    let settled = false
    const finish = (error: Error | undefined, token?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(token!)
    }
    const timer = setTimeout(() => finish(new HelperError('Mousse did not answer in time with a ChatGPT token.')), waitMs)
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: PROTOCOL_VERSION, leaseId })}\n`))
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end < 0) {
        if (received.length > MAX_RESPONSE_BYTES) finish(new HelperError('Mousse sent a token answer that is too large.'))
        return
      }
      let value: unknown
      try {
        value = JSON.parse(received.subarray(0, end).toString('utf8'))
      } catch {
        finish(new HelperError('Mousse sent a token answer Codex cannot read.'))
        return
      }
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      if (typeof record.token === 'string' && /^[\x21-\x7e]+$/.test(record.token)) finish(undefined, record.token)
      else if (typeof record.error === 'string' && record.error.trim()) finish(new HelperError(oneLine(record.error)))
      else finish(new HelperError('Mousse sent a token answer Codex cannot read.'))
    })
    socket.once('error', () => finish(new HelperError('Mousse is not running, so Codex cannot get a ChatGPT token. Start Mousse and try again.')))
    socket.once('close', () => finish(new HelperError('Mousse closed the connection before it sent a ChatGPT token.')))
  })
}

/** Runs the command; resolves with the exit code. `argv` is the CLI's own (`engine chatgpt-token …`). */
export async function runChatgptToken(
  argv: readonly string[],
  io: ChatgptTokenIo = { stdout: process.stdout, stderr: process.stderr },
  options: { waitMs?: number } = {}
): Promise<number> {
  const [, , endpoint, leaseId, ...rest] = argv
  try {
    if (!isChatgptTokenArgv(argv) || !endpoint || !leaseId || rest.length || !LEASE_ID.test(leaseId))
      throw new HelperError('Usage: mousse-cli engine chatgpt-token <endpoint> <leaseId>')
    const token = await requestToken(endpoint, leaseId, options.waitMs ?? RESPONSE_WAIT_MS)
    // Only the bare token: Codex reads the whole of stdout as the bearer.
    await write(io.stdout, token)
    return 0
  } catch (error) {
    const message = error instanceof HelperError ? error.message : 'Codex could not get a ChatGPT token from Mousse.'
    await write(io.stderr, `${message}\n`)
    return 1
  }
}
