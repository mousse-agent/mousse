import type { ChatMessage, OrchestratorAction } from './types'

export type ToolCallDisplay = NonNullable<ChatMessage['toolCall']>

export function getToolCallDisplay(action: OrchestratorAction): ToolCallDisplay {
  switch (action.type) {
    case 'spawn_agents': {
      const agentCount = action.agents.length
      const agentTypes = [...new Set(action.agents.map((agent) => agent.cliType))].join(', ')
      return {
        title: `Spawned ${agentCount} agent${agentCount === 1 ? '' : 's'}`,
        summary: 'Started isolated coding sessions for the requested work.',
        details: [
          `Prepared ${agentCount} agent workspace${agentCount === 1 ? '' : 's'}.`,
          `Opened terminal session${agentCount === 1 ? '' : 's'} for ${agentTypes || 'the selected CLI'}.`,
          'Sent each agent its task prompt and switched it into a running state.'
        ],
        status: 'complete'
      }
    }
    case 'complete_task':
      return {
        title: 'Completed active task',
        summary:
          action.merge === false
            ? 'Stopped active agents without merging their work.'
            : 'Wrapped up active agents and merged completed work where possible.',
        details: [
          'Checked currently active agent sessions.',
          action.merge === false
            ? 'Marked eligible tasks complete and closed their terminals.'
            : 'Merged successful agent branches, marked tasks complete, and closed terminals.'
        ],
        status: 'complete'
      }
    case 'message':
      return {
        title: 'Added conversation note',
        summary: 'Recorded an orchestrator note in the timeline.',
        details: [
          'Converted the action into a readable timeline event.',
          'Kept the raw action payload hidden from the conversation view.'
        ],
        status: 'complete'
      }
  }
}

function isValidAction(action: unknown): action is OrchestratorAction {
  if (!action || typeof action !== 'object') return false

  const obj = action as Record<string, unknown>
  if (obj.type === 'spawn_agents' && Array.isArray(obj.agents)) return true
  if (obj.type === 'complete_task') return true
  if (obj.type === 'message' && typeof obj.content === 'string') return true
  return false
}

function getToolCallsFromJson(json: string): ToolCallDisplay[] {
  try {
    const parsed = JSON.parse(json)
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : [parsed]

    return actions.filter(isValidAction).map(getToolCallDisplay)
  } catch {
    return []
  }
}

export function extractToolCallsFromContent(content: string): {
  visibleContent: string
  toolCalls: ToolCallDisplay[]
} {
  const toolCalls: ToolCallDisplay[] = []
  let visibleContent = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, (block, body) => {
    const displays = getToolCallsFromJson(String(body).trim())
    if (displays.length === 0) return block

    toolCalls.push(...displays)
    return ''
  })

  const inline = visibleContent.match(/\{[\s\S]*"actions"[\s\S]*\}/)
  if (inline) {
    const displays = getToolCallsFromJson(inline[0])
    if (displays.length > 0) {
      toolCalls.push(...displays)
      visibleContent = visibleContent.replace(inline[0], '')
    }
  }

  return {
    visibleContent: visibleContent.trim(),
    toolCalls
  }
}
