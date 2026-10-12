/**
 * Handoff budget and history selection (docs/run-engine/SPEC.md §16.1). Pure: the handoff service
 * and the tests call these with transcript items; nothing here reads the database.
 */

export const DEFAULT_HANDOFF_TOKEN_CAP = 16_000
export const MIN_HANDOFF_TOKEN_CAP = 1_000
export const MAX_HANDOFF_TOKEN_CAP = 64_000
/** Windows above this are treated as this size: a bigger window does not buy a bigger handoff. */
export const MAX_HANDOFF_WINDOW = 128_000
/** The smallest share of the window kept free for the reply and the provider's own prompt. */
export const MIN_WINDOW_RESERVE = 16_000
export const IMAGE_RESERVATION_TOKENS = 8_192
export const ATTACHMENT_RESERVATION_TOKENS = 4_096
/** A text item that does not fit whole is cut to at most this many characters. */
export const COMPACTED_ITEM_CHARS = 240

/** `MOUSSE_HANDOFF_TOKEN_CAP`, clamped to 1k–64k; the default when unset or not a number. */
export function handoffTokenCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MOUSSE_HANDOFF_TOKEN_CAP
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return clampCap(Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_HANDOFF_TOKEN_CAP)
}

function clampCap(value: number): number {
  return Math.min(MAX_HANDOFF_TOKEN_CAP, Math.max(MIN_HANDOFF_TOKEN_CAP, value))
}

export interface HandoffAttachments {
  images?: number
  /** Non-image attachments. */
  other?: number
}

/** One transcript entry a handoff may carry. */
export interface HandoffItem {
  /** Ordinal of the run the entry belongs to on its thread; null when it predates runs. */
  runOrdinal: number | null
  role: 'user' | 'assistant'
  text: string
  attachments?: HandoffAttachments
  /** The message the turn answers: always sent whole, never compacted or omitted. */
  current?: boolean
}

export interface SelectedHandoffItem extends HandoffItem {
  /** Position in the input list. */
  index: number
  /** The text was cut to `COMPACTED_ITEM_CHARS`. */
  compacted: boolean
}

export interface OmittedHandoffItem extends HandoffItem {
  index: number
}

export interface HistorySelection {
  /** Chronological. */
  selected: SelectedHandoffItem[]
  /** Chronological. */
  omitted: OmittedHandoffItem[]
  usedTokens: number
}

/** 1 byte ≈ 1 token. */
export function textTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function attachmentTokens(attachments: HandoffAttachments | undefined): number {
  return (attachments?.images ?? 0) * IMAGE_RESERVATION_TOKENS + (attachments?.other ?? 0) * ATTACHMENT_RESERVATION_TOKENS
}

export function itemTokens(item: Pick<HandoffItem, 'text' | 'attachments'>): number {
  return textTokens(item.text) + attachmentTokens(item.attachments)
}

/**
 * Tokens available for handed-over history:
 * `max(0, min(cap, window − native − current − max(16k, ceil(window / 4))))` with
 * `window = min(modelWindow ?? 128k, 128k)`. `nativeTokens` is what the target already receives
 * (its own transcript when the handoff is added to it); `currentTokens` is the current message with
 * its attachment reservations.
 */
export function handoffBudget(input: {
  cap?: number
  modelWindow?: number | null
  nativeTokens?: number
  currentTokens?: number
}): number {
  const cap = input.cap === undefined ? handoffTokenCap() : clampCap(input.cap)
  const window = Math.min(input.modelWindow ?? MAX_HANDOFF_WINDOW, MAX_HANDOFF_WINDOW)
  const reserve = Math.max(MIN_WINDOW_RESERVE, Math.ceil(window / 4))
  return Math.max(0, Math.min(cap, window - (input.nativeTokens ?? 0) - (input.currentTokens ?? 0) - reserve))
}

/** `text` cut to at most `COMPACTED_ITEM_CHARS` characters, ending with an ellipsis. */
export function compactText(text: string): string {
  const chars = [...text]
  if (chars.length <= COMPACTED_ITEM_CHARS) return text
  return `${chars.slice(0, COMPACTED_ITEM_CHARS - 1).join('')}…`
}

/** Selection priority: last user, last assistant, first user, then the rest newest first. */
function priorityOrder(items: readonly HandoffItem[]): number[] {
  const candidates = items.map((_item, index) => index).filter((index) => !items[index].current)
  const lastOf = (role: HandoffItem['role']): number | undefined =>
    [...candidates].reverse().find((index) => items[index].role === role)
  const firstUser = candidates.find((index) => items[index].role === 'user')
  const order: number[] = []
  for (const index of [lastOf('user'), lastOf('assistant'), firstUser, ...[...candidates].reverse()])
    if (index !== undefined && !order.includes(index)) order.push(index)
  return order
}

/**
 * Picks history within `budget` tokens: whole items in priority order first; then, for the items
 * that did not fit, their compacted text when that fits. The current message (`current: true`) is
 * always included whole and counts against the budget.
 */
export function selectHistory(items: readonly HandoffItem[], budget: number): HistorySelection {
  const chosen = new Map<number, SelectedHandoffItem>()
  let remaining = budget
  items.forEach((item, index) => {
    if (!item.current) return
    chosen.set(index, { ...item, index, compacted: false })
    remaining -= itemTokens(item)
  })
  const order = priorityOrder(items)
  for (const index of order) {
    const cost = itemTokens(items[index])
    if (cost > remaining) continue
    chosen.set(index, { ...items[index], index, compacted: false })
    remaining -= cost
  }
  for (const index of order) {
    if (chosen.has(index)) continue
    const item = items[index]
    const text = compactText(item.text)
    if (text === item.text) continue
    const cost = itemTokens({ text, attachments: item.attachments })
    if (cost > remaining) continue
    chosen.set(index, { ...item, text, index, compacted: true })
    remaining -= cost
  }
  const selected = [...chosen.values()].sort((left, right) => left.index - right.index)
  const omitted = items
    .map((item, index) => ({ ...item, index }))
    .filter((item) => !chosen.has(item.index))
  return { selected, omitted, usedTokens: budget - remaining }
}

/**
 * The note that tells the agent how to fetch history the handoff left out (Phase 5 `thread_read`),
 * or an empty string when nothing was omitted.
 */
export function recoveryPointer(omitted: readonly Pick<HandoffItem, 'runOrdinal'>[], threadId: string): string {
  if (!omitted.length) return ''
  const ordinals = omitted.map((item) => item.runOrdinal).filter((value): value is number => value !== null)
  const range = ordinals.length
    ? ordinals.length === 1 || Math.min(...ordinals) === Math.max(...ordinals)
      ? `run ${ordinals[0]}`
      : `runs ${Math.min(...ordinals)}–${Math.max(...ordinals)}`
    : 'runs before run tracking'
  return `${omitted.length} earlier item(s) were left out of this handoff (${range} of thread ${threadId}). Call the thread_read tool with {"threadId":"${threadId}"} to read that history.`
}
