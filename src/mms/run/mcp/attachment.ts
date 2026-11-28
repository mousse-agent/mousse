import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFILER_TOOL_NAMES } from '../../../shared/diagnostics/profiler'
import { canonicalToolName } from '../../../shared/toolAliases'
import type { McpAttachment } from './MousseMcpServer'

import {
  ANTIGRAVITY_MOUSSE_TOOL_PREFIX,
  ANTIGRAVITY_RELAY_TOOL_PREFIX,
  CLAUDE_MOUSSE_TOOL_PREFIX,
  CLAUDE_RELAY_TOOL_PREFIX,
  MOUSSE_MCP_SERVER_NAME,
  MOUSSE_RELAY_SERVER_NAME,
  mousseServerToolOf
} from '../../../shared/harness/mcpNames'
export { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../shared/harness/mcpNames'
/** Environment variable that carries the bearer token to the stdio bridge (never argv). */
export const MOUSSE_MCP_TOKEN_ENV = 'MOUSSE_MCP_TOKEN'
/** Per-call timeout runtimes should allow: `question_ask` may wait up to an hour. */
export const MOUSSE_MCP_TOOL_TIMEOUT_MS = 60 * 60 * 1000
/** Per-call timeout of a relayed tool: under the stdio bridge's 300 s fetch ceiling. */
export const RELAY_CALL_TIMEOUT_MS = 4 * 60_000

export function bearerHeader(attachment: McpAttachment): string {
  return `Bearer ${attachment.token}`
}

/** How to start `mousse-cli`; overridable for packaged layouts through `MOUSSE_CLI_PATH`. */
export interface CliCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export function defaultMousseCliCommand(): CliCommand {
  const override = process.env.MOUSSE_CLI_PATH
  if (override) return { command: override, args: [], env: {} }
  // Inside Electron's main process the binary re-enters CLI mode with `--cli`.
  if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1') {
    const defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
    return { command: process.execPath, args: [...(defaultApp && process.argv[1] ? [process.argv[1]] : []), '--cli'], env: { MOUSSE_CLI: '1' } }
  }
  return { command: process.execPath, args: process.argv[1] ? [process.argv[1]] : [], env: {} }
}

/** The runtime that starts the stdio bridge: this process's executable, and the CLI bundle beside the code when there is one. */
export interface BridgeHost {
  execPath: string
  /** Electron's runtime (main mode, or plain Node when `runAsNode`). */
  electron: boolean
  runAsNode: boolean
  /** `out/cli/index.js`. */
  cliScript?: string
}

/** The CLI bundle beside the bundle that runs this code: the CLI's own folder, or `out/cli` from `out/main` (or a chunk folder below it). */
function cliBundleScript(): string | undefined {
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [join(here, '..', 'cli'), join(here, '..', '..', 'cli')]) {
    const script = join(dir, 'index.js')
    if (existsSync(script)) return script
  }
  return undefined
}

function currentBridgeHost(): BridgeHost {
  const electron = Boolean(process.versions.electron)
  const runAsNode = process.env.ELECTRON_RUN_AS_NODE === '1'
  return { execPath: process.execPath, electron, runAsNode, ...(electron && !runAsNode ? { cliScript: cliBundleScript() } : {}) }
}

/**
 * How the stdio bridge starts. On Electron's runtime it runs as plain Node, with `ELECTRON_RUN_AS_NODE=1` in its own
 * environment rather than inherited: an agent passes its own environment on to the MCP servers it starts, and
 * Antigravity's has that variable set, which makes `--cli` a bad Node option (the bridge exits at once). Electron's main
 * mode is not used for it either: there the bridge reads no stdin on Windows, so it relays nothing.
 */
export function stdioBridgeCli(host: BridgeHost = currentBridgeHost()): CliCommand {
  const cli = defaultMousseCliCommand()
  if (process.env.MOUSSE_CLI_PATH || !host.electron) return cli
  if (host.runAsNode) return { ...cli, env: { ...cli.env, ELECTRON_RUN_AS_NODE: '1' } }
  return host.cliScript ? { command: host.execPath, args: [host.cliScript], env: { ELECTRON_RUN_AS_NODE: '1' } } : cli
}

/** `mousse-cli engine mcp-stdio --url <url>` with the token in the environment. */
export function stdioBridgeCommand(attachment: McpAttachment, cli: CliCommand = stdioBridgeCli()): CliCommand {
  return {
    command: cli.command,
    args: [...cli.args, 'engine', 'mcp-stdio', '--url', attachment.url],
    env: { ...cli.env, [MOUSSE_MCP_TOKEN_ENV]: attachment.token }
  }
}

/**
 * The standalone token helper beside a Node-hosted CLI bundle (`out/cli/chatgpt-token.js`), when
 * there is one: Node runs it without loading the CLI bundle and every package it imports.
 */
export function standaloneChatgptTokenScript(): string | undefined {
  if (process.env.MOUSSE_CLI_PATH || (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1')) return undefined
  const script = process.argv[1] ? join(dirname(process.argv[1]), 'chatgpt-token.js') : undefined
  return script && existsSync(script) ? script : undefined
}

/** `mousse-cli engine chatgpt-token <endpoint> <leaseId>`: a managed Codex's `auth.command`. */
export function chatgptTokenCommand(endpoint: string, leaseId: string, cli?: CliCommand): CliCommand {
  const script = cli ? undefined : standaloneChatgptTokenScript()
  if (script) return { command: process.execPath, args: [script, endpoint, leaseId], env: {} }
  const command = cli ?? defaultMousseCliCommand()
  return { command: command.command, args: [...command.args, 'engine', 'chatgpt-token', endpoint, leaseId], env: { ...command.env } }
}

/**
 * Claude Code's MCP servers for the Mousse server (SPEC §15.2): over HTTP, or none. They are registered over Claude
 * Code's input once it starts (`registerClaudeMcpServers`), never passed as the Agent SDK's `mcpServers` option, which
 * would put the bearer on its command line (#358).
 */
export function claudeMcpServers(attachment: McpAttachment | null | undefined): Record<string, {
  type: 'http'
  url: string
  headers: Record<string, string>
  timeout: number
}> {
  if (!attachment) return {}
  return {
    [MOUSSE_MCP_SERVER_NAME]: {
      type: 'http',
      url: attachment.url,
      headers: { Authorization: bearerHeader(attachment) },
      timeout: MOUSSE_MCP_TOOL_TIMEOUT_MS
    },
    ...(attachment.relay
      ? {
          [MOUSSE_RELAY_SERVER_NAME]: {
            type: 'http' as const,
            url: attachment.relay.url,
            headers: { Authorization: bearerHeader(attachment) },
            // Longer than the relay's own call timeout, so the model gets the relay's timeout result.
            timeout: MOUSSE_MCP_TOOL_TIMEOUT_MS
          }
        }
      : {})
  }
}

/** Cursor SDK `mcpServers` (SPEC §15.2): the Mousse server over HTTP, or none. */
export function cursorMcpServers(attachment: McpAttachment | null | undefined): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  if (!attachment) return {}
  return {
    [MOUSSE_MCP_SERVER_NAME]: { type: 'http', url: attachment.url, headers: { Authorization: bearerHeader(attachment) } },
    ...(attachment.relay
      ? { [MOUSSE_RELAY_SERVER_NAME]: { type: 'http' as const, url: attachment.relay.url, headers: { Authorization: bearerHeader(attachment) } } }
      : {})
  }
}

// The name rules live in shared code, so the renderer reads a call's name the same way.
export { ANTIGRAVITY_MOUSSE_TOOL_PREFIX, ANTIGRAVITY_RELAY_TOOL_PREFIX, CLAUDE_MOUSSE_TOOL_PREFIX, CLAUDE_RELAY_TOOL_PREFIX, mousseServerToolOf }

/**
 * While the thread has a question pending, whether a call named `toolName` may be the one asking it: a relayed tool
 * (its approval), or a Mousse tool that asks the person (`asksUser`: `question_ask`, a quick action's approval) or asks
 * before it edits (`editsWorkspace`, `changesSettings`), by its exact name in `lookup`. A tool `lookup` does not know counts only in the
 * exact MCP form (`mcp__mousse__<tool>`, a Mousse tool newer than the registry); in a looser form, or as a bare name,
 * an unknown tool is no Mousse call, and it runs as any call does.
 */
export function mousseCallAsksPerson(
  toolName: string,
  lookup: (tool: string) => { asksUser?: unknown; access?: string } | undefined
): boolean {
  const served = mousseServerToolOf(toolName)
  if (served?.server === 'relay') return true
  // An old name (`ask_user`) is still callable and old transcripts have it: it asks as its tool does.
  const tool = lookup(canonicalToolName(served ? served.tool : toolName))
  if (!tool) return served?.exact === true
  return Boolean(tool.asksUser) || tool.access === 'editsWorkspace' || tool.access === 'changesSettings'
}

/** A tool of a server Mousse serves (`mcp__mousse__*`, `mcp__mousse-relay__*`, `mcp_mousse_*` or `mcp_mousse-relay_*`): its calls reach Mousse. */
export function isMousseServerTool(toolName: string): boolean {
  return (
    toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX) ||
    toolName.startsWith(CLAUDE_RELAY_TOOL_PREFIX) ||
    toolName.startsWith(ANTIGRAVITY_MOUSSE_TOOL_PREFIX) ||
    toolName.startsWith(ANTIGRAVITY_RELAY_TOOL_PREFIX)
  )
}

/**
 * The Mousse tools a read-only (`shared`) delegated child may call, by name without the prefix:
 * the listed `reads` and `readsOthers` tools and the `readOnlySafe` ones of the app-tool registry (a test keeps them equal).
 * Runtimes that decide per tool name use it; the server refuses the rest in any case (and `thread_create`'s kind
 * `thread`, which a read-only child lacks: its kind `subagent` is a reader's too).
 */
export const READ_ONLY_MOUSSE_TOOLS: ReadonlySet<string> = new Set(['thread_read', 'thread_list', 'thread_search', 'thread_wait', 'queue_list', 'question_ask', 'question_withdraw', 'thread_create', 'continue_subagent', 'recall_subagent', 'request_answer', 'task_status', 'task_cancel', 'list_subagents', 'list_delegations', 'message_parent', 'computer_list', 'model_list', 'skill_list', 'skill_load', 'web_search', 'web_fetch', 'git_status', 'git_diff', 'theme_read', 'terminal_read', 'read_applet', 'running_list', 'tool_catalogue', ...PROFILER_TOOL_NAMES])

export type AcpMcpServer =
  | { name: string; type: 'http'; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }

/**
 * ACP `session/new` / `session/resume` `mcpServers` (SPEC §15.2): HTTP when the agent's
 * `initialize` advertised `mcpCapabilities.http`, else the stdio bridge (every ACP agent must
 * support stdio servers).
 */
export function acpMcpServers(
  attachment: McpAttachment | null | undefined,
  options: { http: boolean; cli?: CliCommand }
): AcpMcpServer[] {
  if (!attachment) return []
  const relay = attachment.relay ? { ...attachment, url: attachment.relay.url } : null
  if (options.http) {
    const servers: AcpMcpServer[] = [{ name: MOUSSE_MCP_SERVER_NAME, type: 'http', url: attachment.url, headers: [{ name: 'Authorization', value: bearerHeader(attachment) }] }]
    if (relay) servers.push({ name: MOUSSE_RELAY_SERVER_NAME, type: 'http', url: relay.url, headers: [{ name: 'Authorization', value: bearerHeader(attachment) }] })
    return servers
  }
  const servers = [acpStdioServer(MOUSSE_MCP_SERVER_NAME, attachment, options.cli)]
  // The relay runs a second stdio bridge, pointed at the relay's path on the same listener.
  if (relay) servers.push(acpStdioServer(MOUSSE_RELAY_SERVER_NAME, relay, options.cli))
  return servers
}

function acpStdioServer(name: string, attachment: McpAttachment, cli: CliCommand | undefined): AcpMcpServer {
  const bridge = stdioBridgeCommand(attachment, cli)
  return {
    name,
    command: bridge.command,
    args: bridge.args,
    env: Object.entries(bridge.env).map(([name, value]) => ({ name, value }))
  }
}

/**
 * Codex config overrides attaching the Mousse server (SPEC §15.2): dotted `mcp_servers.mousse.*`
 * keys, the same keys `codex -c key=value` takes. The Codex adapter sends them as the `config` of
 * `thread/start` / `thread/resume`, so each thread gets its own run token and the token never
 * appears in a process argument list. Mousse tools are pre-approved (`approve`): the server itself
 * scopes every call to the run's credential, as for Claude. The relay's tools are pre-approved too:
 * Codex has no approval request for MCP tools Mousse handles, so the relay asks through its own cards.
 */
export function codexMcpConfigOverrides(attachment: McpAttachment | null | undefined): Record<string, string | number | Record<string, string>> {
  if (!attachment) return {}
  const prefix = `mcp_servers.${MOUSSE_MCP_SERVER_NAME}`
  return {
    [`${prefix}.url`]: attachment.url,
    [`${prefix}.http_headers`]: { Authorization: bearerHeader(attachment) },
    [`${prefix}.tool_timeout_sec`]: MOUSSE_MCP_TOOL_TIMEOUT_MS / 1000,
    [`${prefix}.default_tools_approval_mode`]: 'approve',
    ...(attachment.relay ? codexRelayOverrides(attachment, attachment.relay) : {})
  }
}

function codexRelayOverrides(attachment: McpAttachment, relay: NonNullable<McpAttachment['relay']>): Record<string, string | number | Record<string, string>> {
  const prefix = `mcp_servers.${MOUSSE_RELAY_SERVER_NAME}`
  return {
    [`${prefix}.url`]: relay.url,
    [`${prefix}.http_headers`]: { Authorization: bearerHeader(attachment) },
    // As long as Mousse's own: Codex counts the time the user takes on the relay's approval card,
    // and the relay's own call timeout starts only once the call is approved.
    [`${prefix}.tool_timeout_sec`]: MOUSSE_MCP_TOOL_TIMEOUT_MS / 1000,
    [`${prefix}.default_tools_approval_mode`]: 'approve'
  }
}
