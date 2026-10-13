import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerConfig, MousseIntegrationsSettings, SkillDescriptor } from '../../../shared/integrations'
import type { IntegrationActor } from '../../../shared/integrations/actor'
import { resolveEffectiveMcpServers, resolveEffectiveSkills } from '../../integrations/catalog/EffectiveIntegrationResolver'
import type { McpRegistry } from '../../integrations/mcp/McpRegistry'
import { shortHash } from '../../integrations/revision'
import type { IntegrationSecretAdapter } from '../../integrations/secrets'
import type { SkillsRegistry } from '../../integrations/skills/SkillsRegistry'
import { MOUSSE_MCP_SERVER_NAME } from '../../run/mcp/attachment'

/** A user MCP server in the Claude Agent SDK `mcpServers` shape. Values hold `${VAR}` references only. */
export type ClaudeUserMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

/** Per-server tool limits, keyed by the `mcp__<server>__` prefix Claude gives that server's tools. */
export type ClaudeMcpToolRules = Record<string, { enabled?: string[]; denied?: string[] }>

/** What one Claude turn gets from the user's Mousse integrations. */
export interface ClaudeTurnIntegrations {
  mcpServers: Record<string, ClaudeUserMcpServer>
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

export function claudeMcpToolBlocked(rules: ClaudeMcpToolRules | undefined, toolName: string): boolean {
  for (const [prefix, rule] of Object.entries(rules ?? {})) {
    if (!toolName.startsWith(prefix)) continue
    const tool = toolName.slice(prefix.length)
    if (rule.denied?.includes(tool)) return true
    if (rule.enabled?.length && !rule.enabled.includes(tool)) return true
  }
  return false
}

/**
 * Resolves the MCP servers and skills the user enabled in Mousse for the main agent into what the
 * Claude Agent SDK takes. The SDK launches with `settingSources: []` and `strict-mcp-config`, so
 * Claude sees only what is passed here.
 */
export class ClaudeIntegrationResolver implements ClaudeIntegrationSource {
  constructor(private readonly deps: {
    mcpRegistry: Pick<McpRegistry, 'discover'>
    skillsRegistry: Pick<SkillsRegistry, 'discover'>
    settings: { get(): { integrations: MousseIntegrationsSettings } }
    secrets: IntegrationSecretAdapter
    /** Directory for generated skill plugins, owned by Mousse. */
    pluginRoot: string
  }) {}

  async resolve(projectPath?: string): Promise<ClaudeTurnIntegrations> {
    const settings = this.deps.settings.get().integrations
    // A Claude Subscription thread is the main agent, as on every other chat provider.
    const actor: IntegrationActor = { kind: 'main' }
    const result: ClaudeTurnIntegrations = { mcpServers: {}, env: {}, toolRules: {}, warnings: [] }

    try {
      const snapshot = await this.deps.mcpRegistry.discover({ projectPath, redactSecrets: false })
      this.addServers(resolveEffectiveMcpServers({ servers: snapshot.servers, settings: settings.mcp, actor }), result)
    } catch (error) {
      result.warnings.push(`MCP servers were not attached: ${message(error)}`)
    }

    try {
      const snapshot = await this.deps.skillsRegistry.discover({ projectPath })
      const skills = resolveEffectiveSkills({ snapshot, settings: settings.skills, actor })
      if (skills.length > 0) result.pluginPath = await this.buildPlugin(skills, result.warnings)
    } catch (error) {
      result.warnings.push(`Skills were not attached: ${message(error)}`)
    }
    return result
  }

  private addServers(servers: McpServerConfig[], result: ClaudeTurnIntegrations): void {
    const used = new Set<string>([MOUSSE_MCP_SERVER_NAME])
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
    for (const server of servers) {
      if (server.authMode === 'oauth') {
        result.warnings.push(`MCP server ${server.name} signs in with OAuth through Mousse, which Claude cannot reuse.`)
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
      // Claude builds tool names from the server name, so keep it to the characters it preserves.
      const base = server.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'server'
      const name = used.has(base) ? `${base}_${shortHash(server.installationId ?? server.id)}` : base
      used.add(name)
      result.mcpServers[name] = entry
      if (server.enabledTools?.length || server.deniedTools?.length)
        result.toolRules[`mcp__${name}__`] = {
          ...(server.enabledTools?.length ? { enabled: server.enabledTools } : {}),
          ...(server.deniedTools?.length ? { denied: server.deniedTools } : {})
        }
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
