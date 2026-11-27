import { checkMessage } from '../../../../shared/bots/personal/walls'
import { Type, type Tool } from '@earendil-works/pi-ai'
import { resolveEffectiveSkills } from '../../../integrations/catalog/EffectiveIntegrationResolver'
import type { SkillDescriptor } from '../../../../shared/integrations'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForModel, type AppToolTurn, type MousseTool } from './types'

export const SKILL_TOOLS: Tool[] = [
  {
    name: 'skill_list',
    description: 'List available Mousse Agent Skills with descriptions and scopes.',
    parameters: Type.Object({})
  },
  {
    name: 'skill_load',
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
 * The skill tools are offered when skills are enabled for the turn, outside Build (whose skill is its mode). Plan and
 * reader turns load skills too (docs/plans/tool-api.md §1.5): reading a skill changes nothing.
 */
function offeredInMode(host: AppToolHost, turn: AppToolTurn): boolean {
  return Boolean(host.skills?.()) && turn.enabledSkills.length > 0 && turn.mode !== 'build'
}

/** `skill_list` and `skill_load` over the turn's enabled skills. */
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
    describe: (args) => (tool.name === 'skill_load' ? `Load skill ${String(args.skill ?? '')}` : 'List skills'),
    handler: async (args, ctx) => {
      const available = ctx.turn.enabledSkills
      // A running turn's list is a snapshot. Check the bot's live permission before listing or reading a skill.
      const check = (skill: SkillDescriptor) => {
        const bot = ctx.turn.bot
        const id = bot && !bot.skills.has(skill.id) && skill.installationId && bot.skills.has(skill.installationId) ? skill.installationId : skill.id
        return bot?.check({ kind: 'skill', skill: id })
      }
      if (tool.name === 'skill_list') return { text: JSON.stringify(available.filter((skill) => check(skill)?.ok !== false).map(toSkillSummary), null, 2) }
      const requested = String(args.skill ?? '')
      const skill = available.find((candidate) =>
        candidate.id === requested ||
        candidate.installationId === requested ||
        candidate.name === requested ||
        normalizeSkillName(candidate.name) === normalizeSkillName(requested))
      if (!skill) return { text: `Skill not found: ${requested}`, isError: true }
      const decided = check(skill)
      if (decided && !decided.ok) return { text: checkMessage(decided), isError: true }
      const registry = host.skills?.()
      if (!registry) return { text: `Skill not found: ${requested}`, isError: true }
      ctx.markEffect?.()
      const unavailable = { text: `Skill ${skill.name} is no longer available.`, isError: true }
      const definition = ctx.turn.definition
      const grant = definition?.grants.skills.find((entry) => entry.id === skill.id || entry.id === skill.installationId)
      if (definition && !grant) return unavailable
      let result: Awaited<ReturnType<typeof registry.readSkillForModel>>
      try {
        result = await registry.readSkillForModel(skill, grant)
      } catch {
        return unavailable
      }
      // Disk I/O gave the owner time to change Settings or the bot's permission.
      const settings = host.skillSettings?.()
      const snapshot = { skills: [result.skill], sources: [], diagnostics: [] }
      if (!settings || !resolveEffectiveSkills({ snapshot, settings, actor: ctx.turn.actor, grantSource: grant?.source }).length) return unavailable
      const current = check(result.skill)
      if (current && !current.ok) return { text: checkMessage(current), isError: true }
      if (result.skill['disable-model-invocation'])
        return { text: `Skill ${skill.name} can only be loaded by explicit user invocation.`, isError: true }
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
