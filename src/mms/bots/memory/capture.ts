import type { BotLane } from '../../../shared/bots/personal/definition'
import type { ChatMessage, ThreadData } from '../../../shared/types'
import type { BotJournal, BotJournalInput, BotStoreTx } from '../seams'
import { BotJournalError, type BotMemoryStore } from './BotMemoryStore'

/**
 * Capture (docs/plans/bot-context.md §4): copies the assistant and tool rows of every bot dispatch
 * into the journal. It reads threads through `ThreadDataStore.loadThreadData` (transactional
 * generations may be canonical), never `messages.json`, and keeps a cursor per thread in
 * `bot_memory_state`, so a run after a crash copies only what is new. Every row is keyed
 * `<threadId>:<messageId>`, so copying twice adds nothing. WP2's engine calls it after every
 * dispatch and once at startup (`catchUp`).
 */

/** A bot thread to copy: the home thread is the chat lane; run and consult threads, their activation's lane. */
export interface BotThreadRef {
  botId: string
  threadId: string
  lane: BotLane
  activationId?: string | null
}

export interface BotJournalCaptureOptions {
  store: BotMemoryStore
  /** `ThreadDataStore.loadThreadData`. */
  readThread: (threadId: string) => Pick<ThreadData, 'messages'> | undefined
  /** Every bot thread, for the startup catch-up. */
  listThreads: () => BotThreadRef[]
  log?: (message: string, error?: unknown) => void
}

interface Cursor {
  /** Messages at the start of the thread that are copied and settled. */
  n: number
  /** The id of message `n - 1`, so a rewritten transcript is copied again from the start. */
  lastId: string | null
}

type CapturedRow = BotJournalInput & { at: string }

/** Presentation-only rows and hidden reasoning: never journaled. */
const SKIPPED_KINDS: ReadonlySet<string> = new Set([
  'thinking', 'progress', 'warning', 'context_compaction', 'context_cleared', 'context_handoff', 'plan_card', 'skill_loaded'
])
const CALL_KINDS: ReadonlySet<string> = new Set(['tool_call', 'mcp_tool_call', 'build_tool_call'])
const RESULT_KINDS: ReadonlySet<string> = new Set(['mcp_tool_result', 'build_tool_result'])
/** Tool inputs larger than this stay out of the row's JSON; the row's text keeps their head and tail. */
const MAX_INPUT_JSON_CHARS = 16 * 1024

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** A row still being written when it was read: a tool call that had not returned. */
export function unsettled(message: ChatMessage): boolean {
  return message.toolCall?.status === 'processing' || message.activity?.status === 'running'
}

/**
 * The journal rows one thread message becomes: assistant text as `bot_msg`; a tool call as a
 * `tool_call` row with its input, and its response head as a `tool_result` row from outside;
 * every other non-presentation row the dispatch was given (its prompt, a wall answer) as a
 * `notice` from Mousse.
 */
export function capturedRows(message: ChatMessage, ref: BotThreadRef): CapturedRow[] {
  const kind = message.kind ?? 'message'
  if (SKIPPED_KINDS.has(kind) || message.role === 'system') return []
  const base = {
    botId: ref.botId,
    lane: ref.lane,
    ...(ref.activationId ? { activationId: ref.activationId } : {}),
    threadId: ref.threadId,
    at: message.timestamp || new Date(0).toISOString()
  }
  const key = `${ref.threadId}:${message.id}`
  if (CALL_KINDS.has(kind)) {
    const activity = message.activity
    const tool = message.toolCall?.toolName ?? activity?.toolName ?? message.toolCall?.title ?? 'tool'
    const input = message.toolCall?.input ?? (activity && 'input' in activity ? activity.input : undefined)
    const inputText = input === undefined ? '' : safeJson(input)
    const rows: CapturedRow[] = [{
      ...base,
      kind: 'tool_call',
      sourceKey: key,
      who: 'bot',
      text: `${tool} ${inputText || message.toolCall?.summary || ''}`.trim(),
      json: { tool, ...(input !== undefined && inputText.length <= MAX_INPUT_JSON_CHARS ? { input } : {}) }
    }]
    const response = message.toolCall?.response ?? (activity && 'output' in activity ? activity.output : undefined)
    if (typeof response === 'string' && response)
      rows.push({ ...base, kind: 'tool_result', sourceKey: `${key}:result`, who: 'tool', external: true, text: response, json: { tool } })
    return rows
  }
  if (RESULT_KINDS.has(kind)) {
    const tool = message.toolCall?.toolName ?? message.toolCall?.title ?? 'tool'
    const text = message.toolCall?.response ?? message.content
    return text ? [{ ...base, kind: 'tool_result', sourceKey: key, who: 'tool', external: true, text, json: { tool } }] : []
  }
  const images = message.images?.length ? `\n[${message.images.length} image${message.images.length === 1 ? '' : 's'}]` : ''
  const text = `${message.content ?? ''}${images}`.trim()
  if (!text) return []
  if (message.role === 'assistant') return [{ ...base, kind: 'bot_msg', sourceKey: key, who: 'bot', text }]
  return [{ ...base, kind: 'notice', sourceKey: key, who: 'mousse', text }]
}

/** The lane of a `BotStore.allThreads()` row: the home thread is the chat; activation and context threads are runs. */
export function botThreadsForCatchUp(threads: ReadonlyArray<{ threadId: string; botId: string; role: string; activationId: string | null }>): BotThreadRef[] {
  return threads.map((thread) => ({ botId: thread.botId, threadId: thread.threadId, lane: thread.role === 'home' ? 'chat' : 'run', activationId: thread.activationId }))
}

export type BotJournalCapture = BotJournal & {
  /** One thread, synchronously: what `syncThread` runs. Returns how many rows it handed to the journal. */
  syncNow(ref: BotThreadRef): number
}

export function createBotJournal(options: BotJournalCaptureOptions): BotJournalCapture {
  const { store } = options
  const log = options.log ?? (() => {})

  const syncNow = (ref: BotThreadRef): number => {
    let messages: ChatMessage[]
    try {
      messages = options.readThread(ref.threadId)?.messages ?? []
    } catch (error) {
      // An unreadable thread is not a journal failure: the cursor stays, and the next sync retries.
      log(`bot memory: thread ${ref.threadId} could not be read for capture`, error)
      return 0
    }
    const cursorKey = `cursor:${ref.threadId}`
    return store.write(() => {
      const saved = store.getState<Cursor>(ref.botId, cursorKey)
      let start = saved && saved.n <= messages.length && (saved.n === 0 || messages[saved.n - 1]?.id === saved.lastId) ? saved.n : 0
      let settledPrefix = true
      let written = 0
      for (let index = start; index < messages.length; index++) {
        const message = messages[index]!
        const partial = unsettled(message)
        for (const row of capturedRows(message, ref)) {
          store.putCaptured(row, partial)
          written++
        }
        if (partial) settledPrefix = false
        if (settledPrefix) start = index + 1
      }
      const lastId = messages[start - 1]?.id ?? null
      if (!saved || saved.n !== start || saved.lastId !== lastId) store.setState(ref.botId, cursorKey, { n: start, lastId } satisfies Cursor)
      return written
    })
  }

  return {
    appendInTx: (tx: BotStoreTx, row: BotJournalInput) => {
      store.appendInTx(tx, row)
    },
    syncThread: async (input) => {
      syncNow(input)
    },
    catchUp: async () => {
      let threads: BotThreadRef[]
      try {
        threads = options.listThreads()
      } catch (error) {
        throw new BotJournalError(error)
      }
      for (const thread of threads) syncNow(thread)
    },
    syncNow
  }
}
