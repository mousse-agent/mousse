import { describe, expect, it } from 'vitest'
import { PI_RPC_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { checkPolicy } from '../../src/mms/harness/policy'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import { RunCounters, TurnBudget, type BudgetLimits } from '../../src/mms/harness/budget'
import type { RunPolicy } from '../../src/shared/harness/types'

const policy = (budget: RunPolicy['budget']): RunPolicy => ({ mode: 'default', approvals: 'ask', budget })

describe('Pi budgets policy', () => {
  it('the RPC engine reserves token and cost limits, and a definition stays refused there until it earns `exact`', () => {
    expect(PI_RPC_CAPS.spendLimits).toBe('reserved')
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxWallMs: 60_000 }))).toEqual({ ok: true })
    // Without the model's facts nothing is assumed.
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxUsd: 1 }))).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
    const definition: RunPolicy = {
      ...policy({ maxTurns: 32, maxToolCalls: 64, maxInputTokens: 1_000, maxOutputTokens: 500, maxUsd: 1 }),
      approvals: 'grants', origin: 'definition', tools: { allow: ['read'] }, authority: { kind: 'definition', digest: 'd'.repeat(64) }
    }
    expect(checkPolicy(PI_RPC_CAPS, definition)).toMatchObject({ ok: false, error: { missing: expect.arrayContaining(['toolControl']) } })
  })

  it('the RPC engine’s model facts: a cap-honouring API, a price, and the smallest request at the effort; one that can never fit is refused at admission', () => {
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const models = [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', api: 'anthropic-messages', reasoning: true, cost, contextWindow: 200_000, maxTokens: 64_000 },
      { id: 'gpt-5', name: 'GPT-5', api: 'openai-responses', reasoning: true, cost, contextWindow: 400_000, maxTokens: 128_000 },
      { id: 'proxy', name: 'Proxy', api: 'openai-responses', reasoning: false, cost, contextWindow: 100_000, maxTokens: 8_000, compat: { supportsMaxOutputTokens: false } },
      { id: 'local', name: 'Local', api: 'openai-completions', reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4_000, compat: { maxTokensField: 'max_tokens' } },
      { id: 'mistral', name: 'Mistral', api: 'mistral-conversations', reasoning: false, cost, contextWindow: 32_000, maxTokens: 4_000 },
      { id: 'input-only', name: 'Input only', api: 'openai-completions', reasoning: false, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4_000 },
      { id: 'twice', name: 'Twice', api: 'openai-completions', reasoning: false, cost, contextWindow: 32_000, maxTokens: 4_000, samplingParams: { n: 2 } }
    ]
    const engine = new PiRpcEngine({ instanceId: 'pi:x', provider: 'x', label: 'X', capabilities: PI_RPC_CAPS, catalog: () => ({ revision: 1, provider: { id: 'x', builtin: false, models: models as never } }) } as unknown as PiRpcEngineOptions)
    const check = (model: string, budget: RunPolicy['budget']) => checkPolicy(PI_RPC_CAPS, policy(budget), 'pi:x', engine.spendModel(model))

    expect(engine.spendModel('claude-sonnet-4-5:high')).toMatchObject({ outputCap: true, priced: true, effort: 'high', smallestCap: 16_384 + 1_024 })
    expect(engine.spendModel('claude-sonnet-4-5')).toMatchObject({ effort: 'off', smallestCap: 256 })
    // openai-responses adds no thinking budget to the cap.
    expect(engine.spendModel('gpt-5:high')).toMatchObject({ outputCap: true, smallestCap: 256 })
    expect(engine.spendModel('unknown')).toBeUndefined()

    expect(check('claude-sonnet-4-5:high', { maxOutputTokens: 20_000 })).toEqual({ ok: true })
    const tooSmall = check('claude-sonnet-4-5:high', { maxOutputTokens: 10_000 })
    expect(tooSmall).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['spendLimits'] } })
    expect(tooSmall.ok ? '' : tooSmall.error.reason).toMatch(/Claude Sonnet 4\.5 at high effort needs at least 17408 output tokens/)
    expect(check('claude-sonnet-4-5:low', { maxOutputTokens: 10_000 })).toEqual({ ok: true })
    // $0.20 buys 13,333 output tokens at $15/M: under `high`'s smallest request.
    expect(check('claude-sonnet-4-5:high', { maxUsd: 0.2 })).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
    expect(check('claude-sonnet-4-5:high', { maxUsd: 1 })).toEqual({ ok: true })

    // `supportsMaxOutputTokens: false` drops the cap on openai-responses only; openai-completions always sends one.
    expect(check('proxy', { maxOutputTokens: 1_000 })).toMatchObject({ ok: false, error: { missing: ['spendLimits'], reason: 'Proxy does not always send its output cap, so token and cost limits cannot be held. Pick a model that reports its output cap, or remove the token and cost limits.' } })
    expect(check('local', { maxOutputTokens: 1_000 })).toEqual({ ok: true })
    expect(check('local', { maxUsd: 1 })).toMatchObject({ ok: false, error: { reason: 'Local has no price, so a cost limit cannot be held. Set a price for the model, or use a token limit instead.' } })
    expect(check('mistral', { maxInputTokens: 1_000 })).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
    // A price on one side only is no price; two completions per request double the cap.
    expect(check('input-only', { maxUsd: 1 })).toMatchObject({ ok: false, error: { reason: 'Input only has no price, so a cost limit cannot be held. Set a price for the model, or use a token limit instead.' } })
    expect(check('twice', { maxOutputTokens: 1_000 })).toMatchObject({ ok: false, error: { reason: 'Twice does not always send its output cap, so token and cost limits cannot be held. Pick a model that reports its output cap, or remove the token and cost limits.' } })
  })

  it('a request is reserved at Mousse’s own catalogue prices for the turn’s model; any other model, or a model without prices under a USD limit, is refused', () => {
    const models = [
      { id: 'priced', name: 'Priced', api: 'openai-completions', reasoning: false, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 },
      { id: 'free', name: 'Free', api: 'openai-completions', reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }
    ]
    const engine = new PiRpcEngine({ instanceId: 'pi:x', provider: 'x', label: 'X', capabilities: PI_RPC_CAPS, catalog: () => ({ revision: 1, provider: { id: 'x', builtin: false, models: models as never } }) } as unknown as PiRpcEngineOptions)
    const admit = (model: string, limits: BudgetLimits, spendModel: { provider: string; id: string; api: string }) => {
      const budget = new TurnBudget(limits, new RunCounters())
      const thread = { alive: true, reservations: new Map(), turn: { phase: 'running', host: { budget }, input: { model } } }
      const answer = (engine as unknown as { admitRequest(thread: unknown, request: unknown): { ok: boolean; reservation?: { cap: number } } }).admitRequest(thread, { attemptToken: 'a', kind: 'request', spend: { inputBound: 1_000, wireCap: 8_000, thinkingBudget: 0, model: spendModel } })
      return { answer, budget }
    }
    // $0.10 at $6/M input (a one-hour cache write) and $15/M output: 1,000 input leave 6,266 output tokens.
    expect(admit('priced', { maxUsd: 0.1 }, { provider: 'x', id: 'priced', api: 'openai-completions' }).answer).toMatchObject({ ok: true, reservation: { cap: 6_266 } })
    expect(admit('priced', { maxUsd: 0.1 }, { provider: 'x', id: 'free', api: 'openai-completions' }).answer).toMatchObject({ ok: false, reason: 'mousse_request_refused' })
    expect(admit('priced', { maxUsd: 0.1 }, { provider: 'other', id: 'priced', api: 'openai-completions' }).answer).toMatchObject({ ok: false })
    expect(admit('free', { maxUsd: 0.1 }, { provider: 'x', id: 'free', api: 'openai-completions' }).answer).toMatchObject({ ok: false, reason: 'mousse_request_refused' })
    // A token limit needs no price.
    expect(admit('free', { maxOutputTokens: 5_000 }, { provider: 'x', id: 'free', api: 'openai-completions' }).answer).toMatchObject({ ok: true, reservation: { cap: 5_000 } })
    // A turn without spend limits reserves nothing, whatever the request says it would spend.
    expect(admit('priced', { maxTurns: 3 }, { provider: 'x', id: 'priced', api: 'openai-completions' }).answer).toEqual({ ok: true })
  })

  it('the RPC engine holds turn and tool-call counts hard', () => {
    expect(PI_RPC_CAPS.budgets).toBe('hard')
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxTurns: 3 }))).toEqual({ ok: true })
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxToolCalls: 2 }))).toEqual({ ok: true })
  })

  it('declares the RPC caps for every instance, in a home of its own', () => {
    const unused = () => { throw new Error('unused') }
    const driver = piDriver({ rpc: { runtime: unused, catalog: unused } })
    expect(driver.alwaysPrivateHome).toBe(true)
    expect(driver.mcpTurnBinding).toBe('per_call')
    // No packaged runtime to read a version from, so no evidence: approval only.
    expect(driver.caps(driver.decodeConfig({}))).toBe(PI_RPC_CAPS)
    // A stored engine from before is ignored.
    expect(driver.caps(driver.decodeConfig({ engine: 'legacy' }))).toBe(PI_RPC_CAPS)
    // Without the profile's RPC options the caps are the same; every turn is refused.
    const noRuntime = piDriver()
    expect(noRuntime.caps(noRuntime.decodeConfig({}))).toBe(PI_RPC_CAPS)
  })
})
