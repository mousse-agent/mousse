import { describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { budgetLimitsOf, RunCounterBook, RunCounters, RunSpend, TurnBudget, type SpendRequest } from '../../src/mms/harness/budget'
import { grantFloor, IMAGE_TOKEN_CEILING, INPUT_OVERHEAD_TOKENS, inputBound, MIN_ANSWER_TOKENS, MIN_GRANT_TOKENS, perToken, thinkingBudgetFor, wirePlan } from '../../src/mms/harness/pi/reservation'

// PR 4 §16 `reservation.test.ts`: the input bound, the grant from the run's ledger, and the refusal
// thresholds (256 without thinking; the thinking budget plus 1024 with it, after the context clamp).

const FREE = { input: 0, output: 0, cacheWrite: 0 }
const ask = (patch: Partial<SpendRequest> = {}): SpendRequest => ({ inputBound: 1_000, wireCap: 8_000, floor: MIN_GRANT_TOKENS, price: FREE, ...patch })

describe('the input bound', () => {
  it('counts UTF-8 bytes of the system prompt, messages and tools, an image ceiling per image and a fixed overhead', () => {
    const text: Context = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'héllo', timestamp: 1 }], tools: [] }
    const bytes = Buffer.byteLength(JSON.stringify(['sys', text.messages, []]), 'utf8')
    expect(inputBound(text, 'anthropic-messages')).toBe(bytes + INPUT_OVERHEAD_TOKENS)
    // Multi-byte characters count every byte.
    expect(bytes).toBe(JSON.stringify(['sys', text.messages, []]).length + 1)

    const data = 'A'.repeat(100_000)
    const image: Context = { messages: [{ role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }], timestamp: 1 }, { role: 'toolResult', toolCallId: 'c', toolName: 'shot', content: [{ type: 'image', data, mimeType: 'image/png' }], isError: false, timestamp: 2 }] }
    const bound = inputBound(image, 'openai-responses')!
    // The image data is not counted as text; each image adds the API's ceiling.
    expect(bound).toBeLessThan(data.length)
    expect(bound).toBeGreaterThan(2 * IMAGE_TOKEN_CEILING['openai-responses'])
    expect(inputBound(image, 'mistral-conversations')).toBeUndefined()
  })

  it('pi-ai prices are per million tokens', () => {
    expect(perToken(15)).toBeCloseTo(0.000015)
    expect(perToken(0)).toBe(0)
    expect(perToken(undefined)).toBe(0)
  })
})

describe('the grant', () => {
  it('is the wire cap when the run has room, and reserves it in full with the input bound', () => {
    const spend = new RunSpend()
    expect(spend.reserve(ask(), { maxOutputTokens: 100_000, maxInputTokens: 100_000 })).toMatchObject({ ok: true, cap: 8_000 })
    expect(spend.used()).toMatchObject({ input: 1_000, output: 8_000 })
  })

  it('lowers the cap to what is left of the output limit and of the USD limit (input at the higher of input and cache-write price)', () => {
    const spend = new RunSpend()
    expect(spend.reserve(ask(), { maxOutputTokens: 3_000 })).toMatchObject({ ok: true, cap: 3_000 })
    expect(spend.reserve(ask(), { maxOutputTokens: 3_500 })).toMatchObject({ ok: true, cap: 500 })
    expect(spend.reserve(ask(), { maxOutputTokens: 3_755 })).toMatchObject({ ok: false, limit: { kind: 'output_tokens', limit: 3_755, actual: 3_500 } })

    const priced = new RunSpend()
    const price = { input: perToken(3), output: perToken(15), cacheWrite: perToken(3.75) }
    // $0.10: input 1,000 × $3.75/M = $0.00375, leaving $0.09625 / $15/M = 6,416 output tokens.
    const granted = priced.reserve(ask({ price }), { maxUsd: 0.1 })
    expect(granted).toMatchObject({ ok: true, cap: 6_416 })
    expect(priced.used().usd).toBeLessThanOrEqual(0.1)
    expect(new RunSpend().reserve(ask({ price, inputBound: 30_000 }), { maxUsd: 0.1 })).toMatchObject({ ok: false, limit: { kind: 'cost_usd', limit: 0.1 } })
  })

  it('refuses an input bound that passes the input limit', () => {
    const spend = new RunSpend()
    expect(spend.reserve(ask({ inputBound: 5_001 }), { maxInputTokens: 5_000 })).toMatchObject({ ok: false, limit: { kind: 'input_tokens', limit: 5_000, actual: 0 } })
    expect(spend.reserve(ask({ inputBound: 5_000 }), { maxInputTokens: 5_000 })).toMatchObject({ ok: true })
  })

  it('refuses under 256 without thinking, and under the thinking budget plus 1024 with it', () => {
    expect(grantFloor(0)).toBe(256)
    expect(new RunSpend().reserve(ask(), { maxOutputTokens: 255 })).toMatchObject({ ok: false, limit: { kind: 'output_tokens' } })
    expect(new RunSpend().reserve(ask(), { maxOutputTokens: 256 })).toMatchObject({ ok: true, cap: 256 })
    const budget = thinkingBudgetFor('high')
    const floor = grantFloor(budget)
    expect(floor).toBe(budget + MIN_ANSWER_TOKENS)
    const thinking = ask({ wireCap: 64_000, floor })
    expect(new RunSpend().reserve(thinking, { maxOutputTokens: budget + 1_023 })).toMatchObject({ ok: false, limit: { kind: 'output_tokens', limit: budget + 1_023 } })
    expect(new RunSpend().reserve(thinking, { maxOutputTokens: budget + 1_024 })).toMatchObject({ ok: true, cap: budget + 1_024 })
    // Sol's case: 256 left with `high` is refused, never sent as 16,640.
    expect(new RunSpend().reserve(thinking, { maxOutputTokens: 256 })).toMatchObject({ ok: false })
  })

  it('a context near full that clamps the wire cap under the thinking budget plus 1024 is refused', () => {
    const model = { id: 'claude-sonnet-4-5', api: 'anthropic-messages', maxTokens: 64_000, contextWindow: 40_000, reasoning: true } as Model<Api>
    const plan = wirePlan(model, { messages: [{ role: 'user', content: 'x'.repeat(120_000), timestamp: 1 }] }, undefined, 'high')
    const floor = grantFloor(plan.thinkingBudget)
    expect(plan.wireCap).toBeLessThan(floor)
    expect(new RunSpend().reserve(ask({ wireCap: plan.wireCap!, floor }), { maxOutputTokens: 1_000_000 })).toMatchObject({ ok: false, limit: { kind: 'output_tokens' } })
  })
})

describe('settling', () => {
  it('releases what was not sent, keeps actual usage, and keeps at least the reservation for a failed request', () => {
    const spend = new RunSpend()
    const first = spend.reserve(ask(), { maxOutputTokens: 20_000 })
    if (!first.ok) throw new Error('refused')
    expect(spend.settle(first.id, { kind: 'released' })).toEqual({ ok: true })
    expect(spend.used()).toEqual({ input: 0, output: 0, usd: 0 })
    const second = spend.reserve(ask(), { maxOutputTokens: 20_000 })
    if (!second.ok) throw new Error('refused')
    spend.settle(second.id, { kind: 'used', input: 400, output: 120, usd: 0.01 })
    expect(spend.used()).toEqual({ input: 400, output: 120, usd: 0.01 })
    const third = spend.reserve(ask(), { maxOutputTokens: 20_000 })
    if (!third.ok) throw new Error('refused')
    spend.settle(third.id, { kind: 'used', input: 0, output: 5, usd: 0, partial: true })
    expect(spend.committed).toMatchObject({ input: 1_400, output: 8_120 })
    // A settled id is ignored.
    expect(spend.settle(third.id, { kind: 'released' })).toEqual({ ok: true })
    expect(spend.committed.output).toBe(8_120)
  })

  it('an unsettled reservation stays charged (the process died mid-request)', () => {
    const spend = new RunSpend()
    spend.reserve(ask(), { maxOutputTokens: 8_200 })
    expect(spend.reserve(ask(), { maxOutputTokens: 8_200 })).toMatchObject({ ok: false, limit: { actual: 8_000 } })
  })

  it('an overshoot ends the run: the budget refuses every later step and keeps the overshoot', () => {
    const budget = new TurnBudget({ maxTurns: 10, maxOutputTokens: 50_000 }, new RunCounters())
    expect(budget.reserves).toBe(true)
    const granted = budget.reserve(ask())
    if (!granted.ok) throw new Error('refused')
    expect(budget.settle(granted.id, { kind: 'used', input: 10, output: 8_300, usd: 0 })).toMatchObject({ ok: false, overshoot: 300 })
    expect(budget.overshoot).toBe(300)
    expect(budget.exhausted).toEqual({ kind: 'output_tokens', limit: 8_000, actual: 8_300 })
    expect(budget.request()).toMatchObject({ ok: false })
    expect(budget.toolCall()).toMatchObject({ ok: false })
    expect(budget.reserve(ask())).toMatchObject({ ok: false })
  })
})

describe('run records with spend', () => {
  it('a policy’s count and spend limits travel together', () => {
    expect(budgetLimitsOf({ budget: { maxUsd: 1, maxWallMs: 5 } })).toEqual({ maxUsd: 1 })
    expect(budgetLimitsOf({ budget: { maxTurns: 2, maxOutputTokens: 9 } })).toEqual({ maxTurns: 2, maxOutputTokens: 9 })
    expect(budgetLimitsOf({ budget: { maxWallMs: 5 } })).toBeUndefined()
    expect(new TurnBudget({ maxTurns: 1 }, new RunCounters()).reserves).toBe(false)
  })

  it('attempts of a run share one ledger; a later attempt with no record fails closed unless a caller holds the spend', () => {
    const book = new RunCounterBook()
    const first = book.acquire('run', { maxOutputTokens: 9_000 })
    expect(first.budget.reserve(ask())).toMatchObject({ ok: true, cap: 8_000 })
    first.release()
    const second = book.acquire('run', { maxOutputTokens: 8_200 }, undefined, { laterAttempt: true })
    expect(second.budget.reserve(ask())).toMatchObject({ ok: false, limit: { kind: 'output_tokens', limit: 8_200, actual: 8_000 } })

    expect(book.acquire('restarted', { maxUsd: 1 }, undefined, { laterAttempt: true }).budget.lost).toBe(true)
    const shared = new RunSpend()
    const kept = book.acquire('shared', { maxUsd: 1 }, undefined, { laterAttempt: true, spend: shared }).budget
    expect(kept.lost).toBe(false)
    expect(kept.reserve(ask())).toMatchObject({ ok: true })
    expect(shared.used().output).toBe(8_000)
    // Counts kept by a caller do not keep the run's own spend.
    expect(book.acquire('mixed', { maxTurns: 3, maxUsd: 1 }, new RunCounters(), { laterAttempt: true }).budget.lost).toBe(true)
  })

  it('a lost budget refuses reservations with the first spend limit', () => {
    const lost = TurnBudget.lost({ maxInputTokens: 10 })
    expect(lost.exhausted).toEqual({ kind: 'input_tokens', limit: 10 })
    expect(lost.reserve(ask())).toMatchObject({ ok: false })
  })
})
