import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { constants, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { McpServerConfig, McpSetServersResult, Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { AppError } from '../../../../shared/errors'
import { redactSensitiveText } from '../../../integrations/secrets'
import { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../run/mcp/attachment'

/**
 * How Mousse gives Claude Code the MCP servers of a turn (#358), never through the SDK's `mcpServers` option: the SDK
 * writes those servers into Claude Code's command line (`--mcp-config <json>`), where any local process can read their
 * headers (`ps`, `/proc/<pid>/cmdline`), the commands Claude runs included. Nor as `${VAR}` references to variables in
 * Claude Code's environment, which every command Claude runs inherits: Mousse has expanded every value already, and
 * Claude Code expands none of them again (`claudeLiteralServers`).
 *
 * - Mousse's own servers (`mousse`, `mousse-relay`) and the user's servers Mousse runs in process (`type: 'sdk'`, OAuth
 *   servers it stays signed in to) are registered over the process's input with `Query.setMcpServers` once it has
 *   started, and the turn waits for them: they connect at once, and a turn must not start without Mousse's tools.
 * - The user's other servers (stdio, http, sse) go to Claude Code at its start through a channel it reads once by the
 *   path on its command line (`--mcp-config <path>`, `claudeStartupMcpOptions`): the path is all the command line shows,
 *   and the channel is empty and closed once Claude Code has read it. On macOS the channel is the process's fourth stream
 *   (`/dev/fd/3`, a socket pair, which macOS lets the process open by that path); on Linux, where a socket cannot be
 *   opened by path, it is a named pipe in a folder only the user can enter, removed as soon as Claude Code opens it.
 *   Claude Code connects them in the background, as servers on its command line, and its first turn waits for them at
 *   most `CLAUDE_MCP_STARTUP_WAIT_MS`; the turn then starts without the ones still connecting (`claudeMcpLeftOut` names
 *   them). Registering them with `setMcpServers` would hold the turn instead: Claude Code answers it only once every
 *   server has connected or timed out (three stdio servers at a time, 30 s each), and handles no other request from
 *   Mousse meanwhile, a Stop included.
 * - Where no channel can be used (Windows, a launch argument of the user's that sets `--mcp-config` already, or a
 *   system without `mkfifo`), they are registered with `setMcpServers` after Mousse's own, and the turn does not wait for
 *   the answer (`registerUserServersLater`); Claude Code still reads the prompt only once it has answered, so that
 *   process connects more servers at a time and gives each less time (`CLAUDE_INPUT_MCP_ENV`).
 * - A computer whose Claude Code policy forbids added MCP servers (`claudeMcpPolicyForbidsAdded`, or Claude Code refusing
 *   to start with them: `CLAUDE_MCP_POLICY_CODE`) gets none of the user's servers, by either way: only Mousse's own.
 */
export type ClaudeMcpServers = Record<string, McpServerConfig>

/** Claude Code's own wait for an MCP server to connect, when `MCP_TIMEOUT` does not set it. */
const CLAUDE_MCP_CONNECT_MS = 30_000
/** Beyond Claude Code's own connect wait: its answer. */
const REGISTRATION_MARGIN_MS = 30_000
/**
 * How long a new Claude Code process's first turn waits for the user's servers that are still connecting
 * (`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`), unless the user's environment sets it. Long enough for a server that starts at
 * once; one that is slower is offered to the model from its next request after it has connected, in the same turn.
 */
export const CLAUDE_MCP_STARTUP_WAIT_MS = 3_000
/** Where Claude Code reads the user's servers at its start on macOS: the socket Mousse gives it as its fourth stream. */
export const CLAUDE_STARTUP_MCP_CONFIG = '/dev/fd/3'
/**
 * Variables a process that gets the user's servers over its input starts with, unless the user's environment sets them
 * (`claudeInputMcpEnv`): Claude Code holds the first prompt until each of those servers has connected or timed out, at
 * most `MCP_TIMEOUT` each and three stdio servers at a time by default (four that never answer: 60 s). With these, four
 * such servers hold it about 10 s (checked with the real CLI, 2.1.291); a server slower than that to start is reported
 * as not connected.
 */
export const CLAUDE_INPUT_MCP_ENV = { MCP_TIMEOUT: '10000', MCP_SERVER_CONNECTION_BATCH_SIZE: '16' } as const

/** `env` with `CLAUDE_INPUT_MCP_ENV` where it sets none of its own. */
export function claudeInputMcpEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...CLAUDE_INPUT_MCP_ENV, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) }
}

/**
 * The variable a literal `${` is sent through (`claudeLiteralServers`); Claude Code's environment never has it.
 */
export const CLAUDE_LITERAL_DOLLAR = 'MOUSSE_LITERAL_DOLLAR'
/**
 * How many times Claude Code expands `${...}` in each field of a server, by how it got the server: through the startup
 * channel (`--mcp-config <path>`) or over its input (`setMcpServers`). Checked with the real CLI (2.1.291) and pinned by
 * `tests/harness/claudeMcpCommandLine.test.ts`, which fails if a later Claude Code changes it.
 */
const EXPANSIONS = {
  startup: { url: 1, headers: 2, command: 1, args: 1, env: 1 },
  input: { url: 0, headers: 1, command: 0, args: 0, env: 0 }
} as const
const ESCAPED = `\${${CLAUDE_LITERAL_DOLLAR}:-$}{`
const escapeTimes = (text: string, times: number): string => {
  let out = text
  for (let pass = 0; pass < times; pass++) out = out.split('${').join(ESCAPED)
  return out
}

/**
 * `servers` as they must be sent for each to reach its server exactly as Mousse resolved it (#358). Claude Code expands
 * `${NAME}` and `${NAME:-default}` in a server's strings against its own environment (the instance's credentials and
 * the user's variables), and reads no form as literal: `$${`, `\${` and JSON escapes are all expanded. So each `${` is
 * sent as `${MOUSSE_LITERAL_DOLLAR:-$}{`, which one expansion turns back into `${` (Claude Code does not read its result
 * again), once for each time Claude Code expands that field on that path (`EXPANSIONS`). Claude Code's environment is
 * never read into a value; `CLAUDE_LITERAL_DOLLAR` must not be in it (`withoutLiteralDollar`). In-process servers
 * (`type: 'sdk'`) carry no strings Claude Code reads and are sent as they are.
 */
export function claudeLiteralServers(servers: ClaudeMcpServers, path: keyof typeof EXPANSIONS): ClaudeMcpServers {
  const times = EXPANSIONS[path]
  const record = (value: unknown, count: number): unknown => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, text]) => [key, typeof text === 'string' ? escapeTimes(text, count) : text]))
    : value
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (server.type === 'sdk') return [name, server]
    const copy: Record<string, unknown> = { ...server }
    if (typeof copy.url === 'string') copy.url = escapeTimes(copy.url, times.url)
    if (typeof copy.command === 'string') copy.command = escapeTimes(copy.command, times.command)
    if (Array.isArray(copy.args)) copy.args = copy.args.map((arg) => typeof arg === 'string' ? escapeTimes(arg, times.args) : arg)
    if ('headers' in copy) copy.headers = record(copy.headers, times.headers)
    if ('env' in copy) copy.env = record(copy.env, times.env)
    return [name, copy as McpServerConfig]
  }))
}

/** `env` without `CLAUDE_LITERAL_DOLLAR`, so a literal `${` sent through it always comes back as `${`. */
export function withoutLiteralDollar<T extends Record<string, string | undefined>>(env: T): T {
  if (!Object.keys(env).some((name) => name.toUpperCase() === CLAUDE_LITERAL_DOLLAR)) return env
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== CLAUDE_LITERAL_DOLLAR)) as T
}

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

/** The code of the error for a start Claude Code refused because its policy forbids the user's added MCP servers. */
export const CLAUDE_MCP_POLICY_CODE = 'claude_mcp_policy_refused'
/** What Claude Code writes when its policy refuses `--mcp-config` servers at its start (2.1.291's words). */
const POLICY_REFUSAL = /disableSideloadFlags|enterprise MCP config|managed-mcp\.json|managed MCP configuration/i
/** What Claude Code writes when it could not read or parse the servers given at its start. */
const CONFIG_UNREADABLE = /Invalid MCP configuration|MCP config file not found|MCP config is not a regular file|MCP config read error|--mcp-config/i

/** The line said in the thread when the user's servers were left out for the computer's Claude Code policy. */
export function claudeMcpPolicyText(names: readonly string[]): string {
  return `This computer's Claude Code policy does not allow added MCP servers, so Claude started without ${names.length === 1 ? 'yours' : 'your servers'}: ${names.join(', ')}. Mousse's own tools are attached.`
}

type RegistrationOptions = {
  timeoutMs: number
  signal?: AbortSignal
  threadId?: string
  /** What Claude Code wrote to its error stream, redacted (`ClaudeStderrTail`): read when the process ended. */
  explain?: () => Promise<string>
}

/** The error for a request that failed because the process ended, named from what the process said (`explain`). */
async function endedError(options: RegistrationOptions): Promise<AppError> {
  const said = (await options.explain?.().catch(() => '')) ?? ''
  if (POLICY_REFUSAL.test(said))
    return new AppError({ code: CLAUDE_MCP_POLICY_CODE, message: `${UNAVAILABLE} This computer's Claude Code policy does not allow added MCP servers. Claude Code said: ${said}`, errorInfo: { category: 'unavailable', retryable: false } })
  if (CONFIG_UNREADABLE.test(said)) return mousseUnavailable(`Claude Code could not read the MCP servers Mousse gave it at its start, and ended. Claude Code said: ${said}`)
  if (said) return mousseUnavailable(`Claude Code ended before Mousse's MCP server was attached. Claude Code said: ${said}`)
  return mousseUnavailable('Claude Code ended before Mousse\'s MCP server was attached, without saying why; try again.')
}

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
      throw await endedError(options)
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
  const servers = { ...claudeLiteralServers(users, 'input'), ...registered }
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

/** How much of Claude Code's error stream is kept (`ClaudeStderrTail`), and how much of it an error repeats. */
const STDERR_KEPT = 16 * 1024
const STDERR_SAID = 600

/** `text` with every value in `secrets`, and anything that looks like a credential or a header value, removed. */
export function redactClaudeOutput(text: string, secrets: Iterable<string>): string {
  let out = text
  // Longest first, so a value that holds a shorter one is removed whole.
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]')
  // An authorization scheme and its value go together, before the header rules below see the scheme as the value.
  out = out.replace(/\b(?:Bearer|Basic|Token)\s+[^\s"',}]+/gi, '[redacted]')
  out = redactSensitiveText(out)
    // A header or variable given a value: `X-Api-Key: …`, `"Authorization":"…"`, `--header=…`.
    .replace(/((?:x-[\w-]+|authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|[\w-]*token|[\w-]*secret|header)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    // A long run of key-like characters: a token whatever its name.
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]')
  return out
}

/**
 * The end of what a Claude Code process wrote to its error stream, for the error of a start that failed (#358). Mousse
 * reads the whole stream as it comes (an unread one fills its buffer and stalls the process), keeps the last
 * `STDERR_KEPT` characters, and repeats at most `STDERR_SAID` of them, redacted (`redactClaudeOutput`).
 */
export class ClaudeStderrTail {
  private text = ''
  private ended!: () => void
  private readonly done = new Promise<void>((resolve) => {
    this.ended = resolve
  })

  constructor(private readonly secrets: () => Iterable<string>) {}

  readonly push = (chunk: string | Buffer): void => {
    this.text = (this.text + String(chunk)).slice(-STDERR_KEPT)
  }

  /** The stream ended (the process exited and its last words were read). */
  readonly end = (): void => this.ended()

  /** The redacted tail, once the stream has ended or `waitMs` has passed. */
  async said(waitMs = 1_000): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.done, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
      timer.unref?.()
    })])
    if (timer) clearTimeout(timer)
    const lines = redactClaudeOutput(this.text, this.secrets()).split('\n').map((line) => line.trim()).filter(Boolean).join(' ')
    return lines.length > STDERR_SAID ? `…${lines.slice(-STDERR_SAID)}` : lines
  }
}

/** Every string of `servers` (header and variable values, addresses, arguments), for `redactClaudeOutput`. */
export function claudeMcpStrings(servers: ClaudeMcpServers): string[] {
  const strings: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1)
    else if (value && typeof value === 'object' && depth < 3) for (const [key, item] of Object.entries(value)) if (key !== 'type' && key !== 'instance') walk(item, depth + 1)
  }
  for (const server of Object.values(servers)) walk(server, 0)
  return strings
}

/**
 * How the user's servers reach Claude Code at its start on this platform: through its fourth stream (`descriptor`, on
 * macOS, which lets a process open its own socket by `/dev/fd/3`), or a named pipe (`fifo`: Linux opens `/dev/fd/3` as
 * `/proc/self/fd/3`, which fails for a socket, the only stream Node gives a child). None on Windows.
 */
export type ClaudeStartupChannel = 'descriptor' | 'fifo'
export function claudeStartupChannel(platform: NodeJS.Platform): ClaudeStartupChannel | undefined {
  if (platform === 'win32') return undefined
  return platform === 'darwin' ? 'descriptor' : 'fifo'
}

/** How long Mousse waits for Claude Code to open the named pipe, and how often it looks. */
const FIFO_WAIT_MS = 5 * 60_000
const FIFO_POLL_MS = { first: 5, most: 100 }

/**
 * Makes a named pipe only this user can reach (`mkfifo -m 600` in a new folder of mode 700), or undefined when the
 * system cannot (no `mkfifo`): the user's servers then go over Claude Code's input.
 */
async function privateFifo(root: string): Promise<{ dir: string; path: string } | undefined> {
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(root, 'mousse-mcp-'))
    const path = join(dir, 'servers')
    await promisify(execFile)('mkfifo', ['-m', '600', path], { timeout: 5_000 })
    return { dir, path }
  } catch {
    if (dir) try { rmdirSync(dir) } catch { /* left empty, mode 700 */ }
    return undefined
  }
}

/**
 * Writes `config` into the named pipe once a reader has opened it, then removes the pipe and its folder: from then on
 * nothing can open it, and the reader gets the end of the stream after `config`. The pipe is opened for writing without
 * blocking and looked at again until a reader is there (`FIFO_POLL_MS`), so no thread waits on it; a process that ends
 * first, or never opens it in `FIFO_WAIT_MS`, gets nothing, and the pipe is removed.
 */
function writeWhenOpened(fifo: { dir: string; path: string }, config: string, child: ChildProcess): void {
  let done = false
  const remove = (): void => {
    if (done) return
    done = true
    try { unlinkSync(fifo.path) } catch { /* already gone */ }
    try { rmdirSync(fifo.dir) } catch { /* already gone */ }
  }
  child.once('exit', remove)
  child.once('error', remove)
  const started = Date.now()
  let wait: number = FIFO_POLL_MS.first
  const attempt = (): void => {
    if (done) return
    let fd: number
    try {
      fd = openSync(fifo.path, constants.O_WRONLY | constants.O_NONBLOCK)
    } catch (error) {
      // ENXIO: no reader yet.
      if ((error as NodeJS.ErrnoException).code === 'ENXIO' && Date.now() - started < FIFO_WAIT_MS) {
        setTimeout(attempt, wait).unref?.()
        wait = Math.min(FIFO_POLL_MS.most, wait * 2)
      } else remove()
      return
    }
    remove()
    const stream = new Socket({ fd, readable: false, writable: true })
    // A reader that went away (the process ended) closes the pipe: nothing to report.
    stream.on('error', () => undefined)
    stream.end(config)
  }
  attempt()
}

/**
 * The query options that give Claude Code the user's servers (`servers`) at its start, through a channel it reads once
 * by the path on its command line (`--mcp-config <path>`, `claudeStartupChannel`): the command line shows only the path,
 * the environment holds nothing of them, the values are in no file, and the channel is at its end once read. Its first
 * turn waits for them at most `CLAUDE_MCP_STARTUP_WAIT_MS`. Mousse spawns the process for that, as the SDK would,
 * reports its pid (`onSpawned`), and reads its error stream to the end (`onStderr`). Undefined where no channel can be
 * used: on Windows, when a launch argument of the user's names `--mcp-config` already, when another spawn is set, or when
 * a named pipe cannot be made.
 *
 * On Linux, another process of the same user that opens the named pipe before Claude Code does, in the moment between
 * its creation and Claude Code's start (it holds no value until a reader opens it), would read the servers; Claude Code
 * would then read nothing and fail to start, which the turn reports. That process can already read the same user's
 * Mousse files and Claude Code settings. No other user can enter the folder.
 */
export async function claudeStartupMcpOptions(
  options: Options,
  servers: ClaudeMcpServers,
  onSpawned: (pid: number) => void,
  deps: { platform?: NodeJS.Platform; channel?: ClaudeStartupChannel; spawn?: Spawn; fifoRoot?: string; onStderr?: ClaudeStderrTail } = {}
): Promise<Options | undefined> {
  const channel = deps.channel ?? claudeStartupChannel(deps.platform ?? process.platform)
  if (!channel || options.spawnClaudeCodeProcess || Object.hasOwn(options.extraArgs ?? {}, 'mcp-config')) return undefined
  const fifo = channel === 'fifo' ? await privateFifo(deps.fifoRoot ?? tmpdir()) : undefined
  if (channel === 'fifo' && !fifo) return undefined
  const spawn = deps.spawn ?? nodeSpawn
  const config = JSON.stringify({ mcpServers: claudeLiteralServers(servers, 'startup') })
  const env = options.env ?? {}
  return {
    ...options,
    extraArgs: { ...options.extraArgs, 'mcp-config': fifo ? fifo.path : CLAUDE_STARTUP_MCP_CONFIG },
    ...(env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS === undefined ? { env: { ...env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: String(CLAUDE_MCP_STARTUP_WAIT_MS) } } : {}),
    spawnClaudeCodeProcess: (spawned: SpawnOptions): SpawnedProcess => {
      const child = spawn(spawned.command, spawned.args, {
        ...(spawned.cwd ? { cwd: spawned.cwd } : {}),
        env: spawned.env as NodeJS.ProcessEnv,
        stdio: fifo ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
        signal: spawned.signal,
        windowsHide: true
      })
      // Read to the end whatever it writes there, as the SDK does for a process it starts itself.
      child.stderr?.on('data', (chunk: Buffer) => deps.onStderr?.push(chunk))
      child.stderr?.once('close', () => deps.onStderr?.end())
      child.stderr?.on('error', () => undefined)
      if (fifo) writeWhenOpened(fifo, config, child)
      else {
        const pipe = child.stdio[3] as Writable | null | undefined
        // A process that ended before it read the socket closes it: nothing is left to read, and nothing to report.
        pipe?.on('error', () => undefined)
        pipe?.end(config)
      }
      if (child.pid !== undefined) onSpawned(child.pid)
      return child as unknown as SpawnedProcess
    }
  }
}

/** Where Claude Code reads its managed settings on this platform (no variable moves it). */
function managedSettingsDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * Whether this computer's Claude Code policy forbids MCP servers added from outside its own settings, as far as Mousse
 * can see before Claude Code starts: `disableSideloadFlags` in the managed settings file, its drop-in folder or the
 * cached server-managed settings in Claude Code's home (`claudeHome`), or an enterprise `managed-mcp.json`, which takes
 * exclusive control of MCP servers. Claude Code refuses such servers at its start (`--mcp-config`) but does not check
 * the ones registered over its input, so Mousse leaves the user's servers out on every path rather than go around the
 * organisation's policy. Settings delivered by MDM or the Windows registry are not read here; Claude Code's refusal at
 * its start covers them (`CLAUDE_MCP_POLICY_CODE`).
 */
export function claudeMcpPolicyForbidsAdded(claudeHome: string | undefined, deps: { platform?: NodeJS.Platform; managedDir?: string } = {}): boolean {
  const dir = deps.managedDir ?? managedSettingsDir(deps.platform ?? process.platform)
  const forbids = (path: string): boolean => {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { disableSideloadFlags?: unknown } | null)?.disableSideloadFlags === true
    } catch {
      return false
    }
  }
  if (existsSync(join(dir, 'managed-mcp.json')) || forbids(join(dir, 'managed-settings.json'))) return true
  try {
    if (readdirSync(join(dir, 'managed-settings.d')).some((name) => name.endsWith('.json') && !name.startsWith('.') && forbids(join(dir, 'managed-settings.d', name)))) return true
  } catch {
    // No drop-in folder.
  }
  return claudeHome !== undefined && forbids(join(claudeHome, 'remote-settings.json'))
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
    // Claude Code offers a server's tools from the model's next request once it has connected, in the same turn (checked
    // with the real CLI, 2.1.291).
    [named('starting'), 'still starting; it is offered once it has connected', 'still starting; each is offered once it has connected'],
    [named('failed'), 'could not connect', 'could not connect'],
    [named('needs-auth'), 'needs you to sign in', 'need you to sign in']
  ] as const
  const said = parts.filter(([names]) => names.length > 0).map(([names, one, many]) => `${names.join(', ')} (${names.length === 1 ? one : many})`)
  return `Claude started this turn without ${left.length === 1 ? 'an MCP server' : 'some MCP servers'}: ${said.join('; ')}.`
}
