import { isQualifiedId, qualifyId } from '../../../shared/threadRef'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Keys that hold a thread of the bot's computer (a thread its bot started, its chat's thread). */
const THREAD_KEYS = new Set(['threadId', 'homeThreadId'])
/** Objects whose `id` is a bot's: a summary (`bot`, `summary`) in a result or a stream record. */
const BOT_OBJECTS = new Set(['bot', 'summary'])
/** Free text is never read for ids. */
const TEXT_KEYS = new Set(['text', 'name', 'description', 'stateText', 'title', 'prompt', 'label'])
const MAX_DEPTH = 8

/**
 * A bot call's result, or a record of its chat, as this computer names what it holds: the bot and the threads of its
 * computer under qualified ids (`<node>:<id>`), so a window keys the bot by the same ref it called it by and opens its
 * threads on that computer. Every other id (a message, an ask, a reply) is the bot's own and stays as it is: it is
 * only ever sent back to the same bot.
 */
export function qualifyBotResult(node: string, value: unknown, key = '', depth = 0): unknown {
  if (depth > MAX_DEPTH) return value
  if (typeof value === 'string') return value && !isQualifiedId(value) && (key === 'botId' || THREAD_KEYS.has(key)) ? qualifyId(node, value) : value
  if (Array.isArray(value)) return value.map((item) => qualifyBotResult(node, item, key, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [name, inner] of Object.entries(value)) {
    if (TEXT_KEYS.has(name)) out[name] = inner
    else if (name === 'id' && BOT_OBJECTS.has(key) && typeof inner === 'string' && inner && !isQualifiedId(inner)) out[name] = qualifyId(node, inner)
    else out[name] = qualifyBotResult(node, inner, name, depth + 1)
  }
  return out
}
