import type { McpServerConfig } from '../../../shared/integrations'
import type { McpAttachment } from './MousseMcpServer'

/** Name of the Mousse server in every runtime's MCP configuration; tools appear as `mcp__mousse__*`. */
export const MOUSSE_MCP_SERVER_NAME = 'mousse'
/** Environment variable that carries the bearer token to the stdio bridge (never argv). */
export const MOUSSE_MCP_TOKEN_ENV = 'MOUSSE_MCP_TOKEN'
/** Per-call timeout runtimes should allow: `ask_user` may wait up to an hour. */
export const MOUSSE_MCP_TOOL_TIMEOUT_MS = 60 * 60 * 1000

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
    }
  }
}

/** Tool-name prefix Claude gives the Mousse server's tools. */
export const CLAUDE_MOUSSE_TOOL_PREFIX = `mcp__${MOUSSE_MCP_SERVER_NAME}__`

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
  if (options.http)
    return [{ name: MOUSSE_MCP_SERVER_NAME, type: 'http', url: attachment.url, headers: [{ name: 'Authorization', value: bearerHeader(attachment) }] }]
  const bridge = stdioBridgeCommand(attachment, options.cli)
  return [{
    name: MOUSSE_MCP_SERVER_NAME,
    command: bridge.command,
    args: bridge.args,
    env: Object.entries(bridge.env).map(([name, value]) => ({ name, value }))
  }]
}

/**
 * The Mousse server as an integration `McpServerConfig` for CLI children (`AgentConfigManager`).
 * Every supported CLI (claude-code, codex, opencode, cursor) takes Streamable HTTP; the
 * materialiser moves the literal `Authorization` header into an environment variable.
 */
export function mousseMcpServerConfig(attachment: McpAttachment): McpServerConfig {
  return {
    id: MOUSSE_MCP_SERVER_NAME,
    name: MOUSSE_MCP_SERVER_NAME,
    source: 'mousse',
    scope: 'generated',
    transport: 'http',
    status: 'configured',
    enabled: true,
    url: attachment.url,
    headers: { Authorization: bearerHeader(attachment) }
  }
}
