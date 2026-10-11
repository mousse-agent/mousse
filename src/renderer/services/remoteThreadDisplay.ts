import type { BridgeDisplayEvent } from '../../shared/bridge'
import type { ChatMessage, Thread } from '../../shared/types'

export interface RemoteView { thread: Thread; messages: ChatMessage[]; active: boolean; queued: number; questions: number; lastEvent?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const message = (value: unknown): value is ChatMessage => object(value) && typeof value.id === 'string' && typeof value.content === 'string' && ['user', 'assistant', 'system'].includes(String(value.role))
const thread = (value: unknown, id: string): value is Thread => object(value) && value.id === id && typeof value.name === 'string'

/** Display state only; these originals never enter a local executable thread. */
export function remoteDisplay(previous: RemoteView | undefined, event: BridgeDisplayEvent): RemoteView | undefined {
  if (event.update.kind === 'snapshot') {
    const value = event.update.value
    if (!object(value) || !thread(value.thread, event.ref.entityId) || !Array.isArray(value.messages) || !value.messages.every(message) || !Array.isArray(value.queue) || !Array.isArray(value.pendingQuestions) || !object(value.activeTurn)) throw new Error('Invalid remote thread view')
    return { thread: value.thread, messages: value.messages.slice(-2048), active: value.activeTurn.active === true, queued: value.queue.length, questions: value.pendingQuestions.length }
  }
  if (!previous) return previous
  const data = event.update.data
  if (!object(data)) throw new Error('Invalid remote thread update')
  if (data.threadId !== undefined && data.threadId !== event.ref.entityId) throw new Error('Remote thread mismatch')
  const next = { ...previous, lastEvent: event.update.type }
  switch (event.update.type) {
    case 'thread.message': case 'thread.message-updated': {
      if (!message(data.message)) throw new Error('Invalid remote message')
      const original = data.message, index = next.messages.findIndex(row => row.id === original.id)
      next.messages = index < 0 ? [...next.messages, original].slice(-2048) : next.messages.map((row, position) => position === index ? original : row)
      break
    }
    case 'thread.messages': {
      if (!Array.isArray(data.messages) || !data.messages.every(message)) throw new Error('Invalid remote messages')
      if (data.replace === true) next.messages = data.messages.slice(-2048)
      else { const rows = new Map(next.messages.map(row => [row.id, row])); for (const row of data.messages) rows.set(row.id, row); next.messages = [...rows.values()].slice(-2048) }
      break
    }
    case 'thread.metadata': if (!thread(data.thread, event.ref.entityId)) throw new Error('Invalid remote metadata'); else next.thread = data.thread; break
    case 'queue.updated': if (!Array.isArray(data.items)) throw new Error('Invalid remote queue'); else next.queued = data.items.length; break
    case 'turn.started': next.active = true; break
    case 'turn.completed': case 'turn.interrupted': case 'turn.aborted': next.active = false; break
  }
  return next
}
