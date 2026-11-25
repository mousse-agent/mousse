import { actionDigest, maskedActionData } from '../actions/BotActions'
import type { BotLane } from '../../../shared/bots/personal/definition'
import { memoryToolOf } from '../../../shared/bots/personal/memory'
import type { ChatMessage, ThreadData } from '../../../shared/types'
import type { BotJournal, BotJournalInput, BotStoreTx } from '../seams'
import { BotJournalError, type BotMemoryStore } from './BotMemoryStore'

/**
 * Capture (docs/plans/bot-context.md §4): copies the assistant and tool rows of every bot dispatch
 * into the journal. It reads threads through `ThreadDataStore.loadThreadData` (transactional
 * generations may be canonical), never `messages.json`, and keeps a cursor per thread in
 * `bot_memory_state`, so a run after a crash copies only what is new. Every row is keyed
 * `<threadId>:<messageId>`, so copying twice adds nothing. WP2's engine calls it after every
 * dispatch and once at startup (`catchUp`). A chat reply is journaled once: its chat row (`bm:<id>`)
 * stands for its home-thread copy, whichever of the two is written first (`BotMemoryStore.putCaptured`).
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
  /**
   * `ThreadDataStore.transcriptStamp`: what the thread's transcript files look like, without reading them. The startup
   * catch-up skips a thread whose stamp is the one its last copy saw, so it reads only threads written since.
   */
  transcriptStamp?: (threadId: string) => string | undefined
  /** Every bot thread, for the startup catch-up. */
  listThreads: () => BotThreadRef[]
  /** Whether a bot thread is one of its work's subagents' (`BotStore.threadRole`): its rows are marked as theirs. */
  isSubagentThread?: (threadId: string) => boolean
  asksFirstEnabled?: () => boolean
  log?: (message: string, error?: unknown) => void
}

/** How a subagent's rows begin in the journal: what its work's helper did or said, never the bot to its owner. */
export const SUBAGENT_JOURNAL_PREFIX = '[subagent] '

interface Cursor {
  /** Messages at the start of the thread that are copied and settled. */
  n: number
  /** The id of message `n - 1`, so a rewritten transcript is copied again from the start. */
  lastId: string | null
  /** The transcript's stamp (`transcriptStamp`) taken before the read this cursor came from. */
  stamp?: string
}

type CapturedRow = BotJournalInput & { at: string }

/** Presentation-only rows and hidden reasoning: never journaled. */
const SKIPPED_KINDS: ReadonlySet<string> = new Set([
  'thinking', 'progress', 'warning', 'context_compaction', 'context_cleared', 'context_handoff', 'plan_card', 'skill_loaded', 'provider_retry'
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

/** The refs a memory call names (`m12`, `m12v2`, `j123`), never its free text. */
function memoryRefsOf(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const args = input as Record<string, unknown>
  const values = [args.id, args.replaces, args.ref, ...(Array.isArray(args.refs) ? args.refs : [])]
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && /^[mj]\d{1,15}(?:v\d{1,9})?$/.test(value.trim())).map((value) => value.trim()))].slice(0, 100)
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
export function capturedRows(message: ChatMessage, ref: BotThreadRef, subagent = false, maskArguments = false, heldDigests: ReadonlySet<string> = new Set()): CapturedRow[] {
  const rows = botRows(message, ref, maskArguments, heldDigests)
  if (!subagent) return rows
  // A subagent of the bot's work: what it said is data it returned to the work (like a tool's result, from outside),
  // and its calls are not the bot's, so search, the packs and an export never show them as the bot's own words.
  return rows.map((row) => ({
    ...row,
    ...(row.kind === 'bot_msg' ? { kind: 'tool_result' as const, external: true } : {}),
    who: row.who === 'bot' ? 'tool' : row.who,
    text: `${SUBAGENT_JOURNAL_PREFIX}${row.text}`,
    json: { ...(row.json && typeof row.json === 'object' ? row.json as Record<string, unknown> : {}), subagent: true }
  }))
}

function botRows(message: ChatMessage, ref: BotThreadRef, maskArguments = false, heldDigests: ReadonlySet<string> = new Set()): CapturedRow[] {
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
    let input = message.toolCall?.input ?? (activity && 'input' in activity ? activity.input : undefined)
    // The progress journal owns this text. A captured JSON copy would outlive Forget.
    if (/(?:^|__)run_report$/.test(tool) && input && typeof input === 'object') {
      const { leftOff: _leftOff, ...report } = input as Record<string, unknown>
      input = report
    }
    const memory = memoryToolOf(tool)
    if (memory) {
      // A memory call is kept by its refs alone: its text, query or reason restates what a forget
      // removes, and its result repeats rows the journal already holds.
      const refs = memoryRefsOf(input)
      return [{ ...base, kind: 'tool_call', sourceKey: key, who: 'bot', text: [memory, ...refs].join(' '), json: { tool: memory, ...(refs.length ? { refs } : {}) } }]
    }
    // A card is kept by its kind alone: its words are on the message it went with, whose row Forget removes; a copy here
    // would outlive that. Its result says nothing of it.
    if (/(?:^|__)show_card$/.test(tool)) {
      const type = (input as { card?: { type?: unknown } } | undefined)?.card?.type
      const kind = typeof type === 'string' && /^[a-z]{1,20}$/.test(type) ? type : undefined
      return [{ ...base, kind: 'tool_call', sourceKey: key, who: 'bot', text: ['show_card', ...(kind ? [kind] : [])].join(' '), json: { tool: 'show_card', ...(kind ? { card: kind } : {}) } }]
    }
    const held = maskArguments && input !== undefined && heldDigests.has(actionDigest(input))
    if (maskArguments) input = maskedActionData(input) as typeof input
    const inputText = input === undefined ? '' : safeJson(input)
    const rows: CapturedRow[] = [{
      ...base,
      kind: 'tool_call',
      ...(held ? { external: true } : {}),
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
    if (memoryToolOf(tool)) return []
    const text = message.toolCall?.response ?? message.content
    return text ? [{ ...base, kind: 'tool_result', sourceKey: key, who: 'tool', external: true, text, json: { tool } }] : []
  }
  const images = message.images?.length ? `\n[${message.images.length} image${message.images.length === 1 ? '' : 's'}]` : ''
  const text = `${message.content ?? ''}${images}`.trim()
  if (!text) return []
  if (message.role === 'assistant') return [{ ...base, kind: 'bot_msg', sourceKey: key, who: 'bot', text }]
  return [{ ...base, kind: 'notice', sourceKey: key, who: 'mousse', text }]
}

/**
 * The refs of `BotStore.captureThreads()` rows: a run's thread is its activation's; a home or
 * context thread serves many activations, so its new rows belong to the latest dispatch that ran
 * there (a consult inside a chat is the chat's). Without one, the home thread is the chat and a
 * context thread a run.
 */
export function botThreadsForCatchUp(threads: ReadonlyArray<{ threadId: string; botId: string; role: string; activationId: string | null; lastActivation?: { id: string; lane: BotLane } | null }>): BotThreadRef[] {
  return threads.map((thread) => {
    if (thread.role === 'activation' && thread.activationId) return { botId: thread.botId, threadId: thread.threadId, lane: 'run', activationId: thread.activationId }
    const last = thread.lastActivation
    if (last) return { botId: thread.botId, threadId: thread.threadId, lane: last.lane, activationId: last.id }
    return { botId: thread.botId, threadId: thread.threadId, lane: thread.role === 'home' ? 'chat' : 'run', activationId: thread.activationId }
  })
}

export type BotJournalCapture = BotJournal & {
  /** One thread, synchronously: what `syncThread` runs. Returns how many rows it handed to the journal. */
  syncNow(ref: BotThreadRef): number
}

export function createBotJournal(options: BotJournalCaptureOptions): BotJournalCapture {
  const { store } = options
  const log = options.log ?? (() => {})

  const stampOf = (threadId: string): string | undefined => {
    try {
      return options.transcriptStamp?.(threadId)
    } catch {
      // No stamp: the thread is read, as it would be without one.
      return undefined
    }
  }

  const syncNow = (ref: BotThreadRef, skipUnchanged = false): number => {
    const cursorKey = `cursor:${ref.threadId}`
    // Taken before the read: a write during or after it gives the next look a different stamp.
    const stamp = stampOf(ref.threadId)
    if (skipUnchanged && stamp !== undefined && store.getState<Cursor>(ref.botId, cursorKey)?.stamp === stamp) return 0
    let messages: ChatMessage[]
    try {
      messages = options.readThread(ref.threadId)?.messages ?? []
    } catch (error) {
      // An unreadable thread is not a journal failure: the cursor stays, and the next sync retries.
      log(`bot memory: thread ${ref.threadId} could not be read for capture`, error)
      return 0
    }
    let subagent = false
    try {
      subagent = options.isSubagentThread?.(ref.threadId) === true
    } catch (error) {
      // Not known: the thread waits for the next sync rather than being copied as the bot's own words.
      log(`bot memory: thread ${ref.threadId} could not be told apart`, error)
      return 0
    }
    return store.write(() => {
      const saved = store.getState<Cursor>(ref.botId, cursorKey)
      let start = saved && saved.n <= messages.length && (saved.n === 0 || messages[saved.n - 1]?.id === saved.lastId) ? saved.n : 0
      let settledPrefix = true
      let written = 0
      const heldDigests = options.asksFirstEnabled?.() === true && ref.activationId ? store.storedActionDigests(ref.activationId) : new Set<string>()
      const maskArguments = heldDigests.size > 0
      for (let index = start; index < messages.length; index++) {
        const message = messages[index]!
        const partial = unsettled(message)
        for (const row of capturedRows(message, ref, subagent, maskArguments, heldDigests)) {
          store.putCaptured(row, partial)
          written++
        }
        if (partial) settledPrefix = false
        if (settledPrefix) start = index + 1
      }
      const lastId = messages[start - 1]?.id ?? null
      if (!saved || saved.n !== start || saved.lastId !== lastId || saved.stamp !== stamp)
        store.setState(ref.botId, cursorKey, { n: start, lastId, ...(stamp !== undefined ? { stamp } : {}) } satisfies Cursor)
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
      // One thread that cannot be copied never stops the others; a bot whose journal cannot be
      // written is returned, so the engine marks it stuck.
      const failedBots = new Set<string>()
      for (const thread of threads) {
        if (failedBots.has(thread.botId)) continue
        try {
          syncNow(thread, true)
        } catch (error) {
          log(`bot memory: thread ${thread.threadId} could not be caught up`, error)
          if (error instanceof BotJournalError) failedBots.add(thread.botId)
        }
      }
      return { failedBots: [...failedBots] }
    },
    syncNow: (ref) => syncNow(ref)
  }
}
