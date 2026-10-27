import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as bedrockStream } from '@earendil-works/pi-ai/api/bedrock-converse-stream'
import { streamSimple as googleStream } from '@earendil-works/pi-ai/api/google-generative-ai'
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as responsesStream } from '@earendil-works/pi-ai/api/openai-responses'
import { MIN_ANSWER_TOKENS as PI_MIN_ANSWER_TOKENS } from '@earendil-works/pi-ai/api/simple-options'
import { estimateContextTokens as piEstimate } from '@earendil-works/pi-ai/utils/estimate'
import {
  CAP_HONOURING_APIS,
  MIN_ANSWER_TOKENS,
  capHonouring,
  estimateContextTokens,
  grantFloor,
  hookCap,
  hookThinkingBudget,
  sizedMaxTokens,
  wirePlan,
  type PiReasoning,
  type ThinkingBudgets
} from '../../src/mms/harness/pi/reservation'

// PR 4 §16 `wireCap.test.ts`: the wire-cap mirror against pinned pi-ai's own request builders. Each
// API's real `streamSimple` builds its request and hands it to `onPayload`, which records the
// parameters and throws: the stream fails before any HTTP call, so nothing leaves the machine.

const STREAMS: Record<string, (model: Model<Api>, context: Context, options: SimpleStreamOptions) => AsyncIterable<unknown> & { result(): Promise<unknown> }> = {
  'anthropic-messages': anthropicStream as never,
  'bedrock-converse-stream': bedrockStream as never,
  'google-generative-ai': googleStream as never,
  'openai-completions': completionsStream as never,
  'openai-responses': responsesStream as never
}

const STOP = 'stop before sending'
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

function model(api: string, patch: Partial<Model<Api>> = {}): Model<Api> {
  return { id: `${api}-model`, name: `${api} model`, api, provider: 'test', baseUrl: 'http://127.0.0.1:9/v1', reasoning: true, input: ['text', 'image'], cost: COST, contextWindow: 200_000, maxTokens: 64_000, ...patch } as Model<Api>
}

/** The models of every listed API, budget-thinking and not. */
const MODELS: Model<Api>[] = [
  model('anthropic-messages', { id: 'claude-sonnet-4-5' }),
  model('anthropic-messages', { id: 'claude-opus-4-7', compat: { forceAdaptiveThinking: true } as never }),
  model('bedrock-converse-stream', { id: 'anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5' }),
  model('bedrock-converse-stream', { id: 'anthropic.claude-opus-4-7', name: 'Claude Opus 4.7' }),
  model('bedrock-converse-stream', { id: 'amazon.nova-pro-v1:0', name: 'Nova Pro' }),
  model('google-generative-ai', { id: 'gemini-2.5-pro' }),
  model('openai-completions', { id: 'gpt-4.1' }),
  model('openai-completions', { id: 'local', compat: { maxTokensField: 'max_tokens' } as never }),
  model('openai-responses', { id: 'gpt-5' })
]

const EFFORTS: Array<PiReasoning | undefined> = [undefined, 'minimal', 'low', 'medium', 'high', 'xhigh']

function context(chars = 2_000): Context {
  return {
    systemPrompt: 'You are terse.',
    messages: [
      { role: 'user', content: 'x'.repeat(chars), timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: 'and this image' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 2 }
    ],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } as never }]
  }
}

/** What pi-ai's own `streamSimple` hands `onPayload`, with nothing sent. */
async function piPayload(target: Model<Api>, ctx: Context, maxTokens: number | undefined, reasoning: PiReasoning | undefined, thinkingBudgets?: ThinkingBudgets): Promise<unknown> {
  let seen: unknown
  const stream = STREAMS[target.api](target, ctx, {
    apiKey: 'fake-key',
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingBudgets ? { thinkingBudgets } : {}),
    env: { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'fake', AWS_SECRET_ACCESS_KEY: 'fake' },
    onPayload: (params) => {
      seen = params
      throw new Error(STOP)
    }
  } as SimpleStreamOptions)
  const message = (await stream.result()) as { errorMessage?: string }
  expect(message.errorMessage).toContain(STOP)
  return seen
}

describe('the wire-cap mirror (pinned pi-ai 0.85.1)', () => {
  it('uses pi-ai’s answer-room floor and estimate', () => {
    expect(MIN_ANSWER_TOKENS).toBe(PI_MIN_ANSWER_TOKENS)
    for (const ctx of [context(10), context(90_000), { messages: [] }, {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'a' } }], usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 940 }, stopReason: 'toolUse', timestamp: 2 },
        { role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text: 'file body'.repeat(50) }], addedToolNames: ['read'], timestamp: 3 }
      ],
      tools: [{ name: 'read', description: 'Read', parameters: {} }]
    }] as Context[])
      expect(estimateContextTokens(ctx)).toBe(piEstimate(ctx).tokens)
  })

  it('the answer room is also a literal 1024 in the Anthropic and Bedrock builders (re-checked on every Pi upgrade)', () => {
    const source = (api: string) => readFileSync(new URL(`../../node_modules/@earendil-works/pi-ai/dist/api/${api}.js`, import.meta.url), 'utf8')
    for (const api of ['anthropic-messages', 'bedrock-converse-stream']) expect(source(api)).toContain('Math.max(0, maxTokens - 1024)')
  })

  it('the listed APIs; openai-responses only while it sends max_output_tokens', () => {
    expect([...CAP_HONOURING_APIS].sort()).toEqual(['anthropic-messages', 'bedrock-converse-stream', 'google-generative-ai', 'openai-completions', 'openai-responses'])
    expect(capHonouring(model('openai-responses', { compat: { supportsMaxOutputTokens: false } as never }))).toBe(false)
    expect(capHonouring(model('openai-completions', { compat: { maxTokensField: 'max_tokens' } as never }))).toBe(true)
    expect(capHonouring(model('mistral-conversations'))).toBe(false)
  })

  it.each(MODELS.map((entry) => [entry.api, entry.id, entry] as const))('%s %s: the wire cap and sent thinking budget equal pi-ai’s for every effort, cap and custom budget', async (_api, _id, target) => {
    for (const reasoning of EFFORTS)
      for (const maxTokens of [undefined, 300, 4_096, 13_107])
        for (const budgets of [undefined, { low: 3_000, high: 20_000 }] as Array<ThinkingBudgets | undefined>) {
          const ctx = context()
          const plan = wirePlan(target, ctx, maxTokens, reasoning, budgets)
          const params = await piPayload(target, ctx, maxTokens, reasoning, budgets)
          expect(hookCap(target.api, params), JSON.stringify({ reasoning, maxTokens, budgets })).toBe(plan.wireCap)
          if (plan.thinkingBudget) expect(hookThinkingBudget(target.api, params)).toBe(plan.sentThinking)
        }
  })

  it.each(MODELS.map((entry) => [entry.api, entry.id, entry] as const))('%s %s: every grant the gate accepts reaches the wire as the grant, with the effort’s full thinking budget', async (_api, _id, target) => {
    for (const reasoning of EFFORTS) {
      const ctx = context()
      const natural = wirePlan(target, ctx, undefined, reasoning)
      const floor = grantFloor(natural.thinkingBudget)
      for (const cap of [floor, floor + 1, Math.floor((floor + natural.wireCap!) / 2), natural.wireCap!]) {
        if (cap < floor || cap > natural.wireCap!) continue
        const params = await piPayload(target, ctx, sizedMaxTokens(cap, natural), reasoning)
        expect(hookCap(target.api, params), `${reasoning} ${cap}`).toBe(cap)
        if (natural.thinkingBudget) {
          expect(hookThinkingBudget(target.api, params)).toBe(natural.thinkingBudget)
          expect(wirePlan(target, ctx, sizedMaxTokens(cap, natural), reasoning).sentThinking).toBe(natural.thinkingBudget)
        }
      }
    }
  })

  it('a context near full clamps the wire cap: below the effort’s budget plus the answer room, pi-ai would cut the budget', async () => {
    const target = model('anthropic-messages', { id: 'claude-sonnet-4-5', contextWindow: 40_000 })
    // ~30k tokens of context: 40k − 30k − 4096 leaves under 16384 + 1024 for `high`.
    const ctx = context(120_000)
    const plan = wirePlan(target, ctx, undefined, 'high')
    expect(plan.wireCap).toBeLessThan(grantFloor(plan.thinkingBudget))
    expect(plan.sentThinking).toBeLessThan(plan.thinkingBudget)
    const params = await piPayload(target, ctx, undefined, 'high')
    expect(hookCap(target.api, params)).toBe(plan.wireCap)
    expect(hookThinkingBudget(target.api, params)).toBe(plan.sentThinking)
  })
})
