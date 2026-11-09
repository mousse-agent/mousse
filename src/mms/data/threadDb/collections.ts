/**
 * How a thread's data maps onto `thread.db`: ordered collections of rows, one row per message, and a few small
 * state values. Every message is stored once, in the collection it belongs to:
 *
 * - `m`: the transcript (`ChatMessage`, what people see);
 * - `c:a` / `c:r`: the model context's active and retired messages (`NativeLlmContext.messages` and
 *   `.retiredMessages`, what the model is sent; after compaction they differ from the transcript);
 * - `s:<n>:m`, `s:<n>:h`, `s:<n>:ca`, `s:<n>:cr`: the same three for Mousse subagent session `n`.
 *
 * State keys: `agents`, `tasks`, `context` (the context without its message arrays), `sessions` (the session
 * headers without theirs). A missing `context` state means the thread has no model context.
 */
import type { ThreadData } from '../../../shared/types'

export const TRANSCRIPT = 'm'

export interface Decomposed {
  collections: Map<string, unknown[]>
  state: Map<string, unknown>
}

/** What `loadThreadData` returns besides the queue, which stays in `queue.json`. */
export type StoredThreadData = Omit<ThreadData, 'messageQueue'>

type Loose = Record<string, unknown>

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The header of a model context, with `$retired` saying whether it had a retired list. */
function contextHeader(context: Loose, prefix: string, collections: Map<string, unknown[]>): Loose {
  const { messages, retiredMessages, ...header } = context
  collections.set(`${prefix}a`, Array.isArray(messages) ? messages : [])
  if (Array.isArray(retiredMessages)) collections.set(`${prefix}r`, retiredMessages)
  return { ...header, $retired: Array.isArray(retiredMessages) }
}

function contextFrom(header: Loose, prefix: string, collections: Map<string, unknown[]>): Loose {
  const { $retired, ...rest } = header
  const context: Loose = { ...rest, messages: collections.get(`${prefix}a`) ?? [] }
  if ($retired === true) context.retiredMessages = collections.get(`${prefix}r`) ?? []
  // Keep the field order the app writes, so exports diff cleanly against the files they came from.
  return context
}

export function decompose(data: StoredThreadData): Decomposed {
  const collections = new Map<string, unknown[]>()
  const state = new Map<string, unknown>()
  collections.set(TRANSCRIPT, data.messages)
  state.set('agents', data.agents)
  state.set('tasks', data.tasks)
  if (data.llmContext) state.set('context', contextHeader(data.llmContext as unknown as Loose, 'c:', collections))
  const sessions = data.mousseAgentSessions ?? []
  if (sessions.length) {
    state.set('sessions', sessions.map((session, index) => {
      const { messages, history, nativeContext, ...header } = session as unknown as Loose
      collections.set(`s:${index}:m`, Array.isArray(messages) ? messages : [])
      if (Array.isArray(history)) collections.set(`s:${index}:h`, history)
      const out: Loose = { ...header, $history: Array.isArray(history) }
      if (isRecord(nativeContext)) out.$context = contextHeader(nativeContext, `s:${index}:c`, collections)
      return out
    }))
  }
  return { collections, state }
}

export function compose(collections: Map<string, unknown[]>, state: Map<string, unknown>): StoredThreadData {
  const data: StoredThreadData = {
    messages: (collections.get(TRANSCRIPT) ?? []) as ThreadData['messages'],
    agents: (state.get('agents') ?? []) as ThreadData['agents'],
    tasks: (state.get('tasks') ?? []) as ThreadData['tasks'],
    llmContext: undefined,
    mousseAgentSessions: []
  }
  const context = state.get('context')
  if (isRecord(context)) data.llmContext = contextFrom(context, 'c:', collections) as unknown as ThreadData['llmContext']
  const sessions = state.get('sessions')
  if (Array.isArray(sessions)) {
    data.mousseAgentSessions = sessions.map((header, index) => {
      const { $history, $context, ...rest } = header as Loose
      const session: Loose = { ...rest, messages: collections.get(`s:${index}:m`) ?? [] }
      if ($history === true) session.history = collections.get(`s:${index}:h`) ?? []
      if (isRecord($context)) session.nativeContext = contextFrom($context, `s:${index}:c`, collections)
      return session
    }) as unknown as ThreadData['mousseAgentSessions']
  }
  return data
}

/** The fields a transcript row is indexed by. */
export function rowFields(collection: string, value: unknown): { msgId: string | null; role: string | null; kind: string | null; ts: string | null } {
  if (collection !== TRANSCRIPT && !/^s:\d+:m$/.test(collection)) return { msgId: null, role: null, kind: null, ts: null }
  const record = isRecord(value) ? value : {}
  const ts = record.timestamp
  return {
    msgId: typeof record.id === 'string' ? record.id : null,
    role: typeof record.role === 'string' ? record.role : null,
    kind: typeof record.kind === 'string' ? record.kind : null,
    ts: typeof ts === 'string' ? ts : typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toISOString() : null
  }
}

/** A comparable form of thread data: what JSON keeps, with no sessions and an empty session list made equal. */
export function normalizedForCompare(data: StoredThreadData): string {
  return JSON.stringify({
    messages: data.messages,
    agents: data.agents,
    tasks: data.tasks,
    llmContext: data.llmContext ?? null,
    mousseAgentSessions: data.mousseAgentSessions?.length ? data.mousseAgentSessions : []
  }, sortedKeys)
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value
  const out: Loose = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key]
  return out
}
