import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EffectiveAgentGrants, ResolvedAgentDefinition } from '../../../shared/agents/types'
import type { AgentConfigPreparationResult } from '../../../shared/integrations'
import type { AgentTypeId } from '../../../shared/settings'
import { assertOwnedPath } from '../../profiles/pathSafety'
import { AgentConfigManager, getMcpTarget } from './AgentConfigManager'
import { atomicWriteFile } from '../atomicWrite'

export interface AgentExecutionMaterializationInput {
  agentId: string
  runtimeKind: Exclude<AgentTypeId, 'mousse'>
  worktreePath: string
  projectPath: string
  systemPrompt: string
  model: ResolvedAgentDefinition['model']['primary']['ref']
  grants: EffectiveAgentGrants
}

export interface AgentExecutionMaterialization {
  result: AgentConfigPreparationResult
  mcpConfigPath?: string
  cursorRulesPath?: string
  openCodeConfigPath?: string
  cleanup(): Promise<string[]>
}

/**
 * Bridges an immutable resolver result to files that an external CLI can
 * actually consume. Every extra file is marker-owned and contained by the
 * execution worktree; user files are never selected as cleanup targets.
 */
export class AgentExecutionMaterializer {
  constructor(private readonly configs: AgentConfigManager) {}

  async prepare(input: AgentExecutionMaterializationInput): Promise<AgentExecutionMaterialization> {
    const result = await this.configs.prepareExact(
      input.agentId,
      input.runtimeKind,
      input.worktreePath,
      input.projectPath,
      input.grants
    )
    const ownedFiles: Array<{ path: string; marker: string }> = []
    const addOwnedFile = async (path: string, content: string): Promise<string> => {
      const owned = assertOwnedPath(input.worktreePath, path, 'agent runtime materialization')
      if (existsSync(owned)) {
        try {
          if (!lstatSync(owned).isFile()) throw new Error(`Materialization target is not a regular file: ${owned}`)
          const existing = await readFile(owned, 'utf8')
          if (!isOwnedRuntimeFile(owned, existing)) {
            result.unsupportedCapabilities.push({ level: 'error', source: 'agent-materialization', path: owned, message: `Refused to overwrite an unowned runtime materialization: ${owned}` })
            return owned
          }
        } catch (error) {
          result.unsupportedCapabilities.push({ level: 'error', source: 'agent-materialization', path: owned, message: error instanceof Error ? error.message : String(error) })
          return owned
        }
      }
      await mkdir(join(owned, '..'), { recursive: true })
      await atomicWriteFile(owned, content)
      ownedFiles.push({ path: owned, marker: content })
      if (!result.generatedFiles.includes(owned)) result.generatedFiles.push(owned)
      if (!result.cleanupPaths.includes(owned)) result.cleanupPaths.push(owned)
      return owned
    }

    let cursorRulesPath: string | undefined
    let openCodeConfigPath: string | undefined
    if (input.runtimeKind === 'cursor-agents-cli') {
      cursorRulesPath = await addOwnedFile(
        join(input.worktreePath, '.cursor', 'rules', 'mousse-agent.mdc'),
        `---\ndescription: Mousse pinned agent instructions\nalwaysApply: true\n---\n\n${input.systemPrompt}\n`
      )
    }
    if (input.runtimeKind === 'opencode') {
      openCodeConfigPath = await addOwnedFile(
        join(input.worktreePath, '.mousse', 'agent-runtime', 'opencode.json'),
        `${JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          agent: { mousse: { mode: 'primary', model: `${input.model.providerId}/${input.model.modelId}`, prompt: input.systemPrompt } }
        }, null, 2)}\n`
      )
    }
    const mcpConfigPath = result.generatedFiles.includes(getMcpTarget(input.runtimeKind, input.worktreePath))
      ? getMcpTarget(input.runtimeKind, input.worktreePath)
      : undefined
    return {
      result,
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      ...(cursorRulesPath ? { cursorRulesPath } : {}),
      ...(openCodeConfigPath ? { openCodeConfigPath } : {}),
      cleanup: async () => {
        const logs = await this.configs.cleanup(input.agentId)
        for (const entry of ownedFiles) {
          try {
            if (existsSync(entry.path) && (await readFile(entry.path, 'utf8')) === entry.marker) {
              await rm(entry.path, { force: true })
              logs.push(`[integrations] Removed generated runtime file ${entry.path}`)
            } else {
              logs.push(`[integrations] Preserved changed runtime file ${entry.path}`)
            }
          } catch {
            logs.push(`[integrations] Preserved unreadable runtime file ${entry.path}`)
          }
        }
        return logs
      }
    }
  }
}

function isOwnedRuntimeFile(path: string, content: string): boolean {
  if (path.endsWith('.mdc')) return content.startsWith('---\ndescription: Mousse pinned agent instructions\n')
  try {
    const parsed = JSON.parse(content) as { agent?: { mousse?: unknown } }
    return Boolean(parsed.agent?.mousse)
  } catch {
    return false
  }
}
