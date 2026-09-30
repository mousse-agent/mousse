import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  UserMessage
} from '@earendil-works/pi-ai'
import type {
  ChatMessage,
  NativeCompactionCheckpoint,
  NativeCompactionDirective,
  NativeLastTurnUsage,
  NativeLlmContext
} from '../../shared/types'
import { STEER_MARKER_CLOSE, STEER_MARKER_OPEN } from './steer'

export const NATIVE_CONTEXT_VERSION = 2 as const
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
export const EXACT_COMPACTION_USAGE_RATIO = 0.95
const MESSAGE_OVERHEAD = 4
const MAX_DIRECTIVE_CHARS = 24_000
const MAX_PROGRESS_CHARS = 2_000
const MAX_OBSERVATION_CHARS = 1_000

export interface NativeMessageCheckpoint {
  sourceMessageCount: number
  retainedFromIndex: number
  summary: string
  directives: NativeCompactionDirective[]
  tokensBefore: number
  tokensAfter: number
  createdAt: number
}

export interface InlineCompactionResult {
  messages: Message[]
  checkpoint?: NativeMessageCheckpoint
  changed: boolean
  reason: 'compacted' | 'no-safe-boundary' | 'no-reduction'
}

export function createNativeContext(messages: Message[] = []): NativeLlmContext {
  return {
    version: NATIVE_CONTEXT_VERSION,
    messages: structuredClone(messages),
    fidelity: 'native',
    activeStartIndex: 0,
    revision: 0
  }
}

export function normalizeNativeContext(context: NativeLlmContext): NativeLlmContext {
  const start = Number.isInteger(context.activeStartIndex)
    ? Math.max(0, Math.min(context.activeStartIndex, context.messages.length))
    : 0
  return {
    ...structuredClone(context),
    version: NATIVE_CONTEXT_VERSION,
    activeStartIndex: start,
    revision: Number.isInteger(context.revision) && (context.revision ?? 0) >= 0
      ? context.revision
      : 0
  }
}

export function isNativeLastTurnUsage(value: unknown): value is NativeLastTurnUsage {
  if (!value || typeof value !== 'object') return false
  const usage = value as Partial<NativeLastTurnUsage>
  return (
    typeof usage.input === 'number' && Number.isFinite(usage.input) && usage.input >= 0 &&
    typeof usage.cacheRead === 'number' && Number.isFinite(usage.cacheRead) && usage.cacheRead >= 0 &&
    typeof usage.cacheWrite === 'number' && Number.isFinite(usage.cacheWrite) && usage.cacheWrite >= 0 &&
    typeof usage.signature === 'string' && usage.signature.length > 0 &&
    typeof usage.measuredAtHistoryLength === 'number' &&
    Number.isInteger(usage.measuredAtHistoryLength) &&
    usage.measuredAtHistoryLength >= 0 &&
    (usage.contextRevision === undefined ||
      (Number.isInteger(usage.contextRevision) && usage.contextRevision >= 0)) &&
    (usage.modelKey === undefined || typeof usage.modelKey === 'string')
  )
}

export function migrateLegacyContext(messages: ChatMessage[]): NativeLlmContext {
  // A newly created task has no legacy context to estimate. Preserve exact provenance.
  if (messages.length === 0) return createNativeContext()
  const transcript: Message[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const images: ImageContent[] = (message.images ?? [])
        .filter((image) => image.data && image.mimeType)
        .map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
      const content = images.length
        ? ([{ type: 'text', text: message.content || '(image attachment)' }, ...images] satisfies Array<TextContent | ImageContent>)
        : message.content
      transcript.push({ role: 'user', content, timestamp: Date.parse(message.timestamp) || Date.now() })
    } else if (message.role === 'assistant' && message.kind !== 'thinking') {
      transcript.push(legacyAssistant(message.content, Date.parse(message.timestamp) || Date.now()))
    }
  }
  return {
    version: NATIVE_CONTEXT_VERSION,
    messages: transcript,
    fidelity: 'legacy-estimated',
    activeStartIndex: 0,
    revision: 0
  }
}

export function userMessage(content: string, images?: Array<{ mimeType: string; data: string }>): UserMessage {
  const validImages = (images ?? []).filter((image) => image.data && image.mimeType)
  return {
    role: 'user',
    content: validImages.length
      ? [
          { type: 'text', text: content || '(image attachment)' },
          ...validImages.map((image): ImageContent => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
        ]
      : content,
    timestamp: Date.now()
  }
}

function legacyAssistant(content: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: content }], api: 'openai-completions',
    provider: 'openai', model: 'legacy-text-only', usage: emptyUsage(), stopReason: 'stop', timestamp
  }
}

function emptyUsage(): AssistantMessage['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

/** Provider-visible native messages. Generated compaction memory is supplied separately. */
export function getActiveMessages(context: NativeLlmContext): Message[] {
  return structuredClone(context.messages.slice(Math.max(0, context.activeStartIndex)))
}

export function getCompactionSummary(context: NativeLlmContext): string | undefined {
  return context.compaction?.summary || undefined
}

/** Append or replace the live active view without guessing archive boundaries from text. */
export function commitNativeMessages(
  context: NativeLlmContext,
  activeMessages: Message[],
  checkpoint?: NativeMessageCheckpoint
): NativeLlmContext {
  const normalized = normalizeNativeContext(context)
  const currentActive = normalized.messages.slice(normalized.activeStartIndex)

  if (checkpoint) {
    if (checkpoint.sourceMessageCount !== currentActive.length) {
      throw new Error('STALE_CONTEXT_COMPACTION: source message count changed')
    }
    if (
      checkpoint.retainedFromIndex <= 0 ||
      checkpoint.retainedFromIndex > currentActive.length
    ) {
      throw new Error('INVALID_CONTEXT_COMPACTION: retained boundary is invalid')
    }
    const expected = currentActive.slice(checkpoint.retainedFromIndex)
    if (!messagesEqual(expected, activeMessages)) {
      throw new Error('STALE_CONTEXT_COMPACTION: retained messages do not match the archive')
    }
    if (!checkpoint.summary.trim() || checkpoint.tokensAfter >= checkpoint.tokensBefore) {
      throw new Error('INVALID_CONTEXT_COMPACTION: candidate did not reduce context')
    }
    return {
      ...normalized,
      activeStartIndex: normalized.activeStartIndex + checkpoint.retainedFromIndex,
      revision: (normalized.revision ?? 0) + 1,
      compaction: {
        generation: (normalized.compaction?.generation ?? 0) + 1,
        summary: checkpoint.summary,
        directives: structuredClone(checkpoint.directives),
        tokensBefore: checkpoint.tokensBefore,
        tokensAfter: checkpoint.tokensAfter,
        coveredThroughIndex: normalized.activeStartIndex + checkpoint.retainedFromIndex - 1,
        createdAt: checkpoint.createdAt
      },
      lastTurnUsage: undefined
    }
  }

  if (messagesEqual(currentActive, activeMessages)) return normalized
  return {
    ...normalized,
    messages: [
      ...normalized.messages.slice(0, normalized.activeStartIndex),
      ...structuredClone(activeMessages)
    ],
    revision: (normalized.revision ?? 0) + 1,
    lastTurnUsage: undefined
  }
}

export function appendNativeMessage(context: NativeLlmContext, message: Message): NativeLlmContext {
  const normalized = normalizeNativeContext(context)
  return {
    ...normalized,
    messages: [...normalized.messages, structuredClone(message)],
    revision: (normalized.revision ?? 0) + 1,
    lastTurnUsage: undefined
  }
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0
  let images = 0
  if (message.role === 'user') {
    if (typeof message.content === 'string') chars = message.content.length
    else {
      chars = message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
      images = message.content.filter((block) => block.type === 'image').length
    }
  } else if (message.role === 'assistant') {
    chars = message.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + block.text.length
      if (block.type === 'thinking') return sum + block.thinking.length
      return sum + block.name.length + block.id.length + JSON.stringify(block.arguments).length
    }, 0)
  } else {
    chars = message.toolCallId.length + message.toolName.length + message.content.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
    images = message.content.filter((block) => block.type === 'image').length
  }
  return Math.ceil(chars / 4) + MESSAGE_OVERHEAD + images * 1_024
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

/** Estimate only the current payload. Provider measurements are revision-bound elsewhere. */
export function estimateActiveContextTokens(messages: Message[], summary?: string): number {
  return estimateMessagesTokens(messages) + (summary ? Math.ceil(summary.length / 4) + MESSAGE_OVERHEAD : 0)
}

export function shouldCompactNativeContext(
  activeTokens: number,
  contextWindow: number,
  reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS,
  configuredThreshold?: number
): boolean {
  if (!Number.isFinite(activeTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false
  const requestedReserve = Math.max(0, Math.min(reserveTokens, contextWindow - 1))
  const reserve = contextWindow > requestedReserve * 2 ? requestedReserve : 0
  const watermark = Math.floor(contextWindow * EXACT_COMPACTION_USAGE_RATIO)
  const configured = configuredThreshold && configuredThreshold > 0
    ? Math.min(configuredThreshold, contextWindow)
    : watermark
  return activeTokens >= Math.min(watermark, configured, contextWindow - reserve)
}

export function compactNativeContext(
  context: NativeLlmContext,
  keepRecentTokens = DEFAULT_COMPACTION_KEEP_RECENT_TOKENS
): NativeLlmContext {
  const normalized = normalizeNativeContext(context)
  const start = normalized.activeStartIndex
  const cut = findSafeCompactionCutIndex(normalized.messages, start, keepRecentTokens)
  if (cut <= start) return context
  const tokensBefore = estimateActiveContextTokens(
    normalized.messages.slice(start),
    normalized.compaction?.summary
  )
  // Re-read the covered archive so a legacy/corrupt prior summary cannot permanently
  // erase an older user directive that is still durably available.
  const memory = buildStructuredMemory(normalized.messages.slice(0, cut), normalized.compaction)
  const tokensAfter = estimateActiveContextTokens(normalized.messages.slice(cut), memory.summary)
  if (tokensAfter >= tokensBefore) return context
  return {
    ...normalized,
    activeStartIndex: cut,
    revision: (normalized.revision ?? 0) + 1,
    compaction: {
      generation: (normalized.compaction?.generation ?? 0) + 1,
      summary: memory.summary,
      directives: memory.directives,
      tokensBefore,
      tokensAfter,
      coveredThroughIndex: cut - 1,
      createdAt: Date.now()
    },
    lastTurnUsage: undefined
  }
}

export function compactMessagesAtSafeBoundary(
  messages: Message[],
  keepRecentTokens = DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  previous?: Pick<NativeCompactionCheckpoint, 'summary' | 'directives'>
): InlineCompactionResult {
  const cut = findSafeCompactionCutIndex(messages, 0, keepRecentTokens)
  if (cut <= 0) {
    return { messages: structuredClone(messages), changed: false, reason: 'no-safe-boundary' }
  }
  const memory = buildStructuredMemory(messages.slice(0, cut), previous)
  const recent = structuredClone(messages.slice(cut))
  const tokensBefore = estimateActiveContextTokens(messages, previous?.summary)
  const tokensAfter = estimateActiveContextTokens(recent, memory.summary)
  if (tokensAfter >= tokensBefore) {
    return { messages: structuredClone(messages), changed: false, reason: 'no-reduction' }
  }
  return {
    messages: recent,
    changed: true,
    reason: 'compacted',
    checkpoint: {
      sourceMessageCount: messages.length,
      retainedFromIndex: cut,
      summary: memory.summary,
      directives: memory.directives,
      tokensBefore,
      tokensAfter,
      createdAt: Date.now()
    }
  }
}

/** Return a complete assistant/tool-result boundary for the retained suffix. */
export function findSafeCompactionCutIndex(
  messages: Message[],
  startIndex: number,
  keepRecentTokens: number
): number {
  let tokens = 0
  let cut = messages.length
  for (let i = messages.length - 1; i >= startIndex; i -= 1) {
    tokens += estimateMessageTokens(messages[i])
    cut = i
    if (tokens >= Math.max(1, keepRecentTokens)) break
  }
  // A retained suffix must start at a conversational turn boundary. Keeping an
  // assistant answer while compacting away the user request that elicited it
  // is structurally valid to the provider, but semantically unsafe.
  while (cut > startIndex && messages[cut]?.role !== 'user') cut -= 1
  while (cut > startIndex && messages[cut]?.role === 'toolResult') cut -= 1
  const previous = cut > startIndex ? messages[cut - 1] : undefined
  if (previous?.role === 'assistant') {
    const calls = previous.content.filter((block) => block.type === 'toolCall')
    if (calls.length > 0) cut -= 1
  }
  return cut
}

function buildStructuredMemory(
  messages: Message[],
  previous?: Pick<NativeCompactionCheckpoint, 'summary' | 'directives'>
): { summary: string; directives: NativeCompactionDirective[] } {
  const directives = dedupeDirectives([
    ...(previous?.directives ?? []),
    ...messages.flatMap(extractDirective)
  ])
  const boundedDirectives = retainNewestWithinBudget(directives, MAX_DIRECTIVE_CHARS)
  const progress = retainTextWithinBudget(
    messages.flatMap((message) => message.role === 'assistant'
      ? message.content.filter((block): block is TextContent => block.type === 'text').map((block) => block.text.trim()).filter(Boolean)
      : []),
    MAX_PROGRESS_CHARS
  )
  const observations = retainTextWithinBudget(
    messages.flatMap((message) => message.role === 'toolResult' && message.isError
      ? message.content.filter((block): block is TextContent => block.type === 'text').map((block) => `${message.toolName}: ${block.text.trim()}`).filter(Boolean)
      : []),
    MAX_OBSERVATION_CHARS
  )
  const prior = previous?.summary && !(previous.directives?.length)
    ? previous.summary.slice(-2_000)
    : ''
  const section = (title: string, entries: string[], empty: string) => [
    `## ${title}`,
    entries.length ? entries.map((entry) => `- ${entry}`).join('\n') : empty
  ].join('\n')
  const summary = [
    '# Generated conversation memory',
    'This memory is generated from older events. User directives below are verbatim user text unless explicitly marked as an excerpt; progress and observations are unverified until rechecked.',
    section('User directives and questions (oldest to newest)', boundedDirectives.map(formatDirective), '(No recoverable user directive in the compacted range.)'),
    section('Assistant-reported progress', progress, '(No assistant progress retained.)'),
    section('Tool errors and blockers', observations, '(No tool error retained.)'),
    prior ? section('Legacy generated memory (untrusted)', [prior], '(None.)') : ''
  ].filter(Boolean).join('\n\n')
  return { summary, directives: boundedDirectives }
}

function extractDirective(message: Message): NativeCompactionDirective[] {
  if (message.role === 'toolResult') {
    const details = message.details
    const steer = details && typeof details === 'object' &&
      'mousseUserSteer' in details && typeof details.mousseUserSteer === 'string'
      ? details.mousseUserSteer.trim()
      : ''
    return steer ? [{ text: steer, timestamp: message.timestamp, source: 'user-steer' }] : []
  }
  if (message.role !== 'user') return []
  const text = typeof message.content === 'string'
    ? message.content.trim()
    : message.content.filter((block): block is TextContent => block.type === 'text').map((block) => block.text).join('').trim()
  if (!text) return []
  if (text.startsWith('[Mousse ')) return []
  if (text.includes(STEER_MARKER_OPEN)) {
    const start = text.indexOf(STEER_MARKER_OPEN) + STEER_MARKER_OPEN.length
    const end = text.indexOf(STEER_MARKER_CLOSE, start)
    const steer = text.slice(start, end >= start ? end : undefined).trim()
    return steer ? [{ text: steer, timestamp: message.timestamp, source: 'user-steer' }] : []
  }
  return [{ text, timestamp: message.timestamp, source: 'user' }]
}

function dedupeDirectives(values: NativeCompactionDirective[]): NativeCompactionDirective[] {
  const seen = new Set<string>()
  const result: NativeCompactionDirective[] = []
  for (const value of values) {
    const key = `${value.source}\u0000${value.timestamp ?? ''}\u0000${value.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(structuredClone(value))
  }
  return result
}

function retainNewestWithinBudget(values: NativeCompactionDirective[], maxChars: number): NativeCompactionDirective[] {
  if (values.length === 0) return []
  const total = values.reduce((sum, value) => sum + value.text.length, 0)
  if (total <= maxChars) return structuredClone(values)

  // Preserve the root request as well as the newest steering. This prevents a
  // long sequence of follow-ups from silently evicting the objective that gives
  // those follow-ups their meaning.
  const rootBudget = Math.min(8_000, Math.floor(maxChars / 3))
  const root = excerptDirective(values[0], rootBudget)
  const retained: NativeCompactionDirective[] = []
  let chars = root.text.length
  for (let index = values.length - 1; index >= 1; index -= 1) {
    const value = values[index]
    const remaining = maxChars - chars
    if (remaining <= 0) break
    if (retained.length === 0 && value.text.length > remaining) {
      retained.unshift(excerptDirective(value, remaining))
      break
    }
    if (chars + value.text.length > maxChars) break
    retained.unshift(structuredClone(value))
    chars += value.text.length
  }
  return [root, ...retained]
}

function excerptDirective(value: NativeCompactionDirective, maxChars: number): NativeCompactionDirective {
  if (value.text.length <= maxChars) return structuredClone(value)
  const marker = '\n\n[… middle omitted from provider context; full text remains in the archive …]\n\n'
  const side = Math.max(1, Math.floor((Math.max(maxChars, marker.length + 2) - marker.length) / 2))
  return {
    ...value,
    text: `${value.text.slice(0, side)}${marker}${value.text.slice(-side)}`,
    originalChars: value.originalChars ?? value.text.length
  }
}

function retainTextWithinBudget(values: string[], maxChars: number): string[] {
  const result: string[] = []
  let chars = 0
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index].slice(0, maxChars)
    if (result.length > 0 && chars + value.length > maxChars) break
    result.unshift(value)
    chars += value.length
  }
  return result
}

function formatDirective(directive: NativeCompactionDirective): string {
  const timestamp = directive.timestamp ? new Date(directive.timestamp).toISOString() : 'timestamp unknown'
  const excerpt = directive.originalChars ? `; excerpt of ${directive.originalChars} characters` : ''
  return `[${directive.source}; ${timestamp}${excerpt}] ${directive.text}`
}

function messagesEqual(left: Message[], right: Message[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
