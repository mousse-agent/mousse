import type { AgentOrigin } from './types'

/**
 * The words an agent wrote, from a message stored with its origin: the text between the header Mousse wrote and the
 * closing line (`AgentOrigin.body`). The whole text when the origin says nothing about them (a message stored before
 * it did, a bot's, an agent's note on its own thread) or when the lengths do not fit the text.
 */
export function agentMessageWords(content: string, origin: Pick<AgentOrigin, 'kind' | 'body'> | { kind: string } | null | undefined): string {
  const body = origin?.kind === 'agent' ? (origin as Pick<AgentOrigin, 'body'>).body : undefined
  if (!body || !Number.isSafeInteger(body.head) || !Number.isSafeInteger(body.tail) || body.head < 0 || body.tail < 0) return content
  const end = content.length - body.tail
  return body.head <= end ? content.slice(body.head, end) : content
}
