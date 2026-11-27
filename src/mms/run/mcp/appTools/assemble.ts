import { createHash } from 'node:crypto'
import type { MousseIntegrationsSettings, SkillDescriptor, SkillsRegistrySnapshot } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { EffectiveAgentGrants } from '../../../../shared/agents/types'
import { getSkillIdFromMode, normalizeChatMode } from '../../../../shared/chatMode'
import type { ChatMode } from '../../../../shared/types'
import { canonicalizeBuiltinToolName } from '../../../agentDefinitions/runtimePolicy'
import { resolveEffectiveSkills } from '../../../integrations/catalog/EffectiveIntegrationResolver'
import { withoutWebhookData } from '../../../scheduled/promptPlaceholders'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { ModeRegistry } from '../../../modes/ModeRegistry'
import { mousseOrchestrationInstructions } from '../instructions'
import { normalizeSkillName } from './skills'
import { truncateForModel, type ModeFacts } from './types'

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
  // Either list may name a tool by an old name (`BUILTIN_TOOL_ALIASES`).
  const canonical = canonicalizeBuiltinToolName(toolName)
  return enabled.some((id) => id === toolName || canonicalizeBuiltinToolName(id) === canonical)
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
  snapshot?: SkillsRegistrySnapshot
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
  /**
   * The last scan of the Skills folders may answer, while they are scanned again in the background (`SkillsDiscoveryOptions.stale`):
   * a bot's turn starts without walking them. A message that names a skill that scan doesn't have waits for a new scan of the folders.
   */
  stale?: boolean
}): Promise<SkillsContext> {
  const { registry, projectPath, mode } = input
  if (!registry) return { enabledSkills: [], loadedSkills: [] }
  let snapshot = await registry.discover({ projectPath, ...(input.stale && !input.grants ? { stale: true } : {}) })
  let enabledSkills = filterEnabledSkills(snapshot, mode, input.settings(), input.actor)
  if (input.stale && !input.grants && explicitSkillNames(input.userContent).some((name) => !enabledSkills.some((skill) => normalizeSkillName(skill.name) === name))) {
    // A scan, not the cache: the skill may have been added since a scan that is still within its time.
    snapshot = await registry.discover({ projectPath, refresh: true })
    enabledSkills = filterEnabledSkills(snapshot, mode, input.settings(), input.actor)
  }
  const grants = input.grants
  if (grants) {
    const resolved = await Promise.all(enabledSkills.map(async (skill) => {
      const grant = grants.skills.find((entry) => entry.id === skill.id || entry.id === skill.installationId)
      if (!grant) return undefined
      try {
        const result = await registry.readSkillForModel(skill, grant)
        const current = resolveEffectiveSkills({
          snapshot: { ...snapshot, skills: [result.skill] },
          settings: input.settings(),
          actor: input.actor,
          grantSource: grant.source
        })
        if (!current.length) return undefined
        return { skill: result.skill, loaded: { name: result.skill.name, content: truncateForModel(result.content) } }
      } catch (error) {
        console.warn('a granted skill could not be read for the turn', { skill: grant.id, error: error instanceof Error ? error.message : String(error) })
        return undefined
      }
    }))
    const available = resolved.filter((entry) => entry !== undefined)
    return { snapshot, enabledSkills: available.map((entry) => entry.skill), loadedSkills: available.map((entry) => entry.loaded) }
  }
  const modeSkills = await loadSkillForMode(registry, mode, projectPath, snapshot)
  const explicitSkills = await loadExplicitSkills(registry, input.userContent, enabledSkills, projectPath, snapshot)
  const loadedSkills = [
    ...modeSkills,
    ...explicitSkills.filter((skill) => !modeSkills.some((loaded) => loaded.name === skill.name))
  ]
  return { snapshot, enabledSkills, loadedSkills }
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

/**
 * A skill's file as it is now, or undefined when it cannot be read (removed since the scan): that skill is left out of
 * the turn, and the others still load.
 */
async function readOrSkip(registry: SkillsRegistry, skillId: string, projectPath: string | undefined, snapshot: SkillsRegistrySnapshot | undefined) {
  try {
    return await registry.readSkill(skillId, { projectPath }, snapshot)
  } catch (error) {
    console.warn('a skill could not be read for the turn; it is left out', { skill: skillId, error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

async function loadSkillForMode(
  registry: SkillsRegistry,
  mode: ChatMode,
  projectPath?: string,
  snapshot?: SkillsRegistrySnapshot
): Promise<Array<{ name: string; content: string }>> {
  const skillId = getSkillIdFromMode(mode)
  if (!skillId) return []
  const result = await readOrSkip(registry, skillId, projectPath, snapshot)
  return result ? [{ name: result.skill.name, content: truncateForModel(result.content) }] : []
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
    const result = await readOrSkip(registry, skill.id, projectPath, snapshot)
    if (!result) continue
    loaded.push({ name: result.skill.name, content: truncateForModel(result.content) })
  }
  return loaded
}

/** The session sentence of a turn that attaches the MCP relay. */
export const RELAY_SESSION_INSTRUCTION = 'The user\'s MCP servers set up in Mousse are also available through the "mousse-relay" server as <server>__<tool>.'

/**
 * The session sentence every thread agent gets, with or without Mousse's tools. A finished turn shows only its last
 * reply; the earlier ones fold behind its "Worked for" line, so an answer given before more work is easily missed.
 */
export const LAST_REPLY_SESSION_INSTRUCTION = 'Your last reply of a turn is the only one the person sees. Put every answer they asked for in it, including ones you gave earlier in the turn.'

/**
 * Stable session text for a thread agent's runtime with its own loop, delivered where the runtime applies session
 * text: the last-reply sentence, Mousse's tool guidance when its MCP server is attached (with one sentence for the
 * MCP relay when that is attached too), and the applet guidance when applets are on.
 */
export function sessionInstructions(input: { mcp: boolean; relay?: boolean; appletGuidance?: string }): string {
  return [
    LAST_REPLY_SESSION_INSTRUCTION,
    ...(input.mcp ? [mousseOrchestrationInstructions()] : []),
    ...(input.mcp && input.relay ? [RELAY_SESSION_INSTRUCTION] : []),
    ...(input.appletGuidance?.trim() ? [input.appletGuidance.trim()] : [])
  ].join('\n\n')
}

export function instructionsHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * What a person's Plan-mode turn is told. The turn is read-only in every runtime (its tools and permissions say so);
 * the plan is the reply itself, with no tool to submit it.
 */
export const PLAN_TURN_NOTE = 'Plan mode: this turn is read-only. Inspect what you need with read-only tools; do not edit files or run commands that change anything. Reply with the plan itself as your message, in markdown: steps, file paths and how to check the result. Use ask_user first when the request is ambiguous.'

/**
 * What a runtime with its own loop is told at the start of each prompt (PR 2 §2 "Instructions"):
 * skills loaded for the turn (an explicit `/skill` included), the mode's own instructions, the
 * conversation's applet catalogue, what already runs for the turn's folder, and which Mousse tools are usable now.
 * Empty when there is none.
 */
export function turnPreamble(input: {
  loadedSkills: Array<{ name: string; content: string }>
  modePrompt?: string
  appletCatalogue?: string
  usableTools?: string[]
  /** What already runs for the turn's folder (`runningNote`); empty or absent: nothing runs, and no section. */
  running?: string
}): string {
  const sections: string[] = []
  if (input.loadedSkills.length)
    sections.push(`## Loaded Skill Instructions\n${input.loadedSkills.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')}`)
  if (input.modePrompt?.trim()) sections.push(`## Mode\n${input.modePrompt.trim()}`)
  if (input.appletCatalogue?.trim()) sections.push(`## Applets${input.appletCatalogue}`)
  if (input.running?.trim()) sections.push(`## Running now\n${input.running.trim()}`)
  if (input.usableTools) sections.push(`## Mousse tools this turn\n${input.usableTools.length ? `Usable now: ${input.usableTools.join(', ')}.` : 'None of Mousse\'s tools are usable this turn.'}`)
  return sections.join('\n\n')
}
