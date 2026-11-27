/** Name of Mousse's own MCP server in every runtime. */
export const MOUSSE_MCP_SERVER_NAME = 'mousse'
/** Name of the MCP relay Mousse supplies to a runtime. */
export const MOUSSE_RELAY_SERVER_NAME = 'mousse-relay'

/** Tool-name prefix Claude gives the Mousse server's tools. */
export const CLAUDE_MOUSSE_TOOL_PREFIX = `mcp__${MOUSSE_MCP_SERVER_NAME}__`
/** Tool-name prefix Claude gives the MCP relay's tools. Never auto-allowed: the runtime's approvals apply. */
export const CLAUDE_RELAY_TOOL_PREFIX = `mcp__${MOUSSE_RELAY_SERVER_NAME}__`
/** Tool-name prefix Antigravity (`agy acp`) gives the Mousse server's tools. */
export const ANTIGRAVITY_MOUSSE_TOOL_PREFIX = `mcp_${MOUSSE_MCP_SERVER_NAME}_`
/** Tool-name prefix Antigravity (`agy acp`) gives the MCP relay's tools. */
export const ANTIGRAVITY_RELAY_TOOL_PREFIX = `mcp_${MOUSSE_RELAY_SERVER_NAME}_`

/**
 * OpenCode's name of a Mousse tool. OpenCode names an MCP tool `<server>_<tool>` (2.0: `tool/runtime.ts`
 * `effectiveName`, `tool/mcp.ts` `namespace`), and Mousse gives each thread its own servers, `mousse_<12 hex>` and
 * `mousse_<12 hex>_relay` (`opencode/rules.ts` `mousseServerName`). Group 1 is a relayed tool, group 2 a Mousse tool.
 */
const OPENCODE_TOOL = /^mousse_[0-9a-f]{12}_(?:relay_([A-Za-z0-9_]+)|([a-z][a-z0-9_]*))$/

/**
 * Which server Mousse serves a call's tool name belongs to, and the tool's own name there, however the runtime names
 * an MCP call: `mcp__mousse__ask_user` (Claude, Codex, Cursor), `mcp_mousse_ask_user` (Antigravity),
 * `mousse_<12 hex>_ask_user` (OpenCode, see `OPENCODE_TOOL`), and the forms
 * some ACP agents use, `mousse__ask_user`, `mousse.ask_user`, `mousse/ask_user`, `mousse: ask_user` or
 * `ask_user (mousse MCP Server)`. The server's name is matched exactly (lower case, as Mousse names it). A Mousse
 * tool's name must be snake case, as Mousse's tools are, so a title such as `Mousse.md` is no Mousse call; a relayed
 * tool's may be any of letters, digits and `_`, as the relay names it (`github__createIssue`). `exact`: the
 * `mcp__<server>__`, `mcp_<server>_` or OpenCode form, which only an MCP call has.
 * Undefined for any other name, a bare tool name included.
 */
export function mousseServerToolOf(toolName: string): { server: 'mousse' | 'relay'; tool: string; exact: boolean } | undefined {
  const name = toolName.trim()
  if (name.startsWith(CLAUDE_RELAY_TOOL_PREFIX)) return { server: 'relay', tool: name.slice(CLAUDE_RELAY_TOOL_PREFIX.length), exact: true }
  if (name.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX)) return { server: 'mousse', tool: name.slice(CLAUDE_MOUSSE_TOOL_PREFIX.length), exact: true }
  if (name.startsWith(ANTIGRAVITY_RELAY_TOOL_PREFIX)) {
    const tool = name.slice(ANTIGRAVITY_RELAY_TOOL_PREFIX.length)
    if (/^[A-Za-z0-9_]+$/.test(tool)) return { server: 'relay', tool, exact: true }
  }
  if (name.startsWith(ANTIGRAVITY_MOUSSE_TOOL_PREFIX)) {
    const tool = name.slice(ANTIGRAVITY_MOUSSE_TOOL_PREFIX.length)
    if (/^[a-z][a-z0-9_]*$/.test(tool)) return { server: 'mousse', tool, exact: true }
  }
  const opencode = OPENCODE_TOOL.exec(name)
  if (opencode) return opencode[1] !== undefined ? { server: 'relay', tool: opencode[1], exact: true } : { server: 'mousse', tool: opencode[2]!, exact: true }
  // A relayed tool keeps its integration's spelling, capitals included (`sanitizeToolNamePart`: letters, digits, `_`).
  const relay = /^mousse-relay(?:__|[./:] ?)([A-Za-z0-9_]+)$/.exec(name) ?? /^([A-Za-z0-9_]+) \(mousse-relay MCP Server\)$/.exec(name)
  if (relay) return { server: 'relay', tool: relay[1]!, exact: false }
  const own = /^mousse(?:__|[./:] ?)([a-z][a-z0-9_]*)$/.exec(name) ?? /^([a-z][a-z0-9_]*) \(mousse MCP Server\)$/.exec(name)
  return own ? { server: 'mousse', tool: own[1]!, exact: false } : undefined
}
