import { spawn as nodeSpawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { McpServerConfig, McpSetServersResult, Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { AppError } from '../../../../shared/errors'
import { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../run/mcp/attachment'

/**
 * How Mousse gives Claude Code the MCP servers of a turn (#358), never through the SDK's `mcpServers` option: the SDK
 * writes those servers into Claude Code's command line (`--mcp-config <json>`), where any local process can read their
 * headers (`ps`, `/proc/<pid>/cmdline`), the commands Claude runs included. Nor as `${VAR}` references to variables in
 * Claude Code's environment, which every command Claude runs inherits: Mousse has expanded every value already.
 *
 * - Mousse's own servers (`mousse`, `mousse-relay`) and the user's servers Mousse runs in process (`type: 'sdk'`, OAuth
 *   servers it stays signed in to) are registered over the process's input with `Query.setMcpServers` once it has
 *   started, and the turn waits for them: they connect at once, and a turn must not start without Mousse's tools.
 * - The user's other servers (stdio, http, sse) go to Claude Code at its start through an inherited pipe it reads once
 *   (`--mcp-config /dev/fd/3`, `claudeStartupMcpOptions`): the path is all the command line shows, and the pipe is empty
 *   once Claude Code has read it. Claude Code connects them in the background, as servers on its command line, and its
 *   first turn waits for them at most `CLAUDE_MCP_STARTUP_WAIT_MS`; the turn then starts without the ones still
 *   connecting (`claudeMcpLeftOut` names them). Registering them with `setMcpServers` would hold the turn instead:
 *   Claude Code answers it only once every server has connected or timed out (three stdio servers at a time, 30 s
 *   each), and handles no other request from Mousse meanwhile, a Stop included.
 * - Where the pipe cannot be used (Windows, or a launch argument of the user's that sets `--mcp-config` already), they
 *   are registered with `setMcpServers` after Mousse's own, and the turn does not wait for the answer
 *   (`registerUserServersLater`); Claude Code still reads the prompt only once it has answered.
 */
export type ClaudeMcpServers = Record<string, McpServerConfig>

/** Claude Code's own wait for an MCP server to connect, when `MCP_TIMEOUT` does not set it. */
const CLAUDE_MCP_CONNECT_MS = 30_000
/** Beyond Claude Code's own connect wait: its answer. */
const REGISTRATION_MARGIN_MS = 30_000
/**
 * How long a new Claude Code process's first turn waits for the user's servers that are still connecting
 * (`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`), unless the user's environment sets it. Long enough for a server that starts at
 * once; one that is slower is offered from a later turn of the same process.
 */
export const CLAUDE_MCP_STARTUP_WAIT_MS = 3_000
/** Where Claude Code reads the user's servers at its start: the pipe Mousse gives it as its fourth stream. */
export const CLAUDE_STARTUP_MCP_CONFIG = '/dev/fd/3'

/**
 * How long the registration of Mousse's own servers may take: Claude Code answers `setMcpServers` once each server it
 * was given has connected or failed, which a server that never answers holds for Claude Code's connect wait
 * (`MCP_TIMEOUT`, 30 s by default). The user's servers are never in that set.
 */
export function claudeMcpRegistrationMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.MCP_TIMEOUT)
  return (Number.isFinite(configured) && configured > 0 ? configured : CLAUDE_MCP_CONNECT_MS) + REGISTRATION_MARGIN_MS
}

const UNAVAILABLE = 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start.'

function mousseUnavailable(reason: string): AppError {
  return new AppError({ code: 'claude_mcp_unavailable', message: `${UNAVAILABLE} ${reason}`, errorInfo: { category: 'unavailable', retryable: false } })
}

const UPDATE = 'This Claude Code cannot take MCP servers over its input; update Claude Code and try again.'

/** The request went unanswered for `ms`. */
class RegistrationTimeout extends Error {
  constructor(readonly ms: number) {
    super('timeout')
  }
}

type RegistrationOptions = { timeoutMs: number; signal?: AbortSignal; threadId?: string }

/** Sends `servers` (`setMcpServers`) and waits for the answer, at most `timeoutMs` and never past `signal`. */
async function send(target: Pick<Query, 'setMcpServers'>, servers: ClaudeMcpServers, options: RegistrationOptions): Promise<McpSetServersResult> {
  options.signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped: (() => void) | undefined
  try {
    return await Promise.race([
      target.setMcpServers(servers),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RegistrationTimeout(options.timeoutMs)), options.timeoutMs)
        timer.unref?.()
      }),
      new Promise<never>((_, reject) => {
        if (!options.signal) return
        stopped = () => reject(options.signal!.reason ?? new Error('Turn cancelled'))
        options.signal.addEventListener('abort', stopped, { once: true })
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (stopped) options.signal?.removeEventListener('abort', stopped)
  }
}

/** Claude Code does not know the request: it answers a control request it lacks with exactly this. */
function unsupported(error: unknown): boolean {
  return /Unsupported control request subtype/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * Registers `servers` on a Claude Code process (`setMcpServers`), in place of the ones registered before, and waits for
 * its answer. Mousse's own server must connect, or this throws an error that names the cause, and the turn fails; a
 * server of the user's that does not is left out, and its name is returned (`failed`) for the warning the owner sees.
 * "Update Claude Code" is said only when Claude Code lacks the request. Only server names are logged: Claude Code's
 * error for a server can repeat what it sent, a header included. `signal` ends the wait (the turn was stopped).
 */
export async function registerClaudeMcpServers(target: Partial<Pick<Query, 'setMcpServers'>>, servers: ClaudeMcpServers, options: RegistrationOptions): Promise<{ failed: string[] }> {
  const names = Object.keys(servers)
  const required = names.includes(MOUSSE_MCP_SERVER_NAME)
  const users = names.filter((name) => name !== MOUSSE_MCP_SERVER_NAME && name !== MOUSSE_RELAY_SERVER_NAME)
  if (typeof target.setMcpServers !== 'function') {
    console.warn('[claude-subscription] this Claude Code cannot take MCP servers over its input', { threadId: options.threadId, servers: names })
    if (required) throw mousseUnavailable(UPDATE)
    return { failed: users }
  }
  let result: McpSetServersResult
  try {
    result = await send(target as Pick<Query, 'setMcpServers'>, servers, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    // The request itself failed: an older Claude Code, a process that ended, or no answer in time. Its text is not logged.
    console.warn('[claude-subscription] Claude Code took none of these MCP servers', { threadId: options.threadId, servers: names, cause: error instanceof RegistrationTimeout ? 'no answer in time' : unsupported(error) ? 'unsupported' : 'request failed' })
    if (required) {
      if (unsupported(error)) throw mousseUnavailable(UPDATE)
      if (error instanceof RegistrationTimeout)
        throw mousseUnavailable(`Claude Code did not answer within ${Math.round(error.ms / 1000)} s while it connected to Mousse's MCP server; try again.`)
      throw mousseUnavailable('Claude Code ended before Mousse\'s MCP server was attached; try again.')
    }
    return { failed: users }
  }
  const errors = result.errors ?? {}
  const failed = names.filter((name) => Object.prototype.hasOwnProperty.call(errors, name))
  // Mousse's server is always sent with a header the process does not have yet (a new process, or a new token), so
  // Claude Code lists it as added; one it left out without an error (a policy that denies it) is missing all the same.
  const denied = required && !failed.includes(MOUSSE_MCP_SERVER_NAME) && !(result.added ?? []).includes(MOUSSE_MCP_SERVER_NAME)
  for (const name of failed)
    console.warn(`[claude-subscription] MCP server "${name}" could not be attached; it is left out of this turn`, { threadId: options.threadId })
  if (required && failed.includes(MOUSSE_MCP_SERVER_NAME)) throw mousseUnavailable('Claude Code could not connect to Mousse\'s MCP server; try again.')
  if (denied) throw mousseUnavailable('Claude Code left Mousse\'s MCP server out without an error; a setting of Claude Code\'s may deny it.')
  return { failed: failed.filter((name) => users.includes(name)) }
}

/**
 * Registers the user's servers on a process that has Mousse's own already (`registered`, sent again unchanged, which
 * Claude Code leaves connected) without waiting: the turn goes on, and `done` gets the names of the user's servers
 * that did not connect when Claude Code answers. For the processes the startup pipe cannot reach
 * (`claudeStartupMcpOptions`).
 */
export function registerUserServersLater(target: Partial<Pick<Query, 'setMcpServers'>>, registered: ClaudeMcpServers, users: ClaudeMcpServers, threadId: string, done: (failed: string[]) => void): ClaudeMcpServers {
  const servers = { ...users, ...registered }
  // Never past the turn: an answer that does not come in Claude Code's own connect time is not waited for.
  void registerClaudeMcpServers(target, servers, { timeoutMs: 10 * 60_000, threadId }).then(
    ({ failed }) => { if (failed.length > 0) done(failed) },
    () => done(Object.keys(users))
  )
  return servers
}

/**
 * Takes Mousse's own servers off a process and keeps the others (`servers`, the set registered on it), so the next
 * registration connects them anew: Claude Code leaves a server whose config it already has as it is, a failed one
 * included. Throws when Claude Code did not answer.
 */
export async function dropMousseServers(target: Pick<Query, 'setMcpServers'>, servers: ClaudeMcpServers, options: RegistrationOptions): Promise<void> {
  const others = Object.fromEntries(Object.entries(servers).filter(([name]) => name !== MOUSSE_MCP_SERVER_NAME && name !== MOUSSE_RELAY_SERVER_NAME))
  await send(target, others, options)
}

/**
 * The prompt of a one-shot query, held until its servers are registered (`ready`): Claude Code reads nothing before
 * it has them. A registration that failed ends the prompt with nothing sent.
 */
export function promptAfter(ready: Promise<unknown>, prompt: AsyncIterable<SDKUserMessage>): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    try {
      await ready
    } catch {
      return
    }
    yield* prompt
  })()
}

type Spawn = typeof nodeSpawn

/**
 * The query options that give Claude Code the user's servers (`servers`) at its start, through a pipe it inherits as
 * its fourth stream and reads once (`--mcp-config /dev/fd/3`): the command line shows only the path, the environment
 * holds nothing of them, and the pipe is empty once read; the commands Claude Code runs do not get the stream. Its first
 * turn waits for them at most `CLAUDE_MCP_STARTUP_WAIT_MS`. Mousse spawns the process for that, as the SDK would, and
 * reports its pid (`onSpawned`). Undefined where the pipe cannot be used: on Windows, which has no `/dev/fd`, or when
 * a launch argument of the user's names `--mcp-config` already, or another spawn is set.
 */
export function claudeStartupMcpOptions(options: Options, servers: ClaudeMcpServers, onSpawned: (pid: number) => void, deps: { platform?: NodeJS.Platform; spawn?: Spawn } = {}): Options | undefined {
  if ((deps.platform ?? process.platform) === 'win32' || options.spawnClaudeCodeProcess || Object.hasOwn(options.extraArgs ?? {}, 'mcp-config')) return undefined
  const spawn = deps.spawn ?? nodeSpawn
  const config = JSON.stringify({ mcpServers: servers })
  const env = options.env ?? {}
  return {
    ...options,
    extraArgs: { ...options.extraArgs, 'mcp-config': CLAUDE_STARTUP_MCP_CONFIG },
    ...(env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS === undefined ? { env: { ...env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: String(CLAUDE_MCP_STARTUP_WAIT_MS) } } : {}),
    spawnClaudeCodeProcess: (spawned: SpawnOptions): SpawnedProcess => {
      const child = spawn(spawned.command, spawned.args, {
        ...(spawned.cwd ? { cwd: spawned.cwd } : {}),
        env: spawned.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        signal: spawned.signal,
        windowsHide: true
      })
      const pipe = child.stdio[3] as Writable | null | undefined
      // A process that ended before it read the pipe closes it: nothing is left to read, and nothing to report.
      pipe?.on('error', () => undefined)
      pipe?.end(config)
      if (child.pid !== undefined) onSpawned(child.pid)
      return child as unknown as SpawnedProcess
    }
  }
}

/** A user's server Claude Code did not have ready when a turn started, and why. */
export interface ClaudeMcpLeftOut {
  name: string
  state: 'starting' | 'failed' | 'needs-auth'
}

/**
 * The user's servers (`names`) Claude Code started a turn without, read from the turn's `system/init` frame: still
 * connecting, failed, or waiting for a sign-in. Undefined for any other frame.
 */
export function claudeMcpLeftOut(message: SDKMessage, names: ReadonlySet<string>): ClaudeMcpLeftOut[] | undefined {
  if (message.type !== 'system' || (message as { subtype?: unknown }).subtype !== 'init') return undefined
  const servers = (message as { mcp_servers?: unknown }).mcp_servers
  if (!Array.isArray(servers)) return undefined
  return servers.flatMap((server: { name?: unknown; status?: unknown }) => {
    if (typeof server?.name !== 'string' || !names.has(server.name)) return []
    const state = server.status === 'pending' ? 'starting' : server.status === 'failed' ? 'failed' : server.status === 'needs-auth' ? 'needs-auth' : undefined
    return state ? [{ name: server.name, state }] : []
  })
}

/** The line the owner sees in the thread for servers a turn started without (`claudeMcpLeftOut`). */
export function claudeMcpLeftOutText(left: readonly ClaudeMcpLeftOut[]): string {
  const named = (state: ClaudeMcpLeftOut['state']) => left.filter((entry) => entry.state === state).map((entry) => entry.name)
  const parts = [
    [named('starting'), 'still starting; its tools come in a later turn', 'still starting; their tools come in a later turn'],
    [named('failed'), 'could not connect', 'could not connect'],
    [named('needs-auth'), 'needs you to sign in', 'need you to sign in']
  ] as const
  const said = parts.filter(([names]) => names.length > 0).map(([names, one, many]) => `${names.join(', ')} (${names.length === 1 ? one : many})`)
  return `Claude started this turn without ${left.length === 1 ? 'an MCP server' : 'some MCP servers'}: ${said.join('; ')}.`
}
