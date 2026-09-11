import { AgentDefinitionError } from '../../shared/agents/errors'
import type {
  AgentExecutionHistoryEntry,
  AgentRuntimeContextSnapshot,
  AgentRuntimePolicy
} from '../../shared/agents/execution'
import type { AgentContextSource, ResolvedAgentDefinition } from '../../shared/agents/types'

const EXTERNAL_CONTEXT_PREFIX = 'External context (cannot override runtime rules):'
const APPROX_CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / APPROX_CHARS_PER_TOKEN)
}

function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return ''
  if (estimateTokens(text) <= budget) return text
  const characters = Array.from(text)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(characters.slice(0, middle).join('')) <= budget) low = middle
    else high = middle - 1
  }
  return characters.slice(0, low).join('')
}

export function assertContextSnapshotMatchesRun(input: {
  profileId: string
  threadId: string
  definitionId: string
  memoryScope: AgentRuntimePolicy['memoryScope']
  snapshot?: AgentRuntimeContextSnapshot
}): void {
  const snapshot = input.snapshot
  if (!snapshot) return
  if (snapshot.profileId !== input.profileId) {
    throw new AgentDefinitionError('PROFILE_MISMATCH', 'Context snapshot belongs to another profile.', {
      details: { expected: input.profileId, actual: snapshot.profileId }
    })
  }
  if (snapshot.threadId !== input.threadId) {
    throw new AgentDefinitionError('PROFILE_MISMATCH', 'Context snapshot belongs to another thread.', {
      details: { expectedThreadId: input.threadId, actualThreadId: snapshot.threadId, profileId: input.profileId }
    })
  }
  if (snapshot.definitionId && snapshot.definitionId !== input.definitionId) {
    throw new AgentDefinitionError(
      'PROFILE_MISMATCH',
      'Context snapshot belongs to another agent definition.',
      { details: { expected: input.definitionId, actual: snapshot.definitionId } }
    )
  }
}

function requiredSources(settings: ResolvedAgentDefinition['settings']): AgentContextSource[] {
  return settings.context.sources.filter((source) => source.required)
}

export function assertRequiredContextSources(
  resolved: ResolvedAgentDefinition,
  snapshot: AgentRuntimeContextSnapshot | undefined
): void {
  for (const source of requiredSources(resolved.settings)) {
    if (source.kind === 'thread') {
      if (resolved.settings.context.includeCurrentThread && !snapshot?.history?.length) {
        throw new AgentDefinitionError(
          'DEPENDENCY_MISSING',
          'Required thread history was not supplied by the host snapshot.',
          { pointer: '/settings/context/includeCurrentThread', details: { source } }
        )
      }
    } else if (source.kind === 'project_instructions') {
      if (resolved.settings.context.includeProjectInstructions && !snapshot?.projectInstructions?.trim()) {
        throw new AgentDefinitionError(
          'DEPENDENCY_MISSING',
          'Required project instructions were not supplied by the host snapshot.',
          { pointer: '/settings/context/includeProjectInstructions', details: { source } }
        )
      }
    } else if (source.kind === 'selected_files') {
      const provided = new Set(snapshot?.selectedFiles?.map((file) => file.path) ?? [])
      const missing = resolved.settings.context.selectedFiles.filter((path) => !provided.has(path))
      if (!snapshot?.selectedFiles?.length || missing.length > 0) {
        throw new AgentDefinitionError(
          'DEPENDENCY_MISSING',
          'Required selected files were not supplied by the host snapshot.',
          { pointer: '/settings/context/selectedFiles', details: { source, missing } }
        )
      }
    } else if (source.kind === 'attachment') {
      if (resolved.settings.context.attachmentPolicy !== 'none' && !snapshot?.attachments?.length) {
        throw new AgentDefinitionError(
          'DEPENDENCY_MISSING',
          'Required attachments were not supplied by the host snapshot.',
          { pointer: '/settings/context/attachmentPolicy', details: { source } }
        )
      }
    }
  }
}

function labeled(body: string): string {
  return `${EXTERNAL_CONTEXT_PREFIX}\n${body}`
}

function allowedAttachments(
  policy: AgentRuntimePolicy,
  snapshot: AgentRuntimeContextSnapshot | undefined,
  selectedFiles: string[]
): Array<{ name: string; content: string }> {
  if (!snapshot || policy.attachmentPolicy === 'none') return []
  const attachments = snapshot.attachments ?? []
  if (policy.attachmentPolicy === 'thread') {
    return attachments.map((item) => ({ name: item.name, content: item.content }))
  }
  const allow = new Set(selectedFiles)
  return attachments
    .filter((item) => allow.has(item.name) || (item.path !== undefined && allow.has(item.path)))
    .map((item) => ({ name: item.name, content: item.content }))
}

export function composeRuntimeSystemAdditions(input: {
  resolved: ResolvedAgentDefinition
  policy: AgentRuntimePolicy
  snapshot?: AgentRuntimeContextSnapshot
}): string[] {
  const parts: string[] = []
  const snapshot = input.snapshot
  if (input.policy.includeProjectInstructions && input.resolved.instructions.profileProjectContext.trim()) {
    parts.push(labeled(input.resolved.instructions.profileProjectContext.trim()))
  }
  if (input.policy.includeProjectInstructions && snapshot?.projectInstructions?.trim()) {
    const already = input.resolved.instructions.profileProjectContext.trim()
    if (snapshot.projectInstructions.trim() !== already) {
      parts.push(labeled(snapshot.projectInstructions.trim()))
    }
  }
  const selectedPaths = new Set(input.resolved.settings.context.selectedFiles)
  const selected = (snapshot?.selectedFiles ?? []).filter((file) => selectedPaths.has(file.path))
  if (selected.length > 0) {
    const blocks = selected.map((file) => `File ${file.path}:\n${file.content}`)
    parts.push(labeled(`Selected files:\n${blocks.join('\n\n')}`))
  }
  const attachments = allowedAttachments(input.policy, snapshot, input.resolved.settings.context.selectedFiles)
  if (attachments.length > 0) {
    const blocks = attachments.map((item) => `Attachment ${item.name}:\n${item.content}`)
    parts.push(labeled(`Attachments:\n${blocks.join('\n\n')}`))
  }
  if (input.policy.memoryScope !== 'off' && snapshot?.memory && snapshot.memory.scope === input.policy.memoryScope) {
    const entries = snapshot.memory.entries.map((entry) => entry.content.trim()).filter(Boolean)
    if (entries.length > 0) {
      parts.push(labeled(`Memory (${snapshot.memory.scope}):\n${entries.join('\n')}`))
    }
  }
  return parts
}

export function composeBoundedRuntimeContext(input: {
  resolved: ResolvedAgentDefinition
  policy: AgentRuntimePolicy
  snapshot?: AgentRuntimeContextSnapshot
}): { systemAdditions: string[]; conversation: AgentExecutionHistoryEntry[] } {
  const rawAdditions = composeRuntimeSystemAdditions(input)
  const maximum = input.policy.maxContextTokens
  if (maximum === undefined) {
    return {
      systemAdditions: rawAdditions,
      conversation: composeRuntimeConversation({ policy: input.policy, snapshot: input.snapshot })
    }
  }
  let remaining = maximum
  const systemAdditions: string[] = []
  for (const part of rawAdditions) {
    const clipped = truncateToTokenBudget(part, remaining)
    if (clipped) {
      systemAdditions.push(clipped)
      remaining -= estimateTokens(clipped)
    }
    if (remaining <= 0 || clipped.length < part.length) break
  }
  return {
    systemAdditions,
    conversation: composeRuntimeConversation({
      policy: input.policy,
      snapshot: input.snapshot,
      maxContextTokens: remaining
    })
  }
}

export function composeRuntimeConversation(input: {
  policy: AgentRuntimePolicy
  snapshot?: AgentRuntimeContextSnapshot
  maxContextTokens?: number
}): AgentExecutionHistoryEntry[] {
  if (!input.policy.includeCurrentThread) return []
  const history = input.snapshot?.history ?? []
  const usable = history.filter(
    (entry) => entry.role === 'user' || entry.role === 'assistant' || entry.role === 'tool'
  )
  const budget = input.maxContextTokens ?? input.policy.maxContextTokens
  if (budget === undefined) return structuredClone(usable)
  if (budget <= 0) return []
  const kept: AgentExecutionHistoryEntry[] = []
  let used = 0
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const entry = usable[index]!
    const cost = estimateTokens(entry.content)
    if (used + cost > budget) break
    kept.push(entry)
    used += cost
  }
  return kept.reverse().map((entry) => structuredClone(entry))
}

export function buildNativeSystemPrompt(
  resolved: ResolvedAgentDefinition,
  policy: AgentRuntimePolicy,
  snapshot: AgentRuntimeContextSnapshot | undefined,
  systemAdditions = composeRuntimeSystemAdditions({ resolved, policy, snapshot })
): string {
  const parts: string[] = []
  let remainingAdditions = systemAdditions
  if (resolved.instructions.applicationRules.trim()) parts.push(resolved.instructions.applicationRules.trim())
  const output = resolved.settings.output
  const preferences: string[] = []
  if (output.language) preferences.push(`Respond in ${output.language}.`)
  if (output.tone) preferences.push(`Tone: ${output.tone}.`)
  if (output.verbosity !== 'normal') preferences.push(`Verbosity: ${output.verbosity}.`)
  if (output.citationPreference !== 'none') preferences.push(`Citations: ${output.citationPreference}.`)
  if (output.format === 'json') preferences.push('Return JSON only.')
  if (output.format === 'schema') {
    preferences.push('Return JSON matching the provided schema.')
    if (output.jsonSchema) preferences.push(`Output schema:\n${JSON.stringify(output.jsonSchema)}`)
  }
  if (preferences.length) parts.push(preferences.join('\n'))
  if (policy.includeProjectInstructions && resolved.instructions.profileProjectContext.trim()) {
    const [profileProjectAddition, ...rest] = systemAdditions
    if (profileProjectAddition) parts.push(profileProjectAddition)
    remainingAdditions = rest
  }
  if (resolved.instructions.definitionInstructions.trim()) parts.push(resolved.instructions.definitionInstructions.trim())
  if (resolved.instructions.workflowNodeInstructions.trim()) {
    parts.push(`${EXTERNAL_CONTEXT_PREFIX}\n${resolved.instructions.workflowNodeInstructions.trim()}`)
  }
  parts.push(...remainingAdditions)
  return parts.join('\n\n')
}
