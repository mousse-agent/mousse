import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, MousseIntegrationsSettings, SkillDescriptor } from '../../../../shared/integrations'
import type { McpToolCallResult } from '../../../../shared/integrations/results'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import { resolveEffectiveMcpServers, resolveEffectiveSkills } from '../../../integrations/catalog/EffectiveIntegrationResolver'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { McpRegistry } from '../../../integrations/mcp/McpRegistry'
import { shortHash } from '../../../integrations/revision'
import type { IntegrationSecretAdapter } from '../../../integrations/secrets'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import { MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME } from '../../../run/mcp/attachment'

/** A user MCP server in the Claude Agent SDK `mcpServers` shape. Values hold `${VAR}` references only. */
export type ClaudeUserMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

/** Per-server tool limits, keyed by the `mcp__<server>__` prefix Claude gives that server's tools. */
export type ClaudeMcpToolRules = Record<string, { enabled?: string[]; denied?: string[] }>

/**
 * A server Claude reaches through Mousse's own connection. Used for servers that sign in with
 * OAuth: Mousse holds and refreshes that session, and Claude has no way to take it over.
 */
export interface ClaudeProxiedMcpServer {
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>
}

/** What one Claude turn gets from the user's Mousse integrations. */
export interface ClaudeTurnIntegrations {
  mcpServers: Record<string, ClaudeUserMcpServer>
  /** Servers Mousse stays connected to on Claude's behalf, by the name Claude sees. */
  proxiedServers: Record<string, ClaudeProxiedMcpServer>
  /** Resolved secret values the `${VAR}` references in `mcpServers` point at. */
  env: Record<string, string>
  toolRules: ClaudeMcpToolRules
  /** Local Claude plugin directory holding the enabled skills; absent when there are none. */
  pluginPath?: string
  /** Why an enabled server or skill was left out. */
  warnings: string[]
}

export interface ClaudeIntegrationSource {
  resolve(projectPath?: string): Promise<ClaudeTurnIntegrations>
}

/** Name of the generated plugin; Claude lists its skills as `mousse:<skill>`. */
export const CLAUDE_SKILLS_PLUGIN_NAME = 'mousse'
const PLUGIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SKILL_FILES = 10_000
const MAX_SKILL_BYTES = 100 * 1024 * 1024

/**
 * Whether Claude Code loads this skill itself: one in the project's `.claude/skills`, or in
 * `~/.claude/skills` while Claude Code keeps its config in `~/.claude` (no `CLAUDE_CONFIG_DIR`).
 */
export function claudeLoadsSkill(skill: Pick<SkillDescriptor, 'source'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return skill.source === 'claude-project' || (skill.source === 'claude-global' && !env.CLAUDE_CONFIG_DIR)
}

export function claudeMcpToolBlocked(rules: ClaudeMcpToolRules | undefined, toolName: string): boolean {
  for (const [prefix, rule] of Object.entries(rules ?? {})) {
    if (!toolName.startsWith(prefix)) continue
    const tool = toolName.slice(prefix.length)
    if (rule.denied?.includes(tool)) return true
    if (rule.enabled?.length && !rule.enabled.includes(tool)) return true
  }
  return false
}

/** The in-process server the Claude Agent SDK runs for a proxied server; its tools call Mousse. */
export function claudeProxiedMcpServer(name: string, proxied: ClaudeProxiedMcpServer): McpSdkServerConfigWithInstance {
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: proxied.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: { type: 'object' as const, ...tool.inputSchema }
    }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await proxied.call(request.params.name, request.params.arguments ?? {}, extra.signal)
      return {
        isError: result.isError,
        content: [
          { type: 'text' as const, text: result.text },
          ...result.content.flatMap((block) => block.type === 'image' && block.data
            ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }]
            : [])
        ]
      }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: message(error) }] }
    }
  })
  // The SDK only connects a transport to the instance, which the low-level server supports too.
  return { type: 'sdk', name, instance: server as unknown as McpSdkServerConfigWithInstance['instance'] }
}

/**
 * Resolves the MCP servers and skills the user enabled in Mousse for the main agent into what the
 * Claude Agent SDK takes. Claude Code also loads the user's own configuration (settings, MCP
 * servers, plugins, `~/.claude/skills` and `<project>/.claude/skills`), so these are added on top.
 * Skills Mousse found in Claude Code's own skill folders are left out: Claude Code already loads
 * them, and passing them again would list each one twice.
 */
export class ClaudeIntegrationResolver implements ClaudeIntegrationSource {
  constructor(private readonly deps: {
    mcpRegistry: Pick<McpRegistry, 'discover'>
    /** Mousse's live MCP connections; without it OAuth servers are left out. */
    mcpManager?: Pick<McpManager, 'getEnabledToolsForServer' | 'callTool'>
    skillsRegistry: Pick<SkillsRegistry, 'discover'>
    settings: { get(): { integrations: MousseIntegrationsSettings } }
    secrets: IntegrationSecretAdapter
    /** Directory for generated skill plugins, owned by Mousse. */
    pluginRoot: string
    /**
     * The environment the instance starts Claude Code with (its `InstanceEnv`), which decides
     * whether Claude loads `~/.claude/skills` itself; default `process.env`.
     */
    env?: () => NodeJS.ProcessEnv
  }) {}

  async resolve(projectPath?: string): Promise<ClaudeTurnIntegrations> {
    const settings = this.deps.settings.get().integrations
    // A Claude Subscription thread is the main agent, as on every other chat provider.
    const actor: IntegrationActor = { kind: 'main' }
    const result: ClaudeTurnIntegrations = { mcpServers: {}, proxiedServers: {}, env: {}, toolRules: {}, warnings: [] }

    try {
      const snapshot = await this.deps.mcpRegistry.discover({ projectPath, redactSecrets: false })
      await this.addServers(resolveEffectiveMcpServers({ servers: snapshot.servers, settings: settings.mcp, actor }), result, projectPath, actor)
    } catch (error) {
      result.warnings.push(`MCP servers were not attached: ${message(error)}`)
    }

    try {
      const snapshot = await this.deps.skillsRegistry.discover({ projectPath })
      const skills = resolveEffectiveSkills({ snapshot, settings: settings.skills, actor }).filter((skill) => !claudeLoadsSkill(skill, this.deps.env?.()))
      if (skills.length > 0) result.pluginPath = await this.buildPlugin(skills, result.warnings)
    } catch (error) {
      result.warnings.push(`Skills were not attached: ${message(error)}`)
    }
    return result
  }

  private async addServers(
    servers: McpServerConfig[],
    result: ClaudeTurnIntegrations,
    projectPath: string | undefined,
    actor: IntegrationActor
  ): Promise<void> {
    // The names Mousse's own servers take: a user server never shadows one, nor is shadowed by one.
    const used = new Set<string>([MOUSSE_MCP_SERVER_NAME, MOUSSE_RELAY_SERVER_NAME])
    let variable = 0
    // Secrets travel in the environment: the SDK puts the server list on Claude's command line.
    const indirect = (record: Record<string, string> | undefined): Record<string, string> | undefined => {
      const entries = Object.entries(record ?? {}).flatMap(([key, value]) => {
        const resolved = this.deps.secrets.resolveEnv(value)
        if (!resolved) return []
        const name = `MOUSSE_MCP_VALUE_${variable++}`
        result.env[name] = resolved
        return [[key, `\${${name}}`] as const]
      })
      return entries.length > 0 ? Object.fromEntries(entries) : undefined
    }
    // Claude builds tool names from the server name, so keep it to the characters it preserves.
    const claim = (server: McpServerConfig): string => {
      const base = server.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'server'
      const name = used.has(base) ? `${base}_${shortHash(server.installationId ?? server.id)}` : base
      used.add(name)
      return name
    }
    for (const server of servers) {
      if (server.authMode === 'oauth') {
        const proxied = await this.proxy(server, projectPath, actor, result.warnings)
        if (proxied) result.proxiedServers[claim(server)] = proxied
        continue
      }
      if (server.status === 'missing-env' || (server.missingEnvVars?.length ?? 0) > 0) {
        result.warnings.push(`MCP server ${server.name} is missing environment: ${(server.missingEnvVars ?? []).join(', ')}`)
        continue
      }
      let entry: ClaudeUserMcpServer
      if (server.transport === 'stdio') {
        if (!server.command) {
          result.warnings.push(`MCP server ${server.name} has no command.`)
          continue
        }
        const env = indirect(server.env)
        entry = { type: 'stdio', command: server.command, ...(server.args?.length ? { args: server.args } : {}), ...(env ? { env } : {}) }
      } else {
        if (!server.url) {
          result.warnings.push(`MCP server ${server.name} has no URL.`)
          continue
        }
        const headers = indirect(server.headers)
        entry = { type: server.transport, url: server.url, ...(headers ? { headers } : {}) }
      }
      const name = claim(server)
      result.mcpServers[name] = entry
      if (server.enabledTools?.length || server.deniedTools?.length)
        result.toolRules[`mcp__${name}__`] = {
          ...(server.enabledTools?.length ? { enabled: server.enabledTools } : {}),
          ...(server.deniedTools?.length ? { denied: server.deniedTools } : {})
        }
    }
  }

  /** Lists an OAuth server's tools over Mousse's signed-in connection and routes calls back to it. */
  private async proxy(
    server: McpServerConfig,
    projectPath: string | undefined,
    actor: IntegrationActor,
    warnings: string[]
  ): Promise<ClaudeProxiedMcpServer | undefined> {
    const manager = this.deps.mcpManager
    if (!manager) {
      warnings.push(`MCP server ${server.name} signs in with OAuth through Mousse, which is not available here.`)
      return undefined
    }
    try {
      // Listing never opens a browser: a server that is not signed in fails here instead.
      const tools = await manager.getEnabledToolsForServer(server.installationId ?? server.id, projectPath, actor)
      if (tools.length === 0) {
        warnings.push(`MCP server ${server.name} has no tools enabled.`)
        return undefined
      }
      const providerNames = new Map(tools.map((tool) => [tool.toolName, tool.providerName]))
      return {
        tools: tools.map((tool) => ({
          name: tool.toolName,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
        })),
        // The manager checks the user's settings again on every call, so a tool turned off mid-turn stops working.
        call: (toolName, args, signal) => {
          const providerName = providerNames.get(toolName)
          if (!providerName) throw new Error(`Unknown tool: ${toolName}`)
          return manager.callTool(providerName, args, projectPath, signal, actor)
        }
      }
    } catch (error) {
      warnings.push(`MCP server ${server.name} was not attached: ${message(error)}`)
      return undefined
    }
  }

  /**
   * Copies the skills into `<pluginRoot>/<fingerprint>/skills/<name>`. The directory is immutable
   * and named by its content, so turns with the same skills share it and a running turn never sees
   * a half-written or changing plugin.
   */
  private async buildPlugin(skills: SkillDescriptor[], warnings: string[]): Promise<string | undefined> {
    const included: Array<{ directory: string; skill: SkillDescriptor; stamp: string }> = []
    const used = new Set<string>()
    for (const skill of skills) {
      const base = skill.name.replace(/[^A-Za-z0-9_-]/g, '-') || 'skill'
      const directory = used.has(base) ? `${base}-${shortHash(skill.installationId ?? skill.id)}` : base
      try {
        included.push({ directory, skill, stamp: await skillStamp(skill.rootPath) })
        used.add(directory)
      } catch (error) {
        warnings.push(`Skill ${skill.name} was not attached: ${message(error)}`)
      }
    }
    if (included.length === 0) return undefined
    const fingerprint = shortHash(JSON.stringify(included.map(({ directory, skill, stamp }) => [directory, skill.rootPath, stamp])), 16)
    const target = join(this.deps.pluginRoot, fingerprint)
    if (!existsSync(target)) {
      const staging = `${target}.${process.pid}.${Date.now()}.tmp`
      try {
        await mkdir(join(staging, '.claude-plugin'), { recursive: true })
        await writeFile(join(staging, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
          name: CLAUDE_SKILLS_PLUGIN_NAME,
          description: 'Skills enabled in Mousse. Generated; do not edit.',
          version: '1.0.0'
        }, null, 2)}\n`)
        for (const { directory, skill } of included)
          await cp(skill.rootPath, join(staging, 'skills', directory), { recursive: true })
        await rename(staging, target)
      } catch (error) {
        await rm(staging, { recursive: true, force: true })
        // Another turn published the same content first.
        if (!existsSync(target)) throw error
      }
    }
    const now = new Date()
    await utimes(target, now, now).catch(() => {})
    await this.prunePlugins(fingerprint)
    return target
  }

  /** Removes generated plugins no turn has used for a week. */
  private async prunePlugins(keep: string): Promise<void> {
    for (const entry of await readdir(this.deps.pluginRoot).catch(() => [] as string[])) {
      if (entry === keep) continue
      const path = join(this.deps.pluginRoot, entry)
      const details = await lstat(path).catch(() => null)
      if (details?.isDirectory() && Date.now() - details.mtimeMs > PLUGIN_MAX_AGE_MS)
        await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** A change stamp for a skill folder; refuses symlinks and oversized packages, as other runtimes do. */
async function skillStamp(root: string): Promise<string> {
  const parts: string[] = []
  let files = 0
  let bytes = 0
  const visit = async (path: string, relative: string): Promise<void> => {
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error(`it contains a symlink (${relative || '.'})`)
    if (details.isFile()) {
      files += 1
      bytes += details.size
      if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error('it is too large')
      parts.push(`${relative}:${details.size}:${details.mtimeMs}`)
      return
    }
    if (!details.isDirectory()) throw new Error(`it contains an unsupported entry (${relative})`)
    for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), relative ? `${relative}/${entry}` : entry)
  }
  await visit(root, '')
  return shortHash(parts.join('\n'), 16)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
