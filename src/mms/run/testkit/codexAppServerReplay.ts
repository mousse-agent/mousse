import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { CodexLaunch, CodexProcess } from '../../harness/vendors/codex/CodexAppServerClient'
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

/** A synthetic token with the workspace claim Codex reports in a ChatGPT access token. */
export function codexFixtureAccessToken(workspace?: string, signature = 'fixture'): string {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: workspace } }
  return 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + signature
}

const REPLAY_WORKSPACE = 'replay-workspace'
const REPLAY_TOKEN = codexFixtureAccessToken(REPLAY_WORKSPACE)

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
  private syntheticRequests = 0
  private readonly requestIds = new Map<number, number>()
  private accountRequest?: number
  private accountResult?: unknown

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
            this.send(JSON.parse(line))
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

  private send(message: { id?: unknown; method?: unknown; params?: { includeLayers?: boolean } }): void {
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      // Answer extra credential checks for file-backed replays while preserving checks already recorded.
      const expected = this.transport.expectedOutbound as { method?: unknown } | undefined
      if (message.method !== expected?.method) {
        if (message.method === 'config/read' && !message.params?.includeLayers)
          return this.replyToCredentialCheck(message.id, { config: { cli_auth_credentials_store: 'file' } })
        if (message.method === 'getAuthStatus')
          return this.replyToCredentialCheck(message.id, { authMethod: 'chatgpt', authToken: REPLAY_TOKEN })
        if (message.method === 'account/read' && this.accountResult !== undefined)
          return this.replyToCredentialCheck(message.id, this.accountResult)
      }
      const replayId = message.id - this.syntheticRequests
      this.requestIds.set(replayId, message.id)
      message.id = replayId
      if (message.method === 'account/read') this.accountRequest = replayId
    }
    this.transport.send(withoutCwd(message))
  }

  private replyToCredentialCheck(id: number, result: unknown): void {
    this.syntheticRequests += 1
    this.stdout.write(JSON.stringify({ id, result }) + '\n')
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
          const frame = await this.transport.receive((outbound) => (outbound as { method?: unknown } | null)?.method === 'initialize')
          if (frame === undefined || this.exited) return
          const control = frame as { kind?: unknown; code?: unknown; line?: unknown; id?: unknown; method?: unknown; result?: unknown }
          if (control.kind === 'exit') {
            this.exit(typeof control.code === 'number' ? control.code : 1, null)
            return
          }
          let response = frame
          if (typeof control.id === 'number' && control.method === undefined) {
            const id = this.requestIds.get(control.id)
            if (id !== undefined) {
              this.requestIds.delete(control.id)
              let result = control.result
              if (control.id === this.accountRequest) {
                const reading = result as { account?: { type?: string } | null; workspaceRouting?: unknown } | undefined
                // Older recordings predate workspace routing. The replay's file and bearer use this workspace.
                if (reading?.account?.type === 'chatgpt' && reading.workspaceRouting === undefined)
                  result = { ...reading, workspaceRouting: { chatgptAccountId: REPLAY_WORKSPACE } }
                this.accountResult = result
              }
              response = { ...control, id, ...(result === undefined ? {} : { result }) }
            }
          }
          this.stdout.write((control.kind === 'stdout' ? String(control.line) : JSON.stringify(response)) + '\n')
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

/** Give the replay a file-backed sign-in in its disposable home before the service snapshots it. */
export function replayCodexEnv(home: string): () => NodeJS.ProcessEnv {
  writeFileSync(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: REPLAY_WORKSPACE, access_token: REPLAY_TOKEN }
  }))
  return () => ({ CODEX_HOME: home })
}

/** A fresh replayed app-server process per launch. */
export function replayCodexAppServer(transport: ReplayTransport): (launch: CodexLaunch) => CodexProcess {
  return () => new ReplayCodexProcess(transport)
}
