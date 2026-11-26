/**
 * The one way Mousse marks what it puts into an agent's or a bot's context that no person typed: a notice
 * (`<mousse_notice>`, facts Mousse wrote, with outside text nested as `<quoted>`) or a message relayed from someone
 * (`<mousse_message>`). Content is never entity-escaped: code such as `cd x && npm test` or `<div>` reaches the model
 * byte for byte. Only this family's own opening and closing tags are broken (`defuse`), so quoted text cannot end a
 * block early or open one of its own. Browser-safe.
 *
 * `reply` says what the block asks of the turn, explained once in the standing instructions: `if-needed` on turns
 * that may end with no reply (a bot's wake-up, job notice or another bot's message), `required` on the owner's own
 * words. Absent, nothing is asked beyond what the text says.
 */

/** What a notice is about. */
export type MousseNoticeKind =
  | 'thread_watch'
  | 'subagent_result'
  | 'subagent_question'
  | 'subagent_stopped'
  | 'subagent_lacks'
  | 'bot_wake'
  | 'bot_action'
  | 'work_wait'
  | 'job_update'
  | 'work_note'
  | 'thread_message'
  | 'bot_message'
  | 'bot_subagent'
  | 'bot_action'
  | 'question_answered'
  | 'question_dismissed'
  | 'agent_note'
  | 'monitor_event'
  | 'thread_wake'

export type MousseReply = 'if-needed' | 'required'

/** Outside text inside a notice: data from `from`, never instructions. */
export interface QuotedPart {
  readonly quoted: true
  readonly from: string
  readonly text: string
}

/** A person's own words inside a notice (`<mousse_message>`): they keep the authority of who wrote them. */
export interface RelayedPart {
  readonly relayed: true
  readonly from: string
  readonly text: string
}

/** One part of a notice: Mousse's own words, quoted outside text, or a person's relayed words. */
export type NoticePart = string | QuotedPart | RelayedPart

const TAGS = 'mousse_notice|mousse_message|quoted'
/** An opening or closing tag of this family, any case, with optional whitespace or slash after the `<`. */
const FAMILY_TAG = new RegExp(String.raw`<(?=\s*\/?\s*(?:${TAGS})(?![\w-]))`, 'gi')

/**
 * Breaks every opening and closing tag of this family in `text` (`<` becomes `‹`), and nothing else: `&&`, `&lt;`,
 * `<div>` and `<quotes>` stay as they are.
 */
export function defuse(text: string): string {
  return text.replace(FAMILY_TAG, '‹')
}

/** An attribute value on one line, with no quote or angle bracket to end the tag with. */
function attr(value: string, max = 120): string {
  return value.replace(/[\u0000-\u001f\u007f"“”<>‹›]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

/** Outside text for a notice, labelled with where it came from. */
export function quoted(from: string, text: string): QuotedPart {
  return { quoted: true, from, text }
}

/** A person's words for a notice, relayed as they wrote them. */
export function relayed(from: string, text: string): RelayedPart {
  return { relayed: true, from, text }
}

function part(value: NoticePart): string {
  if (typeof value === 'string') return defuse(value)
  if ('relayed' in value) return message({ from: value.from }, value.text)
  return `<quoted from="${attr(value.from) || 'outside'}">\n${defuse(value.text)}\n</quoted>`
}

/** A notice Mousse writes: its kind, what it asks of the turn, the id it is about, then its parts. */
export function notice(head: { kind: MousseNoticeKind; reply?: MousseReply; ref?: string }, parts: readonly NoticePart[]): string {
  const ref = head.ref ? attr(head.ref) : ''
  const open = `<mousse_notice kind="${head.kind}"${head.reply ? ` reply="${head.reply}"` : ''}${ref ? ` ref="${ref}"` : ''}>`
  const body = parts.map(part).filter((text) => text.trim()).join('\n\n')
  return `${open}\n${body}\n</mousse_notice>`
}

/** Someone's words, relayed as they wrote them. */
export function message(head: { from: string; reply?: MousseReply }, text: string): string {
  return `<mousse_message from="${attr(head.from) || 'someone'}"${head.reply ? ` reply="${head.reply}"` : ''}>\n${defuse(text)}\n</mousse_message>`
}

/** The bracket forms Mousse wrote before these tags; stored transcripts still hold them. */
const LEGACY = /^\[Mousse(?:\]| )/
const CURRENT = /^<mousse_(?:notice|message)(?![\w-])/

/**
 * Whether `text` is something Mousse put into the context rather than a person's words: one of these blocks, or a
 * legacy bracket form (`[Mousse notice…`, `[Mousse] …`, `[Mousse workflow admission]`).
 */
export function isMousseContext(text: string): boolean {
  const start = text.trimStart()
  return CURRENT.test(start) || LEGACY.test(start)
}
