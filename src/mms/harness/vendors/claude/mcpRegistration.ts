import type { McpServerConfig, McpSetServersResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AppError } from '../../../../shared/errors'
import { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../run/mcp/attachment'

/**
 * How Mousse gives Claude Code the MCP servers of a turn (#358): over the process's input with `Query.setMcpServers`,
 * once the process has started and before its first prompt. Never through the SDK's `mcpServers` option: the SDK
 * writes those servers into Claude Code's command line (`--mcp-config`), where any local process can read their
 * headers (`ps`, `/proc/<pid>/cmdline`), the commands Claude runs included. The values of the user's servers go as they
 * are, not as `${VAR}` references to variables in Claude Code's own environment, which every command Claude runs
 * inherits; Mousse has expanded every reference already. In-process servers (`type: 'sdk'`) go the same way: the SDK
 * connects them itself and tells Claude Code only their names.
 */
export type ClaudeMcpServers = Record<string, McpServerConfig>

/** Claude Code's own wait for an MCP server to connect, when `MCP_TIMEOUT` does not set it. */
const CLAUDE_MCP_CONNECT_MS = 30_000
/** Beyond Claude Code's own connect wait: its answer, and a server that started connecting late. */
const REGISTRATION_MARGIN_MS = 30_000

/**
 * How long a registration may take: Claude Code answers `setMcpServers` once every server it was given has connected
 * or failed, so a server that never answers holds it for Claude Code's connect wait (`MCP_TIMEOUT`, 30 s by default),
 * as it holds a turn's start when the servers are on the command line.
 */
export function claudeMcpRegistrationMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.MCP_TIMEOUT)
  return (Number.isFinite(configured) && configured > 0 ? configured : CLAUDE_MCP_CONNECT_MS) + REGISTRATION_MARGIN_MS
}

const UNAVAILABLE = 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start.'

function mousseUnavailable(reason: string): AppError {
  return new AppError({ code: 'claude_mcp_unavailable', message: `${UNAVAILABLE} ${reason}`, errorInfo: { category: 'unavailable', retryable: false } })
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
        timer = setTimeout(() => reject(new Error('timeout')), options.timeoutMs)
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

/**
 * Registers `servers` on a Claude Code process (`setMcpServers`), in place of the ones registered before, and waits for
 * its answer. Mousse's own server must connect, or this throws a clear error and the turn fails; a user server that does
 * not is left out with a warning. Only server names are logged: Claude Code's error for a server can repeat what it
 * sent, a header included. `signal` ends the wait (the turn was stopped).
 */
export async function registerClaudeMcpServers(target: Pick<Query, 'setMcpServers'>, servers: ClaudeMcpServers, options: RegistrationOptions): Promise<void> {
  const names = Object.keys(servers)
  const required = names.includes(MOUSSE_MCP_SERVER_NAME)
  let result: McpSetServersResult
  try {
    result = await send(target, servers, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    // The request itself failed: an older Claude Code, a process that ended, or no answer in time. Its text is not logged.
    console.warn('[claude-subscription] Claude Code took none of the turn\'s MCP servers', { threadId: options.threadId, servers: names })
    if (required) throw mousseUnavailable('Claude Code did not accept them; update Claude Code and try again.')
    return
  }
  const errors = result.errors ?? {}
  const failed = names.filter((name) => Object.prototype.hasOwnProperty.call(errors, name))
  // Mousse's server is always sent with a header the process does not have yet (a new process, or a new token), so
  // Claude Code lists it as added; one it left out without an error (a policy that denies it) is missing all the same.
  if (required && !failed.includes(MOUSSE_MCP_SERVER_NAME) && !(result.added ?? []).includes(MOUSSE_MCP_SERVER_NAME)) failed.push(MOUSSE_MCP_SERVER_NAME)
  for (const name of failed)
    console.warn(`[claude-subscription] MCP server "${name}" could not be attached; it is left out of this turn`, { threadId: options.threadId })
  if (required && failed.includes(MOUSSE_MCP_SERVER_NAME)) throw mousseUnavailable('Claude Code could not connect to Mousse\'s MCP server; try again.')
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
