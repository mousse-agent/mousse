import type { ChatMessage } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'

export interface FinalResponseLayout {
  finalResponseId: string | null
  workMessageIds: Set<string>
  workedForMs: number
}

function isResponse(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    !isToolTimelineMessage(message) &&
    !message.streaming &&
    !message.incomplete
  )
}

/** Plan cards stay expanded in the transcript; they must never be folded into work. */
export function isPlanCardMessage(message: Pick<ChatMessage, 'kind'>): boolean {
  return message.kind === 'plan_card'
}

/**
 * Locate the one final response in the current transcript and the implementation trace
 * immediately preceding it in the latest turn. Earlier user-visible conversation remains
 * expanded; only thinking/tool/progress entries from the final turn are folded.
 */
export function getFinalResponseLayout(messages: ChatMessage[]): FinalResponseLayout {
  let finalIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isResponse(messages[index])) {
      finalIndex = index
      break
    }
  }
  if (finalIndex < 0) {
    return { finalResponseId: null, workMessageIds: new Set(), workedForMs: 0 }
  }

  let userIndex = -1
  for (let index = finalIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userIndex = index
      break
    }
  }

  const workMessageIds = new Set<string>()
  for (let index = userIndex + 1; index < finalIndex; index += 1) {
    // Keep generated plan previews visible; folding them into the work pill hides
    // the in-conversation PlanCard (and its Markdown) from both chat surfaces.
    if (isPlanCardMessage(messages[index])) continue
    workMessageIds.add(messages[index].id)
  }

  const startedAt = userIndex >= 0 ? Date.parse(messages[userIndex].timestamp) : Number.NaN
  const finishedAt = Date.parse(messages[finalIndex].timestamp)
  const workedForMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : 0

  return { finalResponseId: messages[finalIndex].id, workMessageIds, workedForMs }
}

export function formatWorkedFor(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return `Worked for ${hours ? `${hours}hrs ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`
}
