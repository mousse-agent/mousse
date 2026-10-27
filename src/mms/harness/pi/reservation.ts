import type { Api, Context, Model } from '@earendil-works/pi-ai'

/**
 * Spend reservation arithmetic for Pi (PR 4 §5b, `spendLimits: 'reserved'`). Shared by Mousse's
 * extension, which sizes each request and checks its final payload, and the engine, which grants
 * from the run's ledger. Pure, type-only imports: it is bundled into the extension.
 *
 * The wire cap is the output cap a request carries after every pi-ai adjustment, mirrored from the
 * pinned 0.85.1 request builders: the context clamp (`clampMaxTokensToContext`), the thinking budget
 * added on budget-thinking Anthropic and Bedrock Claude models (`adjustMaxTokensForThinking`), and
 * the 16-token floor of `openai-responses`. A drift in the mirror cannot overspend: the extension's
 * final payload check refuses any wire cap above the reservation before the request is sent.
 *
 * Re-check on every Pi upgrade (PR 4 §13): `MIN_ANSWER_TOKENS` (exported by `simple-options.js`,
 * and written as a literal 1024 in `anthropic-messages.js` and `bedrock-converse-stream.js:409`),
 * `CONTEXT_SAFETY_TOKENS`, the default thinking budgets, the estimator, the Bedrock adaptive-model
 * names, `supportsMaxOutputTokens` and each API's hook path (`hookCap`).
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

/** `bedrock-converse-stream.js` `supportsAdaptiveThinking`. */
function bedrockAdaptive(model: ReservableModel): boolean {
  return matchCandidates(model).some((value) => ['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-6', 'sonnet-5', 'fable-5'].some((marker) => value.includes(marker)))
}

/** Whether pi-ai adds the thinking budget to the output cap for this request (budget-based thinking). */
export function addsThinkingBudget(model: ReservableModel, reasoning: PiReasoning | undefined): boolean {
  if (!reasoning) return false
  if (model.api === 'anthropic-messages') return compatFlag(model, 'forceAdaptiveThinking') !== true
  if (model.api === 'bedrock-converse-stream') return bedrockClaude(model) && !bedrockAdaptive(model)
  return false
}

// -- pi-ai's context estimate (`utils/estimate.js`), mirrored for the context clamp ---------------

type Block = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
type EstimatedMessage = { role?: string; content?: string | Block[]; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }; stopReason?: string; timestamp?: number; addedToolNames?: string[] }

function jsonLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? 'undefined').length
  } catch {
    return '[unserializable]'.length
  }
}

function contentChars(content: string | Block[] | undefined): number {
  if (typeof content === 'string') return content.length
  let chars = 0
  for (const block of content ?? []) chars += block.type === 'text' ? (block.text ?? '').length : 4800
  return chars
}

function messageTokens(message: EstimatedMessage): number {
  if (message.role === 'user' || message.role === 'toolResult') return Math.ceil(contentChars(message.content) / 4)
  let chars = 0
  for (const block of (message.content as Block[] | undefined) ?? []) {
    if (block.type === 'text') chars += (block.text ?? '').length
    else if (block.type === 'thinking') chars += (block.thinking ?? '').length
    else chars += (block.name ?? '').length + jsonLength(block.arguments)
  }
  return Math.ceil(chars / 4)
}

function usageTokens(usage: EstimatedMessage['usage']): number {
  return usage?.totalTokens || (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
}

/** `estimateContextTokens(context).tokens`. */
export function estimateContextTokens(context: Pick<Context, 'systemPrompt' | 'messages' | 'tools'>): number {
  const messages = context.messages as unknown as EstimatedMessage[]
  let usageIndex: number | undefined
  let latest = Number.NEGATIVE_INFINITY
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'assistant' && (message.timestamp ?? 0) >= latest && message.stopReason !== 'aborted' && message.stopReason !== 'error' && usageTokens(message.usage) > 0)
      usageIndex = index
    latest = Math.max(latest, message.timestamp ?? 0)
  }
  const toolsTokens = (tools: unknown[] | undefined) => (tools && tools.length ? Math.ceil(jsonLength(tools) / 4) : 0)
  if (usageIndex !== undefined) {
    let tokens = usageTokens(messages[usageIndex].usage)
    for (const message of messages.slice(usageIndex + 1)) tokens += messageTokens(message)
    const added = new Set(messages.slice(usageIndex + 1).filter((message) => message.role === 'toolResult').flatMap((message) => message.addedToolNames ?? []))
    return tokens + toolsTokens(context.tools?.filter((tool) => added.has(tool.name)))
  }
  let tokens = 0
  for (const message of messages) tokens += messageTokens(message)
  return tokens + (context.systemPrompt ? Math.ceil(context.systemPrompt.length / 4) : 0) + toolsTokens(context.tools)
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
export function wirePlan(model: ReservableModel, context: Pick<Context, 'systemPrompt' | 'messages' | 'tools'>, maxTokens: number | undefined, reasoning: PiReasoning | undefined, budgets?: ThinkingBudgets): WirePlan {
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
 * An upper bound of the request's input tokens: the UTF-8 bytes of its system prompt, messages and
 * tool schemas (a byte-level tokenizer emits at most one token per byte) with image data left out,
 * plus a ceiling per image and a fixed overhead. Undefined when the API has no image ceiling.
 */
export function inputBound(context: Pick<Context, 'systemPrompt' | 'messages' | 'tools'>, api: string): number | undefined {
  const ceiling = IMAGE_TOKEN_CEILING[api]
  if (ceiling === undefined) return undefined
  let images = 0
  const text = JSON.stringify([context.systemPrompt ?? '', context.messages, context.tools ?? []], (_key, value: unknown) => {
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'image' && typeof (value as { data?: unknown }).data === 'string') {
      images += 1
      return { type: 'image', mimeType: (value as { mimeType?: unknown }).mimeType }
    }
    return value
  })
  return Buffer.byteLength(text, 'utf8') + images * ceiling + INPUT_OVERHEAD_TOKENS
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
