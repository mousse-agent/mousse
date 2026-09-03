import type { ChatMessage, OrchestratorAction } from './types'

export type ToolCallDisplay = NonNullable<ChatMessage['toolCall']>

export function getToolCallDisplay(action: OrchestratorAction): ToolCallDisplay {
  switch (action.type) {
    case 'spawn_agents': {
      const agentCount = action.agents.length
      const agentTypes = [...new Set(action.agents.map((agent) => agent.cliType))].join(', ')
      return {
        title: `Spawning ${agentCount} agent${agentCount === 1 ? '' : 's'}`,
        summary: 'Preparing isolated coding sessions for the requested work.',
        details: [
          `Requested ${agentCount} agent workspace${agentCount === 1 ? '' : 's'}.`,
          `Selected ${agentTypes || 'the configured agent type'}.`,
          'Waiting for validation and session startup to complete.'
        ],
        status: 'processing'
      }
    }
    case 'complete_task':
      return {
        title: 'Completing active task',
        summary:
          action.merge === false
            ? 'Stopping active agents without merging their work.'
            : 'Checking active agents and preparing completed work for merge.',
        details: [
          'Checking currently active agent sessions.',
          action.merge === false
            ? 'Waiting for eligible tasks and terminals to close.'
            : 'Waiting for successful agent branches to merge and sessions to close.'
        ],
        status: 'processing'
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

/**
 * Provider -> standardize helper.
 * LlmToolEvent carries structured data as strings today:
 * - details[] contains `Tool: <name>` / `Server: x` / `Skill: y`
 * - response contains JSON.stringify(args) on start, result text on complete.
 * Parse once at the provider boundary so the renderer never string-matches titles.
 */
export function parseProviderToolCall(input: {
  title: string
  details: string[]
  response?: string
  kind?: string
}): { toolName?: string; input?: Record<string, unknown> } {
  const detailTool = input.details.find((d) => d.startsWith('Tool:'))
  const rawName = detailTool?.replace('Tool:', '').trim().split(/\s+/)[0]
  // MCP call events use `Server:` + `Tool:` details; keep the tool name.
  const toolName = rawName || undefined
  if (!input.response) return toolName ? { toolName } : {}
  const trimmed = input.response.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return toolName ? { toolName } : {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { toolName, input: parsed as Record<string, unknown> }
    }
  } catch {
    // Complete-phase result text — not args JSON.
  }
  return toolName ? { toolName } : {}
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
