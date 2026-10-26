// Adapted from T3 Code (MIT, © 2026 T3 Tools Inc.): the unhandled-rejection guard
// (`CursorSdk.ts`), transport-failure detection (`transportFailure.ts`) and the run lifecycle
// around `agent.send` (`CursorAgentSdk.ts`). See THIRD_PARTY_NOTICES.md.
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type * as CursorSdk from '@cursor/sdk'
import {
  isCursorAuthFailure,
  redactCursorText,
  type CursorAgentSetup,
  type CursorHostError,
  type CursorHostMessage,
  type CursorHostMethod,
  type CursorHostMethods,
  type CursorHostRequest,
  type CursorLocal,
  type CursorUsage
} from './cursorProtocol'

/**
 * The Cursor host: one process per Cursor instance, started by the Cursor driver with
 * `ELECTRON_RUN_AS_NODE=1`. It is the only code that loads `@cursor/sdk`, because the SDK keeps
 * process-wide state (its sandbox-support cache, module defaults), leaves rejections nobody awaits
 * and keeps store handles open: a failure here ends one instance's host, never the daemon.
 *
 * It speaks NDJSON on stdin/stdout (`cursorProtocol.ts`). Every call carries the instance's key
 * explicitly and runs with the SDK's own retries off, so the SDK never falls back to
 * `CURSOR_API_KEY` or `~/.cursor/sdk/auth.json`, and a transport failure fails the turn once.
 */

type Sdk = typeof CursorSdk

const out = process.stdout

function send(message: CursorHostMessage): void {
  out.write(`${JSON.stringify(message)}\n`)
}

/** The SDK loaded beside the app's own `node_modules`, also when this file runs from `app.asar.unpacked`. */
function loadSdk(): Sdk {
  const here = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  const requireSdk = createRequire(here.replace(/app\.asar\.unpacked([\\/])/, 'app.asar$1'))
  // Tests replace the SDK with a module of the same shape.
  return requireSdk(process.env.MOUSSE_CURSOR_SDK_MODULE || '@cursor/sdk') as Sdk
}

// -- Guards (T3 Code `CursorSdk.ts`) ------------------------------------------------------------

const SHELL_SPAWN_MARKERS = ['dump_zsh_state', 'dump_bash_state', '__CURSOR_SANDBOX_ENV_RESTORE']

/** The SDK rejects an internal promise nothing awaits when a shell fails to spawn. */
export function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const { syscall, code, spawnargs } = reason as { syscall?: unknown; code?: unknown; spawnargs?: unknown }
  if (typeof syscall !== 'string' || !syscall.startsWith('spawn') || typeof code !== 'string' || !Array.isArray(spawnargs)) return false
  return spawnargs.some((arg) => typeof arg === 'string' && SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)))
}

/** After a local exec fails, the SDK writes to its closed stream from a promise nothing awaits. */
export function isCursorClosedStreamWrite(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'WriteIterableClosedError'
}

// -- Transport failures (T3 Code `transportFailure.ts`) -----------------------------------------

const MAX_LINE = 4096
const TRANSPORT_ERROR = /^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/
const SERVER_ERROR = 'Something went wrong communicating with the server. Please try again.'

/**
 * Whether a reply is only a transport error dump (the SDK writes it as assistant text when a
 * request fails mid-run). Any other line, a quoted diagnostic included, disqualifies the reply.
 */
export class CursorTransportFailure {
  private disqualified = false
  private found: string | undefined
  private line = ''

  push(text: string): void {
    for (const [index, part] of text.split('\n').entries()) {
      if (this.disqualified) return
      if (index > 0) {
        this.consume(this.line)
        this.line = ''
      }
      if (this.line.length + part.length > MAX_LINE) {
        this.disqualified = true
        this.found = undefined
        return
      }
      this.line += part
    }
  }

  private consume(line: string): void {
    if (this.disqualified) return
    const text = line.trimEnd()
    if (TRANSPORT_ERROR.test(text) || text === SERVER_ERROR) this.found = text
    else if (text.trim() !== '' && !(this.found && /^\s+at\s/.test(text))) {
      this.disqualified = true
      this.found = undefined
    }
  }

  get failure(): string | undefined {
    if (this.disqualified) return undefined
    const saved = { disqualified: this.disqualified, found: this.found }
    this.consume(this.line)
    const failure = this.found
    this.disqualified = saved.disqualified
    this.found = saved.found
    return failure
  }
}

// -- Errors -------------------------------------------------------------------------------------

function isCancellation(cause: unknown): boolean {
  const seen = new Set<object>()
  let current = cause
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    if ((current as { name?: unknown }).name === 'AbortError') return true
    seen.add(current)
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export function hostError(cause: unknown): CursorHostError {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  const { code, status } = error as { code?: unknown; status?: unknown }
  const known = { name: error.name, ...(typeof code === 'string' ? { code } : {}), ...(typeof status === 'number' ? { status } : {}) }
  return {
    message: error.message || 'The Cursor SDK failed.',
    ...known,
    ...(/already has active run/i.test(error.message) ? { activeRun: true } : {}),
    ...(isCursorAuthFailure(known) ? { auth: true } : {})
  }
}

/** A failed run's `RunError` (`run.wait()` resolves failures): an auth code signs the entry out. */
export function runError(error: { message: string; code?: string }): CursorHostError {
  return { message: error.message, ...(error.code ? { code: error.code } : {}), ...(isCursorAuthFailure({ ...(error.code ? { code: error.code } : {}) }) ? { auth: true } : {}) }
}

/** One line about a failure for stderr: its name, message and code, never the SDK object. */
function describeFailure(reason: unknown): string {
  if (!(reason instanceof Error)) return redactCursorText(String(reason)).slice(0, 500)
  const code = (reason as { code?: unknown }).code
  return redactCursorText(`${reason.name}: ${reason.message}${typeof code === 'string' ? ` (${code})` : ''}`).slice(0, 500)
}

/**
 * The SDK's helper lookup in 1.0.35 (`platform-package-locator`): up from the entry script, the
 * first `node_modules/@cursor/sdk-<platform>-<arch>/bin/<name>` that is a file.
 */
function helperPath(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const start = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd()
  const root = parse(start).root
  for (let dir = start; dir !== root; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@cursor', `sdk-${process.platform}-${process.arch}`, 'bin', exe)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      // Not readable here; keep walking up.
    }
  }
  return undefined
}

// -- Host ---------------------------------------------------------------------------------------

interface LiveRun {
  run: CursorSdk.Run
}

function main(): void {
  // stdout carries only protocol lines: anything the SDK prints goes to stderr.
  for (const method of ['log', 'info', 'debug'] as const) console[method] = (...args: unknown[]) => console.error(...args)
  // The host never runs with an ambient key: every call names the instance's own.
  delete process.env.CURSOR_API_KEY
  let sdk: Sdk
  try {
    sdk = loadSdk()
  } catch (error) {
    console.error('[cursor-host] could not load @cursor/sdk', error instanceof Error ? error.message : String(error))
    process.exit(3)
  }
  const agents = new Map<string, CursorSdk.SDKAgent>()
  const runs = new Map<string, LiveRun>()
  const logins = new Map<string, AbortController>()
  const stores = new Map<string, CursorSdk.LocalAgentStore>()

  process.on('unhandledRejection', (reason) => {
    if (isCursorShellSpawnFailure(reason)) return console.error('[cursor-host] a Cursor shell failed to spawn; the host keeps running.')
    if (isCursorClosedStreamWrite(reason)) return console.error('[cursor-host] the Cursor SDK wrote to a closed exec stream; the host keeps running.')
    console.error('[cursor-host] unhandled rejection', describeFailure(reason))
    process.exit(1)
  })

  const store = (storeDir: string): CursorSdk.LocalAgentStore => {
    let found = stores.get(storeDir)
    if (!found) {
      found = new sdk.JsonlLocalAgentStore(storeDir)
      stores.set(storeDir, found)
    }
    return found
  }
  const local = (params: CursorLocal) => ({ runtime: 'local' as const, cwd: params.cwd, store: store(params.storeDir) })

  /** `Agent.create`/`Agent.resume` options: the instance's key, its store, and the SDK's retries off. */
  const agentOptions = (setup: CursorAgentSetup): CursorSdk.AgentOptions => ({
    apiKey: setup.apiKey,
    ...(setup.model ? { model: setup.model } : {}),
    ...(setup.mode ? { mode: setup.mode } : {}),
    ...(setup.mcpServers ? { mcpServers: setup.mcpServers } : {}),
    local: {
      cwd: setup.cwd,
      store: store(setup.storeDir),
      settingSources: setup.settingSources as CursorSdk.SettingSource[],
      autoReview: setup.autoReview,
      enableAgentRetries: false
    }
  })

  const agentOf = (agentId: string): CursorSdk.SDKAgent => {
    const agent = agents.get(agentId)
    if (!agent) throw Object.assign(new Error(`Cursor agent ${agentId} is not open.`), { name: 'AgentNotOpen' })
    return agent
  }

  const handlers: { [M in CursorHostMethod]: (params: CursorHostMethods[M]['params']) => Promise<CursorHostMethods[M]['result']> } = {
    create: async (params) => {
      const agent = await sdk.Agent.create(agentOptions(params))
      agents.set(agent.agentId, agent)
      return { agentId: agent.agentId }
    },
    resume: async (params) => {
      const agent = await sdk.Agent.resume(params.agentId, agentOptions(params))
      agents.set(agent.agentId, agent)
      return { agentId: agent.agentId }
    },
    send: async (params) => {
      const agent = agentOf(params.agentId)
      let runId: string | undefined
      const pending: Array<Record<string, unknown>> = []
      const transport = new CursorTransportFailure()
      const forward = (update: Record<string, unknown>) => {
        if (update.type === 'text-delta' && typeof update.text === 'string') transport.push(update.text)
        send({ event: 'delta', runId: runId!, update })
      }
      const message: CursorSdk.SDKUserMessage = { text: params.text, ...(params.images?.length ? { images: params.images } : {}) }
      // Sends inherit the agent's key and its retries setting; `LocalSendOptions` has no retry flag.
      const run = await agent.send(message, {
        ...(params.model ? { model: params.model } : {}),
        ...(params.mode ? { mode: params.mode } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        onDelta: ({ update }) => {
          const value = update as unknown as Record<string, unknown>
          if (runId === undefined) pending.push(value)
          else forward(value)
        }
      })
      runs.set(run.id, { run })
      // The reply (written when this handler settles) goes first, so the driver knows the run
      // before its first update.
      setImmediate(() => {
        runId = run.id
        for (const update of pending.splice(0)) forward(update)
        void run.wait().then(
          (result) => {
            const usage = result.usage as CursorUsage | undefined
            const failure = result.status === 'finished' ? transport.failure : undefined
            send({
              event: 'run_end',
              runId: run.id,
              status: result.status,
              ...(result.error ? { error: runError(result.error) } : {}),
              ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } } : {}),
              ...(failure ? { transportFailure: failure } : {})
            })
          },
          (error: unknown) => send({ event: 'run_end', runId: run.id, status: isCancellation(error) ? 'cancelled' : 'error', ...(isCancellation(error) ? {} : { error: hostError(error) }) })
        ).finally(() => runs.delete(run.id))
      })
      return { runId: run.id }
    },
    cancel: async ({ runId }) => {
      const live = runs.get(runId)
      if (!live) return { cancelled: false }
      try {
        await live.run.cancel()
      } catch (error) {
        if (!isCancellation(error)) throw error
      }
      return { cancelled: true }
    },
    listRuns: async (params) => {
      const listed = await sdk.Agent.listRuns(params.agentId, { ...local(params), limit: params.limit ?? 5 })
      return { runs: listed.items.map((run) => ({ id: run.id, status: run.status })) }
    },
    cancelRun: async (params) => {
      await sdk.Agent.cancelRun(params.runId, local(params))
      return {}
    },
    messages: async (params) => ({ messages: await sdk.Agent.messages.list(params.agentId, local(params)) }),
    close: async ({ agentId }) => {
      const agent = agents.get(agentId)
      agents.delete(agentId)
      agent?.close()
      return {}
    },
    models: async ({ apiKey }) => ({ models: (await sdk.Cursor.models.list({ apiKey })) as CursorHostMethods['models']['result']['models'] }),
    me: async ({ apiKey }) => {
      const user = await sdk.Cursor.me({ apiKey })
      return {
        ...(user.apiKeyName ? { apiKeyName: user.apiKeyName } : {}),
        ...(typeof user.userId === 'number' ? { userId: user.userId } : {}),
        ...(user.userEmail ? { userEmail: user.userEmail } : {})
      }
    },
    login: async ({ loginId }) => {
      const controller = new AbortController()
      logins.set(loginId, controller)
      try {
        // An in-memory store: the minted key goes to Mousse's vault only, never to ~/.cursor/sdk.
        const result = await sdk.Cursor.auth.login({
          openBrowser: false,
          onLoginUrl: (url) => send({ event: 'login_url', loginId, url }),
          store: new sdk.InMemoryCredentialStore(),
          signal: controller.signal,
          apiKeyName: 'Mousse'
        })
        controller.signal.throwIfAborted()
        return { apiKey: result.apiKey, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs, ...(result.email ? { email: result.email } : {}) }
      } finally {
        logins.delete(loginId)
      }
    },
    loginCancel: async ({ loginId }) => {
      const controller = logins.get(loginId)
      controller?.abort()
      return { cancelled: Boolean(controller) }
    },
    prune: async ({ storeDir, agentIds }) => {
      if (!agentIds.length) return {}
      for (const agentId of agentIds) {
        agents.get(agentId)?.close()
        agents.delete(agentId)
      }
      const target = store(storeDir)
      await target.runs.delete({ filter: { agentIds } })
      await target.agents.delete({ filter: { agentIds } })
      return {}
    },
    probe: async () => {
      const rg = helperPath('rg')
      const sandbox = helperPath('cursorsandbox')
      return { ...(rg ? { rg } : {}), ...(sandbox ? { sandbox } : {}) }
    }
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    if (!line.trim()) return
    let request: CursorHostRequest
    try {
      request = JSON.parse(line) as CursorHostRequest
    } catch {
      console.error('[cursor-host] ignored a line that is not JSON')
      return
    }
    const handler = handlers[request.method] as ((params: unknown) => Promise<unknown>) | undefined
    if (!handler) return send({ id: request.id, error: { message: `Unknown method ${String(request.method)}.` } })
    handler(request.params).then(
      (result) => send({ id: request.id, result }),
      (error: unknown) => send({ id: request.id, error: hostError(error) })
    )
  })
  // The driver closing stdin (or dying) ends the host and every agent in it.
  input.on('close', () => {
    for (const agent of agents.values()) {
      try {
        agent.close()
      } catch {
        // Closing is best effort; the process ends next.
      }
    }
    process.exit(0)
  })
  send({ event: 'ready' })
}

if (process.env.MOUSSE_CURSOR_HOST === '1') main()
