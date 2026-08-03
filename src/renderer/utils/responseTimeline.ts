import type { ChatMessage } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'

export interface FinalResponseLayout {
  finalResponseId: string | null
  workMessageIds: Set<string>
  workedForMs: number
}

export interface ActiveResponseLayout {
  workMessageIds: Set<string>
  startedAt: string | null
}

export interface ResponseTurnWorkLayout {
  turnId: string
  workMessageIds: Set<string>
  firstWorkMessageId: string
  startedAt: string
  durationMs: number
}

/** User-facing assistant text can arrive in several blocks around tool calls. Keep the
 * persisted timeline lossless, but render those blocks as one response for each turn. */
export function coalesceAssistantMessagesForDisplay(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let assistantIndex: number | null = null
  let assistantTurnId: string | null = null

  const resetAssistant = () => {
    assistantIndex = null
    assistantTurnId = null
  }

  for (const message of messages) {
    if (message.role === 'user') {
      resetAssistant()
      result.push(message)
      continue
    }

    const canCoalesce =
      message.role === 'assistant' &&
      !message.kind &&
      !message.toolCall &&
      !isToolTimelineMessage(message)

    if (!canCoalesce) {
      // Plan cards are intentionally standalone UI; do not absorb later text into them.
      if (message.kind === 'plan_card') resetAssistant()
      result.push(message)
      continue
    }

    let turnId: string | null = null
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index].role === 'user') {
        turnId = result[index].id
        break
      }
    }
    if (assistantIndex === null || assistantTurnId !== turnId) {
      assistantIndex = result.length
      assistantTurnId = turnId
      result.push(message)
      continue
    }

    const previous = result[assistantIndex]
    const joinedContent = [previous.content.trim(), message.content.trim()]
      .filter(Boolean)
      .join('\n\n')
    result[assistantIndex] = {
      ...previous,
      ...message,
      id: previous.id,
      content: joinedContent,
      timestamp: message.timestamp
    }
  }

  return result
}

export function isResponseWorkMessage(message: ChatMessage): boolean {
  return (
    isToolTimelineMessage(message) ||
    message.kind === 'progress' ||
    message.kind === 'warning'
  )
}

function isResponse(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    !isToolTimelineMessage(message) &&
    !message.streaming
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
    if (isPlanCardMessage(messages[index]) || messages[index].kind === 'context_compaction') continue
    // Provider streams may emit complete text blocks before tools and then continue.
    // Those are still user-facing assistant responses, not implementation trace entries.
    if (messages[index].role === 'assistant' && !isToolTimelineMessage(messages[index])) continue
    workMessageIds.add(messages[index].id)
  }

  const startedAt = userIndex >= 0 ? Date.parse(messages[userIndex].timestamp) : Number.NaN
  const finishedAt = Date.parse(messages[finalIndex].timestamp)
  const workedForMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : 0

  return { finalResponseId: messages[finalIndex].id, workMessageIds, workedForMs }
}

/** Collect implementation trace entries from the latest unfinished user turn. */
export function getActiveResponseLayout(messages: ChatMessage[]): ActiveResponseLayout {
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return { workMessageIds: new Set(), startedAt: null }

  const workMessageIds = new Set<string>()
  for (const message of messages.slice(userIndex + 1)) {
    if (isPlanCardMessage(message) || message.kind === 'context_compaction') continue
    // Assistant text remains outside the work disclosure; the renderer coalesces
    // multiple text blocks from this turn into one user-facing response.
    if (message.role === 'assistant' && !isToolTimelineMessage(message)) continue
    workMessageIds.add(message.id)
  }

  return { workMessageIds, startedAt: messages[userIndex].timestamp }
}

/** Build one deterministic work disclosure for every user turn. */
export function getResponseTurnWorkLayouts(messages: ChatMessage[]): ResponseTurnWorkLayout[] {
  const layouts: ResponseTurnWorkLayout[] = []

  for (let userIndex = 0; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex]
    if (userMessage.role !== 'user') continue

    let turnEnd = messages.length
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === 'user') {
        turnEnd = index
        break
      }
    }

    const turnMessages = messages.slice(userIndex + 1, turnEnd)
    const workMessages = turnMessages.filter(isResponseWorkMessage)
    if (workMessages.length === 0) continue

    const startedAtMs = Date.parse(userMessage.timestamp)
    const finishedAtMs = Date.parse(turnMessages.at(-1)?.timestamp ?? userMessage.timestamp)
    layouts.push({
      turnId: userMessage.id,
      workMessageIds: new Set(workMessages.map((message) => message.id)),
      firstWorkMessageId: workMessages[0].id,
      startedAt: userMessage.timestamp,
      durationMs: Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : 0
    })

    userIndex = turnEnd - 1
  }

  return layouts
}

export function formatWorkedFor(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return `Worked for ${hours ? `${hours}hrs ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`
}

export function formatWorkingFor(milliseconds: number): string {
  return formatWorkedFor(milliseconds).replace('Worked for', 'Working ·').concat(' elapsed')
}
