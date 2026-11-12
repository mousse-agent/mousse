import { MAX_BOT_MEMORY_TEXT_CHARS } from '../../../shared/bots/personal/memory'
import type { BotMemoryStore } from './BotMemoryStore'

/**
 * The missed-wish fallback: when the owner tells the bot in the chat how it should behave from now
 * on ("from now on don't use em dashes") and the turn ends without any `memory_save`, the message
 * is saved as an owner entry, verbatim, so it outlives the chat window. It stays in About → Memory
 * like any other entry, removable there.
 *
 * The match is deliberately narrow; a message the bot should have kept but this misses costs one
 * repeat, a one-off saved by mistake shapes every later turn. A message is a standing wish when it
 * - is short (one or two sentences, at most 240 characters), not a question, not a Mousse notice;
 * - names no single occasion ("this email", "right now", "tomorrow", "for now");
 * - and either says it lasts ("from now on", "going forward", "in future", "every time",
 *   "whenever", or opens with "always"/"never", or "you always/never…") and is addressed to the bot
 *   or is a directive, or opens with a directive ("don't", "do not", "stop", "quit", "no more",
 *   "please don't") and names how the bot writes or behaves (em dashes, emoji, tone, replies…).
 */

const MAX_WISH_CHARS = 240

const LASTING = /\b(from now on|going forward|in (the )?future|from today on|every time|whenever)\b|^(please\s+)?(always|never)\b|\byou\s+(should\s+|must\s+)?(always|never)\b/
const DIRECTIVE = /^(please\s+)?(don'?t|do not|stop|quit|no more|never|always)\b/
const ADDRESSED = /\b(you|your)\b/
const STYLE = new RegExp(String.raw`\b(` + [
  'em[ -]?dash(es)?', 'dash(es)?', 'emojis?', 'exclamation( marks?)?', 'tone', 'formal(ly)?', 'casual(ly)?', 'style', 'format(ting)?',
  'bullets?( points?)?', 'markdown', 'headings?', 'caps', 'capitals?', 'lowercase', 'uppercase', 'jargon', 'slang', 'swear(ing)?',
  'repl(y|ies|ying)', 'respond(ing)?', 'responses?', 'answers?', 'words?', 'sentences?', 'paragraphs?',
  'long', 'short', 'brief', 'concise', 'verbose', 'wordy', 'length', 'summar(y|ies|ize|ise)', 'apologi[sz](e|ing)', 'sorry',
  'call me', 'address me', 'sign[ -]?off', 'greetings?', 'english', 'language', 'ask me', 'check with me', 'ping me', 'interrupt'
].join('|') + String.raw`)\b`)
/** A single occasion: the message is about this once, not about how the bot behaves. */
const ONE_OFF = /\b(this|that) (one|email|message|time|thread|file|run|task|page|doc(ument)?)\b|\b(right now|for now|just now|today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week)|next week|yet|until|never mind|nevermind)\b/
const MOUSSE_NOTICE = /^\[Mousse /

/** Whether an owner message is a lasting instruction about the bot's behaviour or style. */
export function isStandingWish(message: string): boolean {
  const text = message.trim()
  if (text.length < 8 || text.length > MAX_WISH_CHARS || MOUSSE_NOTICE.test(text)) return false
  if (text.includes('?') || text.split(/\n\s*\n/).length > 1) return false
  if ((text.match(/[.!](\s|$)/g) ?? []).length > 2) return false
  const lower = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
  if (ONE_OFF.test(lower)) return false
  const directive = DIRECTIVE.test(lower)
  if (LASTING.test(lower)) return directive || ADDRESSED.test(lower) || STYLE.test(lower)
  return directive && STYLE.test(lower)
}

/** Words that frame a wish rather than say it ("The owner wants…", "From now on, please never…"). */
const FRAMING = new Set(("the a an owner owner's wants want wanted asked asks i i'd i'm me my mine you you're your yours to in on of for at by "
  + 'use using used please always never no not don\'t dont do does stop quit more from now going forward future be is are it its and or with any ever so too').split(' '))
const NEGATION = /\b(never|no|not|don'?t|do not|stop|quit|no more)\b/

/** The words that carry a text's meaning, for comparing entries. */
function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/)
  return new Set(words.filter((word) => word && !FRAMING.has(word)))
}

/**
 * Whether `text` says what an existing entry says: the same polarity (both "never…" or both
 * "always…", so a reversal is kept) and the same content words, one set inside the other, or at
 * least 80% of them shared. "From now on, no em dashes" duplicates "The owner wants no em dashes".
 */
export function nearDuplicate(text: string, existing: readonly string[]): boolean {
  const mine = contentWords(text)
  if (!mine.size) return true
  const negative = NEGATION.test(text.toLowerCase().replace(/[’‘]/g, "'"))
  return existing.some((entry) => {
    if (NEGATION.test(entry.toLowerCase().replace(/[’‘]/g, "'")) !== negative) return false
    const theirs = contentWords(entry)
    if (!theirs.size) return false
    const shared = [...mine].filter((word) => theirs.has(word)).length
    if (shared === Math.min(mine.size, theirs.size) && shared >= 2) return true
    return shared / new Set([...mine, ...theirs]).size >= 0.8
  })
}

/**
 * After a chat dispatch that settled: the owner's standing wishes since the last check that the
 * activation never saved are saved as owner entries. Checked messages are not looked at again.
 * Returns the saved texts.
 */
export function saveMissedWishes(store: BotMemoryStore, botId: string, activationId: string): string[] {
  const cursorKey = 'wish_check_seq'
  const after = store.getState<number>(botId, cursorKey) ?? 0
  const { owner, saved } = store.activationSince(botId, activationId, typeof after === 'number' ? after : 0)
  const kept: string[] = []
  if (!saved) {
    for (const row of owner) {
      const text = row.text.trim()
      if (text.length > MAX_BOT_MEMORY_TEXT_CHARS || !isStandingWish(text)) continue
      const current = store.active(botId).filter((entry) => entry.kind !== 'run_note').map((entry) => entry.text ?? '')
      if (nearDuplicate(text, current)) continue
      const result = store.save(botId, { lane: 'chat', kind: 'owner', text, activationId })
      if (!('error' in result)) kept.push(text)
    }
  }
  // Past every row so far, the saves above too: the next check starts with the next message.
  store.write(() => store.setState(botId, cursorKey, store.lastSeq(botId)))
  return kept
}
