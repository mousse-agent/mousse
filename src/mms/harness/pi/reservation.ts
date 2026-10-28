import type { Api, Model, TranscriptContext } from '@earendil-works/pi-ai'

/**
 * Spend reservation arithmetic for Pi (PR 4 §5b, `spendLimits: 'reserved'`). Shared by Mousse's
 * extension, which sizes each request and checks its final payload, and the engine, which grants
 * from the run's ledger. Pure, type-only imports: it is bundled into the extension.
 *
 * The wire cap is the output cap a request carries after every pi-ai adjustment, mirrored from the
 * pinned 1.4.0 request builders: the context clamp (`clampMaxTokensToContext`), the thinking budget
 * added on budget-thinking Anthropic and Bedrock Claude models (`adjustMaxTokensForThinking`), and
 * the 16-token floor of `openai-responses`. A drift in the mirror cannot overspend: the extension's
 * final payload check refuses any wire cap above the reservation before the request is sent.
 *
 * Re-check on every Pi upgrade (PR 4 §13): `MIN_ANSWER_TOKENS` (exported by `simple-options.js`,
 * and written as a literal 1024 in `anthropic-messages.js:777` and `bedrock-converse-stream.js:429`),
 * `CONTEXT_SAFETY_TOKENS`, the default thinking budgets, the estimator, the Bedrock adaptive-model
 * names, `supportsMaxOutputTokens`, each API's hook path (`hookCap`) and candidate count
 * (`hookCandidates`), and `calculateCost` (tiers, one-hour cache writes) and the Responses service
 * tier multipliers (`reservationRates`). `piWireCap.test.ts` compares the mirror with the `pi-ai`
 * package; the child runs pi-coding-agent's bundled copy of the same version, which the real-child
 * suite (`piSpendReservation.test.ts`) covers.
 *
 * Not mirrored: Google's thinking budget is sent beside `maxOutputTokens`, not added to it, so a
 * small grant on a thinking Gemini model may leave little room for the answer. It never overspends.
 */

/** Tokens pi-ai always leaves for the answer under a shared thinking ceiling (`MIN_ANSWER_TOKENS`). */
export const MIN_ANSWER_TOKENS = 1024
/** The smallest output cap granted to a request that carries no thinking budget. */
export const MIN_GRANT_TOKENS = 256
/** Added to every input bound (role markers, request framing). */
export const INPUT_OVERHEAD_TOKENS = 1024
/** pi-ai's margin between the context estimate and the window (`simple-options.js`). */
const CONTEXT_SAFETY_TOKENS = 4096
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16
export const DEFAULT_THINKING_BUDGETS: Readonly<Record<'minimal' | 'low' | 'medium' | 'high', number>> = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384 })

/**
 * APIs whose pinned request builders always send the output cap, and whose output tokens include
 * reasoning tokens. `openai-responses` only while `compat.supportsMaxOutputTokens` is not `false`.
 */
export const CAP_HONOURING_APIS: readonly string[] = Object.freeze(['anthropic-messages', 'openai-completions', 'openai-responses', 'bedrock-converse-stream', 'google-generative-ai'])

/**
 * Input tokens counted per image, in place of its bytes: above what each API bills for one image
 * Pi sends (it resizes images before they go). An API without an entry cannot be reserved.
 */
export const IMAGE_TOKEN_CEILING: Readonly<Record<string, number>> = Object.freeze({
  'anthropic-messages': 8192,
  'openai-completions': 8192,
  'openai-responses': 8192,
  'bedrock-converse-stream': 8192,
  'google-generative-ai': 8192
})

export type PiReasoning = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ThinkingBudgets = Partial<Record<'minimal' | 'low' | 'medium' | 'high', number>>

/** The model fields the arithmetic reads. */
export type ReservableModel = Pick<Model<Api>, 'id' | 'api' | 'maxTokens' | 'contextWindow'> & { name?: string; reasoning?: boolean; compat?: unknown }

function compatFlag(model: ReservableModel, key: string): unknown {
  return model.compat && typeof model.compat === 'object' ? (model.compat as Record<string, unknown>)[key] : undefined
}

/** Whether every request on `model` carries an output cap Mousse can bound. */
export function capHonouring(model: Pick<ReservableModel, 'api' | 'compat'>): boolean {
  if (!CAP_HONOURING_APIS.includes(model.api)) return false
  return !(model.api === 'openai-responses' && compatFlag(model as ReservableModel, 'supportsMaxOutputTokens') === false)
}

/** pi-ai's budget for a level: `xhigh` and `max` read as `high` (`thinkingBudgetForLevel`). */
export function thinkingBudgetFor(level: PiReasoning, custom?: ThinkingBudgets): number {
  const key = level === 'xhigh' || level === 'max' ? 'high' : level
  return { ...DEFAULT_THINKING_BUDGETS, ...custom }[key]
}

function matchCandidates(model: ReservableModel): string[] {
  return [model.id, ...(model.name ? [model.name] : [])].flatMap((value) => [value.toLowerCase(), value.toLowerCase().replace(/[\s_.:]+/g, '-')])
}

/** `bedrock-converse-stream.js` `isAnthropicClaudeModel`. */
function bedrockClaude(model: ReservableModel): boolean {
  const id = model.id.toLowerCase()
  const name = model.name?.toLowerCase() ?? ''
  return id.includes('anthropic.claude') || id.includes('anthropic/claude') || name.includes('anthropic.claude') || name.includes('anthropic/claude') || name.includes('claude')
}

/** The markers of `bedrock-converse-stream.js` `supportsAdaptiveThinking` (a test reads pi-ai's own list). */
export const BEDROCK_ADAPTIVE_MARKERS: readonly string[] = Object.freeze(['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-6', 'sonnet-5', 'haiku-5', 'fable-5'])

/** `bedrock-converse-stream.js` `supportsAdaptiveThinking`. */
function bedrockAdaptive(model: ReservableModel): boolean {
  return matchCandidates(model).some((value) => BEDROCK_ADAPTIVE_MARKERS.some((marker) => value.includes(marker)))
}

/** Whether pi-ai adds the thinking budget to the output cap for this request (budget-based thinking). */
export function addsThinkingBudget(model: ReservableModel, reasoning: PiReasoning | undefined): boolean {
  if (!reasoning) return false
  if (model.api === 'anthropic-messages') return compatFlag(model, 'forceAdaptiveThinking') !== true
  if (model.api === 'bedrock-converse-stream') return bedrockClaude(model) && !bedrockAdaptive(model)
  return false
}

// -- pi-ai's context estimate (`utils/estimate.js`), mirrored for the context clamp ---------------

/** What a request's context is: pi-ai's normalized transcript, whose system messages carry the prompt and tools. */
export type PlanContext = Pick<TranscriptContext, 'messages'>

/** `utils/estimate.js` `CHARS_PER_TOKEN`. */
const CHARS_PER_TOKEN = 3.5

type Block = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
type EstimatedMessage = {
  role?: string
  content?: string | Block[]
  sections?: Record<string, string | null>
  toolsAdded?: unknown[]
  toolsRemoved?: unknown[]
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
  stopReason?: string
  timestamp?: number
}

function jsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? 'undefined').length
  } catch {
    return '[unserializable]'.length
  }
}

function textTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function contentChars(content: string | Block[] | undefined): number {
  if (typeof content === 'string') return content.length
  let chars = 0
  for (const block of content ?? []) chars += block.type === 'text' ? (block.text ?? '').length : 4800
  return chars
}

/** `utils/text.js` `getSystemMessageText`: the content's text, then each section, joined by blank lines. */
function systemText(message: EstimatedMessage): string {
  const content = typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  const parts = [content, ...Object.values(message.sections ?? {}).filter((text): text is string => text !== null)]
  return parts.filter((part) => part.length > 0).join('\n\n')
}

function toolsTokens(tools: unknown[] | undefined): number {
  return tools && tools.length ? textTokens(jsonLength(tools)) : 0
}

function messageTokens(message: EstimatedMessage): number {
  if (message.role === 'system') return textTokens(systemText(message).length) + toolsTokens(message.toolsAdded) + toolsTokens(message.toolsRemoved)
  if (message.role === 'user' || message.role === 'toolResult') return textTokens(contentChars(message.content))
  let chars = 0
  for (const block of (message.content as Block[] | undefined) ?? []) {
    if (block.type === 'text') chars += (block.text ?? '').length
    else if (block.type === 'thinking') chars += (block.thinking ?? '').length
    else chars += (block.name ?? '').length + jsonLength(block.arguments)
  }
  return textTokens(chars)
}

function usageTokens(usage: EstimatedMessage['usage']): number {
  return usage?.totalTokens || (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
}

/** `estimateContextTokens(context).tokens`. */
export function estimateContextTokens(context: PlanContext): number {
  const messages = context.messages as unknown as EstimatedMessage[]
  let usageIndex: number | undefined
  let latest = Number.NEGATIVE_INFINITY
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'assistant' && (message.timestamp ?? 0) >= latest && message.stopReason !== 'aborted' && message.stopReason !== 'error' && usageTokens(message.usage) > 0)
      usageIndex = index
    latest = Math.max(latest, message.timestamp ?? 0)
  }
  const from = usageIndex === undefined ? 0 : usageIndex + 1
  let tokens = usageIndex === undefined ? 0 : usageTokens(messages[usageIndex].usage)
  for (const message of messages.slice(from)) tokens += messageTokens(message)
  return tokens
}

function clampToContext(model: ReservableModel, contextTokens: number, maxTokens: number): number {
  if (model.contextWindow <= 0) return Math.max(1, maxTokens)
  return Math.min(maxTokens, Math.max(1, model.contextWindow - contextTokens - CONTEXT_SAFETY_TOKENS))
}

/** What one `streamSimple` request would carry, as pi-ai would build it. */
export interface WirePlan {
  /** The output cap on the wire; undefined when the request carries none (refused under spend limits). */
  wireCap: number | undefined
  /** The thinking budget pi-ai adds to the cap (0 when it adds none). */
  thinkingBudget: number
  /** The thinking budget pi-ai would send (`min(budget, wireCap − MIN_ANSWER_TOKENS)`); 0 when none. */
  sentThinking: number
}

/**
 * The wire cap of a `streamSimple` request on `model` with `options.maxTokens = maxTokens`
 * (undefined: the model's own cap) and `options.reasoning = reasoning`.
 */
export function wirePlan(model: ReservableModel, context: PlanContext, maxTokens: number | undefined, reasoning: PiReasoning | undefined, budgets?: ThinkingBudgets): WirePlan {
  const contextTokens = estimateContextTokens(context)
  const base = clampToContext(model, contextTokens, maxTokens ?? model.maxTokens)
  if (addsThinkingBudget(model, reasoning)) {
    const budget = thinkingBudgetFor(reasoning!, budgets)
    let thinking = budget
    const adjusted = Math.min(base + budget, model.maxTokens)
    if (adjusted <= thinking) thinking = Math.min(thinking, Math.max(0, adjusted - MIN_ANSWER_TOKENS))
    const wireCap = clampToContext(model, contextTokens, adjusted)
    return { wireCap, thinkingBudget: budget, sentThinking: Math.min(thinking, Math.max(0, wireCap - MIN_ANSWER_TOKENS)) }
  }
  if (!capHonouring(model)) return { wireCap: undefined, thinkingBudget: 0, sentThinking: 0 }
  if (model.api === 'openai-responses') return { wireCap: Math.max(base, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS), thinkingBudget: 0, sentThinking: 0 }
  return { wireCap: base, thinkingBudget: 0, sentThinking: 0 }
}

/** The smallest grant a request may go with: the thinking budget plus the answer room, or 256. */
export function grantFloor(thinkingBudget: number): number {
  return thinkingBudget > 0 ? thinkingBudget + MIN_ANSWER_TOKENS : MIN_GRANT_TOKENS
}

/** `options.maxTokens` that makes pi-ai's wire cap equal `cap` (a grant at or under the plan's wire cap). */
export function sizedMaxTokens(cap: number, plan: Pick<WirePlan, 'thinkingBudget'>): number {
  return cap - plan.thinkingBudget
}

/**
 * An upper bound of the request's input tokens: the UTF-8 bytes of its messages, the system
 * messages' prompt and tool schemas included (a byte-level tokenizer emits at most one token per
 * byte), plus a ceiling per image and a fixed overhead. Only the image content blocks of user and tool-result messages are counted
 * by the ceiling instead of their bytes; anything else shaped like one (a tool call's arguments, a
 * schema value) is counted in full. Undefined when the API has no image ceiling.
 */
export function inputBound(context: PlanContext, api: string): number | undefined {
  const ceiling = IMAGE_TOKEN_CEILING[api]
  if (ceiling === undefined) return undefined
  let images = 0
  const messages = context.messages.map((message) => {
    if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: (message.content as Array<{ type?: unknown; mimeType?: unknown }>).map((block) => {
        if (block?.type !== 'image') return block
        images += 1
        return { type: 'image', mimeType: block.mimeType }
      })
    }
  })
  const text = JSON.stringify(messages)
  return Buffer.byteLength(text, 'utf8') + images * ceiling + INPUT_OVERHEAD_TOKENS
}

/**
 * How many completions the hook parameters ask for (`n` on OpenAI chat completions, Google's
 * `candidateCount`); 1 when unset. Each is capped separately, so more than one multiplies the cap.
 */
export function hookCandidates(api: string, params: unknown): number {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const config = value.config && typeof value.config === 'object' ? (value.config as Record<string, unknown>) : {}
  const count = api === 'google-generative-ai' ? config.candidateCount : value.n
  return count === undefined || count === null ? 1 : typeof count === 'number' && Number.isFinite(count) ? count : Number.POSITIVE_INFINITY
}

/**
 * Whether a model's own sampling defaults ask for more than one completion per request, at any
 * thinking level (`samplingParamsByThinkingLevel` is merged over `samplingParams`).
 */
export function multipleCandidates(model: { samplingParams?: Record<string, unknown>; samplingParamsByThinkingLevel?: Record<string, Record<string, unknown> | undefined> }): boolean {
  return [model.samplingParams, ...Object.values(model.samplingParamsByThinkingLevel ?? {})].some((params) =>
    [params?.n, params?.candidateCount, params?.candidate_count].some((count) => count !== undefined && count !== null && count !== 1))
}

/** A model price as pi-ai holds it (USD per million tokens), with its request-wide tiers. */
export interface ModelPrice {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tiers?: Array<{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
}

/** The highest price multiplier pi-ai applies after a response (`openai-responses` priority tier). */
const SERVICE_TIER_MULTIPLIER: Readonly<Record<string, number>> = Object.freeze({ 'openai-responses': 2.5 })

/**
 * The models a request on `model` may be answered and billed by besides itself: Anthropic's
 * server-side fallbacks (`compat.allowedFallbackModels`, sent as `fallbacks` and billed at the
 * fallback's price). No other listed API routes a request to a different model on pi-ai's side.
 */
export function fallbackModels(model: { api: string; compat?: unknown }): Array<{ model: string; cost?: ModelPrice }> {
  if (model.api !== 'anthropic-messages' || !model.compat || typeof model.compat !== 'object') return []
  const allowed = (model.compat as { allowedFallbackModels?: unknown }).allowedFallbackModels
  return Array.isArray(allowed) ? (allowed as Array<{ model: string; cost?: ModelPrice }>) : []
}

/**
 * The rates a reservation is held at, in USD per token: the highest any input-side token can be
 * billed (input, cache read, cache write, or a one-hour cache write at twice input) and the highest
 * output rate, over the base price, every tier and every fallback model (`fallbacks`), times the
 * API's highest service-tier multiplier. Undefined when the model, or any of its fallbacks, has no
 * input or no output price (a USD limit cannot be held).
 */
export function reservationRates(api: string, cost: ModelPrice | undefined, fallbacks: ReadonlyArray<ModelPrice | undefined> = []): { input: number; output: number } | undefined {
  const rate = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const prices = [cost, ...fallbacks]
  if (prices.some((price) => !(rate(price?.input) > 0) || !(rate(price?.output) > 0))) return undefined
  const levels = prices.flatMap((price) => [price ?? {}, ...(price?.tiers ?? [])])
  const input = Math.max(...levels.flatMap((level) => [rate(level.input), rate(level.cacheRead), rate(level.cacheWrite), 2 * rate(level.input)]))
  const output = Math.max(...levels.map((level) => rate(level.output)))
  const multiplier = SERVICE_TIER_MULTIPLIER[api] ?? 1
  return { input: perToken(input) * multiplier, output: perToken(output) * multiplier }
}

/**
 * Whether the hook parameters route the request to a model whose price was not reserved: an
 * Anthropic `fallbacks` entry outside the model's allowed fallbacks, or a `models` list (an
 * OpenAI-compatible gateway's model fallbacks) on any API.
 */
export function unreservedRoute(api: string, params: unknown, allowed: readonly string[]): boolean {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  if (value.models !== undefined) return true
  if (value.fallbacks === undefined) return false
  if (api !== 'anthropic-messages' || !Array.isArray(value.fallbacks)) return true
  return value.fallbacks.some((entry) => !entry || typeof entry !== 'object' || !allowed.includes((entry as { model?: unknown }).model as string))
}

/**
 * The output cap in the parameters `options.onPayload` sees (the hook path), per API; undefined
 * when the field is missing. Google's hook sees the GenAI SDK's `{model, contents, config}` (the cap
 * reaches the wire as `generationConfig.maxOutputTokens`); Bedrock's sees the `ConverseStreamCommand`
 * input.
 */
export function hookCap(api: string, params: unknown): number | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const read = (holder: unknown, key: string): number | undefined => {
    const field = holder && typeof holder === 'object' ? (holder as Record<string, unknown>)[key] : undefined
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined
  }
  switch (api) {
    case 'anthropic-messages':
      return read(value, 'max_tokens')
    case 'openai-completions': {
      const caps = [read(value, 'max_tokens'), read(value, 'max_completion_tokens')].filter((cap): cap is number => cap !== undefined)
      return caps.length ? Math.max(...caps) : undefined
    }
    case 'openai-responses':
      return read(value, 'max_output_tokens')
    case 'bedrock-converse-stream':
      return read(value.inferenceConfig, 'maxTokens')
    case 'google-generative-ai':
      return read(value.config, 'maxOutputTokens')
    default:
      return undefined
  }
}

/** The thinking budget in the hook parameters, on the APIs that send one as a number. */
export function hookThinkingBudget(api: string, params: unknown): number | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, Record<string, Record<string, unknown>>>) : {}
  const budget = api === 'anthropic-messages' ? value.thinking?.budget_tokens
    : api === 'bedrock-converse-stream' ? (value.additionalModelRequestFields?.thinking as Record<string, unknown> | undefined)?.budget_tokens
      : api === 'google-generative-ai' ? value.config?.thinkingConfig && (value.config.thinkingConfig as Record<string, unknown>).thinkingBudget
        : undefined
  return typeof budget === 'number' ? budget : undefined
}

/** A model's price in USD per token (pi-ai prices are per million tokens). */
export function perToken(pricePerMillion: number | undefined): number {
  return typeof pricePerMillion === 'number' && pricePerMillion > 0 ? pricePerMillion / 1_000_000 : 0
}
