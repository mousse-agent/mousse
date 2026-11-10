import type { ThreadConfig } from './protocol'

/**
 * Codex features that each add native tools, as `codex features list` names them (checked on Codex
 * 0.167): commands (`unified_exec`, `shell_tool`), images, subagents, apps and plugins, the browsers
 * and computer use, goals, memories, skills and tool suggestions, plus hooks, which run commands of
 * the user's. A one-shot turns every one off. Codex ignores a name it does not know, so an older
 * Codex accepts the list.
 */
export const CODEX_ONE_SHOT_FEATURES_OFF: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'sleep_tool',
  'tool_suggest',
  'skill_search',
  'memories',
  'goals'
]

/**
 * The thread config of a one-shot: every feature above off, web search off, and every MCP server the
 * user's Codex setup has on turned off, Mousse's own server names included. Undefined when that setup
 * could not be read (`mcpServers` null) or a server's name cannot be written as a config key: the
 * one-shot is then refused rather than run with a server possibly on.
 *
 * What config cannot turn off comes from the model's own entry in Codex's catalog: `apply_patch` on the
 * models that have it, the code-mode `exec` tool (a JavaScript isolate with no file system or network,
 * calling only the tools left) and `v2` subagent tools. The read-only sandbox with no approvals refuses
 * every write (`apply_patch` answers "patch rejected"); a model with `v2` subagents never runs a
 * one-shot (`codexOneShotRunsOn`); and `CODEX_ONE_SHOT_ITEMS` ends the request on any tool call Codex
 * reports. No config setting stops a native tool before Codex dispatches it: `disabled_tools` covers
 * MCP servers and apps only, `agents.max_depth = 0` still spawns, and `model_catalog_json` needs a
 * complete catalog entry per Codex version.
 */
export function codexOneShotConfig(mcpServers: readonly string[] | null): ThreadConfig | undefined {
  if (mcpServers === null) return undefined
  const config: ThreadConfig = { web_search: 'disabled' }
  for (const feature of CODEX_ONE_SHOT_FEATURES_OFF) config[`features.${feature}`] = false
  for (const name of mcpServers) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined
    config[`mcp_servers.${name}.enabled`] = false
  }
  return config
}

/**
 * Whether a model can run a one-shot, by its subagent tools (Codex's `multiAgentVersion`). With none
 * (null) or `v1`, the `multi_agent` feature the one-shot turns off removes them. `v2` comes from the
 * model's catalog entry and stays on whatever the config says, and its `spawn_agent` starts a child
 * thread and its model request before Codex reports the call, so such a model never runs one. A
 * version Mousse does not know, or a listing that does not say, counts as `v2`.
 */
export function codexOneShotRunsOn(multiAgentVersion: unknown): boolean {
  return multiAgentVersion === null || multiAgentVersion === 'v1'
}

/** The items a one-shot may produce. Any other item (a command, a file change, a tool, a subagent) ends it as refused. */
export const CODEX_ONE_SHOT_ITEMS: ReadonlySet<string> = new Set(['userMessage', 'agentMessage', 'reasoning'])
