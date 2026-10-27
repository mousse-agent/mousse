import type { ChatMode, OrchestratorAction } from '../../shared/types'
import { allowsOrchestrationActions, filterActionsForMode } from '../../shared/chatMode'
import { modeRegistry as defaultModeRegistry } from '../modes/ModeRegistry'

/**
 * Orchestration actions in an assistant reply: the ```mousse-actions fences the orchestrator
 * executes, and the chat-mode rules that decide which of them may run.
 */

export function parseActions(response: string): OrchestratorAction[] {
  const actions: OrchestratorAction[] = []

  // Orchestration is executable only in an explicitly marked fence. Generic JSON
  // is frequently used for discussion/examples and must never have side effects.
  // Extract by brace-balanced JSON so nested markdown fences inside task strings
  // (for example ```ts) cannot truncate the payload.
  for (const block of extractMousseActionBlocks(response)) {
    try {
      const parsed = JSON.parse(block.json)

      if (Array.isArray(parsed.actions)) {
        for (const a of parsed.actions) {
          if (isValidAction(a)) actions.push(a)
        }
      } else if (isValidAction(parsed)) {
        actions.push(parsed)
      }
    } catch {
      /* skip invalid JSON */
    }
  }

  return actions
}

export function stripActionBlocks(response: string): string {
  const blocks = extractMousseActionBlocks(response)
  if (blocks.length === 0) return response.trim()

  let result = ''
  let cursor = 0
  for (const block of blocks) {
    result += response.slice(cursor, block.start)
    try {
      const parsed = JSON.parse(block.json)
      if (!hasActionPayload(parsed)) {
        result += response.slice(block.start, block.end)
      }
    } catch {
      result += response.slice(block.start, block.end)
    }
    cursor = block.end
  }
  result += response.slice(cursor)

  return result.trim()
}

/**
 * Locate ```mousse-actions fences and extract their JSON payloads with a
 * string-aware brace balancer. Closing ``` is optional for extraction; nested
 * ``` markers inside JSON string values must not terminate the payload.
 */
function extractMousseActionBlocks(
  response: string
): Array<{ start: number; end: number; json: string }> {
  const blocks: Array<{ start: number; end: number; json: string }> = []
  const openTag = '```mousse-actions'
  let searchFrom = 0

  while (searchFrom < response.length) {
    const fenceStart = response.indexOf(openTag, searchFrom)
    if (fenceStart === -1) break

    const afterTag = fenceStart + openTag.length
    // Require a whitespace/newline boundary so ```mousse-actions-extra is ignored.
    if (afterTag < response.length && !/\s/.test(response[afterTag]!)) {
      searchFrom = afterTag
      continue
    }

    let i = afterTag
    while (i < response.length && /\s/.test(response[i]!)) i++

    const jsonStartChar = response[i]
    if (jsonStartChar !== '{' && jsonStartChar !== '[') {
      searchFrom = afterTag
      continue
    }

    const extracted = extractBalancedJson(response, i)
    if (!extracted) {
      searchFrom = afterTag
      continue
    }

    let end = extracted.end
    // Prefer consuming a trailing closing fence when present.
    let j = end
    while (j < response.length && /[ \t\r\n]/.test(response[j]!)) j++
    if (response.startsWith('```', j)) {
      end = j + 3
    }

    blocks.push({ start: fenceStart, end, json: extracted.json })
    searchFrom = end
  }

  return blocks
}

function extractBalancedJson(
  source: string,
  start: number
): { json: string; end: number } | null {
  const open = source[start]
  if (open !== '{' && open !== '[') return null

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < source.length; i++) {
    const ch = source[i]!

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }

    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '['
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return null
      }
      stack.pop()
      if (stack.length === 0) {
        return { json: source.slice(start, i + 1), end: i + 1 }
      }
    }
  }

  return null
}

export function filterActionsForChatMode(

  actions: OrchestratorAction[],

  mode: ChatMode

): OrchestratorAction[] {
  if (typeof mode === 'string') {
    const desc = defaultModeRegistry.getModeSync(mode, {})
    if (desc) {
      const allowed = desc.permission?.['task'] !== 'deny'
      if (allowed) return actions
      return actions.filter((a) => a.type !== 'complete_task')
    }
  }
  return filterActionsForMode(actions, mode)

}



export function rejectOrchestrationAction(action: OrchestratorAction, mode: ChatMode): boolean {
  if (typeof mode === 'string') {
    const desc = defaultModeRegistry.getModeSync(mode, {})
    if (desc) {
      const allowed = desc.permission?.['task'] !== 'deny'
      if (allowed) return false
      return action.type === 'complete_task'
    }
  }
  if (allowsOrchestrationActions(mode)) return false

  return action.type === 'complete_task'

}



function hasActionPayload(value: unknown): boolean {

  if (isValidAction(value)) return true

  if (!value || typeof value !== 'object') return false



  const obj = value as Record<string, unknown>

  return Array.isArray(obj.actions) && obj.actions.some((action) => isValidAction(action))

}



function isValidAction(a: unknown): a is OrchestratorAction {

  if (!a || typeof a !== 'object') return false

  const obj = a as Record<string, unknown>


  if (
    obj.type === 'complete_task' &&
    Array.isArray(obj.agentIds) &&
    obj.agentIds.length > 0 &&
    obj.agentIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) return true

  if (obj.type === 'message' && typeof obj.content === 'string') return true

  return false

}
