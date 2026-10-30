import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpAttachment } from './MousseMcpServer'

/** Name of the Mousse server in every runtime's MCP configuration; tools appear as `mcp__mousse__*`. */
export const MOUSSE_MCP_SERVER_NAME = 'mousse'
/** Environment variable that carries the bearer token to the stdio bridge (never argv). */
export const MOUSSE_MCP_TOKEN_ENV = 'MOUSSE_MCP_TOKEN'
/** Per-call timeout runtimes should allow: `ask_user` may wait up to an hour. */
export const MOUSSE_MCP_TOOL_TIMEOUT_MS = 60 * 60 * 1000
/** Name of the MCP relay in a runtime's MCP configuration: the user's Mousse MCP servers, relayed. */
export const MOUSSE_RELAY_SERVER_NAME = 'mousse-relay'
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

/** `mousse-cli engine mcp-stdio --url <url>` with the token in the environment. */
export function stdioBridgeCommand(attachment: McpAttachment, cli: CliCommand = defaultMousseCliCommand()): CliCommand {
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

/** Claude Agent SDK `mcpServers` (SPEC §15.2): the Mousse server over HTTP, or none. */
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
            timeout: RELAY_CALL_TIMEOUT_MS
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

/** Tool-name prefix Claude gives the Mousse server's tools. */
export const CLAUDE_MOUSSE_TOOL_PREFIX = `mcp__${MOUSSE_MCP_SERVER_NAME}__`
/** Tool-name prefix Claude gives the MCP relay's tools. Never auto-allowed: the runtime's approvals apply. */
export const CLAUDE_RELAY_TOOL_PREFIX = `mcp__${MOUSSE_RELAY_SERVER_NAME}__`

/** A tool of a server Mousse serves (`mcp__mousse__*` or `mcp__mousse-relay__*`): its calls reach Mousse. */
export function isMousseServerTool(toolName: string): boolean {
  return toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX) || toolName.startsWith(CLAUDE_RELAY_TOOL_PREFIX)
}

/**
 * The Mousse tools a read-only (`shared`) delegated child may call, by name without the prefix:
 * the listed `reads` and `readsOthers` tools and the `readOnlySafe` ones of the app-tool registry (a test keeps them equal).
 * Runtimes that decide per tool name use it; the server refuses the rest in any case.
 */
export const READ_ONLY_MOUSSE_TOOLS: ReadonlySet<string> = new Set(['thread_read', 'thread_list', 'thread_search', 'thread_wait', 'queue_list', 'ask_user', 'present_plan', 'delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'list_subagents', 'list_skills', 'load_skill', 'web_search', 'web_fetch', 'git_status', 'git_diff'])

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
    [`${prefix}.tool_timeout_sec`]: RELAY_CALL_TIMEOUT_MS / 1000,
    [`${prefix}.default_tools_approval_mode`]: 'approve'
  }
}
