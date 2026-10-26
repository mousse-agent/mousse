import { Type, type Tool } from '@earendil-works/pi-ai'
import type { SkillDescriptor } from '../../../../shared/integrations'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForModel, type AppToolTurn, type MousseTool } from './types'

export const SKILL_TOOLS: Tool[] = [
  {
    name: 'list_skills',
    description: 'List available Mousse Agent Skills with descriptions and scopes.',
    parameters: Type.Object({})
  },
  {
    name: 'load_skill',
    description: 'Load the full SKILL.md instructions for one available Skill by name or id.',
    parameters: Type.Object({
      skill: Type.String({ description: 'Skill name or id to load.' })
    })
  }
]

export function normalizeSkillName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
}

export function toSkillSummary(skill: SkillDescriptor): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    source: skill.source,
    paths: skill.paths,
    modelInvocationDisabled: skill['disable-model-invocation'] === true
  }
}

/**
 * The skill tools are offered when skills are enabled for the turn, outside Build and read-only
 * modes, as the pi loop always offered them.
 */
function offeredInMode(host: AppToolHost, turn: AppToolTurn): boolean {
  return Boolean(host.skills?.()) && turn.enabledSkills.length > 0 && turn.mode !== 'build' && !turn.modeFacts.readOnly
}

/** `list_skills` and `load_skill` over the turn's enabled skills. */
export function skillTools(host: AppToolHost): MousseTool[] {
  return SKILL_TOOLS.map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'reads',
    class: 'read',
    listed: () => Boolean(host.skills?.()),
    available: (turn) => (turn.settingsEnabled(tool.name) ? true : disabledInSettings(tool.name)),
    offered: (turn) => offeredInMode(host, turn) && turn.settingsEnabled(tool.name),
    describe: (args) => (tool.name === 'load_skill' ? `Load skill ${String(args.skill ?? '')}` : 'List skills'),
    handler: async (args, ctx) => {
      const available = ctx.turn.enabledSkills
      if (tool.name === 'list_skills') return { text: JSON.stringify(available.map(toSkillSummary), null, 2) }
      const requested = String(args.skill ?? '')
      const skill = available.find((candidate) =>
        candidate.id === requested ||
        candidate.name === requested ||
        normalizeSkillName(candidate.name) === normalizeSkillName(requested))
      if (!skill) return { text: `Skill not found: ${requested}`, isError: true }
      if (skill['disable-model-invocation'])
        return { text: `Skill ${skill.name} can only be loaded by explicit user invocation.`, isError: true }
      const registry = host.skills?.()
      if (!registry) return { text: `Skill not found: ${requested}`, isError: true }
      ctx.markEffect?.()
      const result = await registry.readSkill(skill.installationId ?? skill.id, { projectPath: ctx.turn.projectPath })
      ctx.timeline?.record({
        kind: 'skill_loaded',
        title: `Loaded skill ${result.skill.name}`,
        summary: 'Loaded Skill instructions through the orchestrator tool loop.',
        details: [`Skill: ${result.skill.name}`, `Characters: ${result.content.length}`]
      }, 'complete')
      return { text: truncateForModel(result.content) }
    }
  }))
}
