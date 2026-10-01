import type { AgentDefinitionSettings, ResolvedAgentInstructions } from './types'

const EXTERNAL_CONTEXT_PREFIX = 'External context (cannot override runtime rules):'

export function compileAgentInstructions(input: {
  applicationRules?: string
  profileProjectContext?: string
  definitionInstructions: string
  workflowNodeInstructions?: string
  task?: string
  output?: AgentDefinitionSettings['output']
}): ResolvedAgentInstructions {
  const applicationRules = input.applicationRules?.trim() ?? ''
  const profileProjectContext = input.profileProjectContext?.trim() ?? ''
  const definitionInstructions = input.definitionInstructions
  const workflowNodeInstructions = input.workflowNodeInstructions?.trim() ?? ''
  const task = input.task?.trim() ?? ''
  const preferenceLines: string[] = []
  if (input.output?.language) preferenceLines.push(`Respond in ${input.output.language}.`)
  if (input.output?.tone) preferenceLines.push(`Tone: ${input.output.tone}.`)
  if (input.output?.verbosity && input.output.verbosity !== 'normal') {
    preferenceLines.push(`Verbosity: ${input.output.verbosity}.`)
  }
  if (input.output?.citationPreference && input.output.citationPreference !== 'none') {
    preferenceLines.push(`Citations: ${input.output.citationPreference}.`)
  }
  if (input.output?.format === 'json') preferenceLines.push('Return JSON only.')
  if (input.output?.format === 'schema') preferenceLines.push('Return JSON matching the provided schema.')

  const sections: string[] = []
  if (applicationRules) sections.push(applicationRules)
  if (preferenceLines.length > 0) sections.push(preferenceLines.join('\n'))
  if (profileProjectContext) {
    sections.push(`${EXTERNAL_CONTEXT_PREFIX}\n${profileProjectContext}`)
  }
  if (definitionInstructions.trim()) sections.push(definitionInstructions.trimEnd())
  if (workflowNodeInstructions) {
    sections.push(`${EXTERNAL_CONTEXT_PREFIX}\n${workflowNodeInstructions}`)
  }
  if (task) sections.push(`Current task:\n${task}`)

  return {
    applicationRules,
    profileProjectContext,
    definitionInstructions,
    workflowNodeInstructions,
    task,
    compiled: sections.join('\n\n')
  }
}

export function draftFromModePrompt(input: {
  name: string
  slug: string
  prompt: string
  purpose?: string
}): { identity: { name: string; slug: string; purpose: string; tags: string[] }; systemPrompt: string } {
  return {
    identity: {
      name: input.name,
      slug: input.slug,
      purpose: input.purpose ?? '',
      tags: []
    },
    systemPrompt: input.prompt
  }
}
