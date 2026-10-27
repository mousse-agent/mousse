import { createHash } from 'node:crypto'
import type { Tool } from '@earendil-works/pi-ai'
import type { MousseIntegrationsSettings, SkillDescriptor, SkillsRegistrySnapshot } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import { sha256Hex } from '../../../../shared/agents/hashes'
import type { EffectiveAgentGrants } from '../../../../shared/agents/types'
import { getSkillIdFromMode, normalizeChatMode } from '../../../../shared/chatMode'
import type { ChatMode } from '../../../../shared/types'
import { canonicalizeBuiltinToolName } from '../../../agentDefinitions/runtimePolicy'
import { resolveEffectiveSkills } from '../../../integrations/catalog/EffectiveIntegrationResolver'
import { withoutWebhookData } from '../../../scheduled/promptPlaceholders'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { ModeRegistry } from '../../../modes/ModeRegistry'
import { mousseOrchestrationInstructions } from '../instructions'
import type { AppToolFamily } from './index'
import type { ToolRegistry } from './registry'
import { normalizeSkillName } from './skills'
import { truncateForModel, type AppToolTurn, type ModeFacts } from './types'

/**
 * Turn assembly shared by every runtime (PR 2 §2 "Assembly" and "Instructions"): skills, what a
 * mode allows, the Settings gate, the in-process tool selection, and the two instruction texts a
 * runtime with its own loop is given.
 */

/** Settings → Skills & MCP: whether a Mousse tool is turned on (missing settings: all on). */
export function settingsToolEnabled(tools: MousseIntegrationsSettings['tools'] | undefined, toolName: string): boolean {
  if (!tools || tools.enabled === false) {
    // Missing settings (pre-migration configs) default to all enabled.
    if (!tools) return true
    return false
  }
  const enabled = tools.enabledTools
  if (!Array.isArray(enabled)) return true
  // Empty explicit list means nothing selected; default list means all.
  if (enabled.length === 0) return false
  const canonical = canonicalizeBuiltinToolName(toolName)
  return enabled.includes(toolName) || enabled.includes(canonical)
}

/** What `mode` allows, from its descriptor when the registry has one. */
export function modeFactsFor(modeRegistry: ModeRegistry, mode: ChatMode, projectPath: string | undefined): ModeFacts {
  const descriptor = typeof mode === 'string' ? modeRegistry.getModeSync(mode, { projectPath }) : undefined
  return {
    readOnly: descriptor ? (descriptor.permission?.['edit'] === 'deny' || descriptor.permission?.['bash'] === 'deny') : mode === 'plan',
    agent: descriptor ? descriptor.id === 'agent' : mode === 'agent',
    build: descriptor ? descriptor.id === 'build' : mode === 'build'
  }
}

export interface SkillsContext {
  enabledSkills: SkillDescriptor[]
  loadedSkills: Array<{ name: string; content: string; revision?: string }>
}

/**
 * The skills a turn may use and the ones loaded into it: the mode's own skill, the ones the user
 * invoked explicitly (`/name`), or, for a trusted definition, exactly its grants.
 */
export async function prepareSkills(input: {
  registry: SkillsRegistry | undefined
  /** Read only when there is a registry. */
  settings: () => MousseIntegrationsSettings['skills']
  projectPath: string | undefined
  mode: ChatMode
  userContent: string
  actor: IntegrationActor
  grants?: EffectiveAgentGrants
}): Promise<SkillsContext> {
  const { registry, projectPath, mode } = input
  if (!registry) return { enabledSkills: [], loadedSkills: [] }
  const snapshot = await registry.discover({ projectPath })
  const enabledSkills = filterEnabledSkills(snapshot, mode, input.settings(), input.actor)
  const modeSkills = input.grants ? [] : await loadSkillForMode(registry, mode, projectPath, snapshot)
  const explicitSkills = await loadExplicitSkills(registry, input.userContent, enabledSkills, projectPath, snapshot)
  const grants = input.grants
  const grantedSkills = grants
    ? await Promise.all(enabledSkills.map(async (skill) => {
        const grant = grants.skills.find((entry) => entry.id === skill.id || entry.id === skill.installationId)!
        const result = await registry.readSkill(skill.installationId ?? skill.id, { projectPath }, snapshot)
        if (grant.hash && sha256Hex(result.content) !== grant.hash) {
          throw new Error(`Granted skill changed after agent resolution: ${grant.id}.`)
        }
        if (!grant.hash && grant.revision && result.skill.revision !== grant.revision && result.skill.contentHash !== grant.revision) {
          throw new Error(`Granted skill revision is unavailable: ${grant.id}@${grant.revision}.`)
        }
        return { name: result.skill.name, content: truncateForModel(result.content) }
      }))
    : []
  const loadedSkills = grants ? grantedSkills : [
    ...modeSkills,
    ...explicitSkills.filter((skill) => !modeSkills.some((loaded) => loaded.name === skill.name))
  ]
  return { enabledSkills, loadedSkills }
}

function filterEnabledSkills(
  snapshot: SkillsRegistrySnapshot,
  mode: ChatMode | undefined,
  settings: MousseIntegrationsSettings['skills'],
  actor: IntegrationActor
): SkillDescriptor[] {
  const skillId = getSkillIdFromMode(normalizeChatMode(mode))
  if (skillId) return snapshot.skills.filter((skill) => skill.id === skillId || skill.installationId === skillId)
  return resolveEffectiveSkills({ snapshot, settings, actor })
}

async function loadSkillForMode(
  registry: SkillsRegistry,
  mode: ChatMode,
  projectPath?: string,
  snapshot?: SkillsRegistrySnapshot
): Promise<Array<{ name: string; content: string }>> {
  const skillId = getSkillIdFromMode(mode)
  if (!skillId) return []
  const result = await registry.readSkill(skillId, { projectPath }, snapshot)
  return [{ name: result.skill.name, content: truncateForModel(result.content) }]
}

/**
 * The skill names a message asks for with `/name` (at its start or after any whitespace), lower-cased. Text a
 * webhook supplied to a scheduled run (inside `<webhook-data-ID>` tags) never counts: only the person's own
 * words can load a skill.
 */
export function explicitSkillNames(userContent: string): string[] {
  return Array.from(withoutWebhookData(userContent).matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)/g)).map((match) => match[1].toLowerCase())
}

async function loadExplicitSkills(
  registry: SkillsRegistry,
  userContent: string,
  availableSkills: SkillDescriptor[],
  projectPath?: string,
  snapshot?: SkillsRegistrySnapshot
): Promise<Array<{ name: string; content: string }>> {
  const requestedNames = explicitSkillNames(userContent)
  if (requestedNames.length === 0) return []
  const loaded: Array<{ name: string; content: string }> = []
  for (const name of requestedNames) {
    const skill = availableSkills.find((candidate) => normalizeSkillName(candidate.name) === name)
    if (!skill) continue
    const result = await registry.readSkill(skill.id, { projectPath }, snapshot)
    loaded.push({ name: result.skill.name, content: truncateForModel(result.content) })
  }
  return loaded
}

/** The pi-ai definitions an in-process loop sends this turn, per tool family. */
export function offeredDefinitions(registry: ToolRegistry, families: Record<AppToolFamily, string[]>, turn: AppToolTurn): Record<AppToolFamily, Tool[]> {
  const offered = new Set(registry.offeredFor(turn).map((tool) => tool.name))
  const out = {} as Record<AppToolFamily, Tool[]>
  for (const [family, names] of Object.entries(families) as Array<[AppToolFamily, string[]]>) {
    out[family] = names.filter((name) => offered.has(name)).map((name) => {
      const tool = registry.get(name)!
      return tool.definition?.(turn) ?? { name: tool.name, description: tool.description, parameters: tool.inputSchema as unknown as Tool['parameters'] }
    })
  }
  return out
}

/**
 * Stable session text for a runtime with its own loop, delivered where the runtime applies session
 * text: Mousse's tool guidance when its MCP server is attached, and the applet guidance when applets
 * are on. Empty when there is neither.
 */
export function sessionInstructions(input: { mcp: boolean; appletGuidance?: string }): string {
  return [
    ...(input.mcp ? [mousseOrchestrationInstructions()] : []),
    ...(input.appletGuidance?.trim() ? [input.appletGuidance.trim()] : [])
  ].join('\n\n')
}

export function instructionsHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * What a runtime with its own loop is told at the start of each prompt (PR 2 §2 "Instructions"):
 * skills loaded for the turn (an explicit `/skill` included), the mode's own instructions, the
 * conversation's applet catalogue, and which Mousse tools are usable now. Empty when there is none.
 */
export function turnPreamble(input: {
  loadedSkills: Array<{ name: string; content: string }>
  modePrompt?: string
  appletCatalogue?: string
  usableTools?: string[]
}): string {
  const sections: string[] = []
  if (input.loadedSkills.length)
    sections.push(`## Loaded Skill Instructions\n${input.loadedSkills.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')}`)
  if (input.modePrompt?.trim()) sections.push(`## Mode\n${input.modePrompt.trim()}`)
  if (input.appletCatalogue?.trim()) sections.push(`## Applets${input.appletCatalogue}`)
  if (input.usableTools) sections.push(`## Mousse tools this turn\n${input.usableTools.length ? `Usable now: ${input.usableTools.join(', ')}.` : 'None of Mousse\'s tools are usable this turn.'}`)
  return sections.join('\n\n')
}
