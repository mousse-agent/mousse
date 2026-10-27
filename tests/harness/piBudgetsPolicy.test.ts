import { describe, expect, it } from 'vitest'
import { PI_LEGACY_CAPS, PI_RPC_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { checkPolicy } from '../../src/mms/harness/policy'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { RunPolicy } from '../../src/shared/harness/types'

const policy = (budget: RunPolicy['budget']): RunPolicy => ({ mode: 'default', approvals: 'ask', budget })

describe('Pi budgets policy', () => {
  it('the legacy loop refuses count, token and cost limits; the RPC engine reserves token and cost limits', () => {
    expect(PI_LEGACY_CAPS.budgets).toBe('observed')
    expect(checkPolicy(PI_LEGACY_CAPS, policy({ maxTurns: 3 }))).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['budgets'] } })
    expect(checkPolicy(PI_LEGACY_CAPS, policy({ maxUsd: 1 }))).toMatchObject({ ok: false, error: { missing: ['budgets', 'spendLimits'] } })
    expect(PI_LEGACY_CAPS.spendLimits).toBe('unsupported')
    expect(PI_RPC_CAPS.spendLimits).toBe('reserved')
    for (const caps of [PI_LEGACY_CAPS, PI_RPC_CAPS]) expect(checkPolicy(caps, policy({ maxWallMs: 60_000 }))).toEqual({ ok: true })
    // Without the model's facts nothing is assumed.
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxUsd: 1 }))).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
  })

  it('the RPC engine’s model facts: a cap-honouring API, a price, and the smallest request at the effort; one that can never fit is refused at admission', () => {
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const models = [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', api: 'anthropic-messages', reasoning: true, cost, contextWindow: 200_000, maxTokens: 64_000 },
      { id: 'gpt-5', name: 'GPT-5', api: 'openai-responses', reasoning: true, cost, contextWindow: 400_000, maxTokens: 128_000 },
      { id: 'proxy', name: 'Proxy', api: 'openai-responses', reasoning: false, cost, contextWindow: 100_000, maxTokens: 8_000, compat: { supportsMaxOutputTokens: false } },
      { id: 'local', name: 'Local', api: 'openai-completions', reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4_000, compat: { maxTokensField: 'max_tokens' } },
      { id: 'mistral', name: 'Mistral', api: 'mistral-conversations', reasoning: false, cost, contextWindow: 32_000, maxTokens: 4_000 }
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
    expect(check('proxy', { maxOutputTokens: 1_000 })).toMatchObject({ ok: false, error: { missing: ['spendLimits'], reason: 'Proxy cannot cap its output, so token and cost limits cannot be held.' } })
    expect(check('local', { maxOutputTokens: 1_000 })).toEqual({ ok: true })
    expect(check('local', { maxUsd: 1 })).toMatchObject({ ok: false, error: { reason: 'Local has no price, so a cost limit cannot be held.' } })
    expect(check('mistral', { maxInputTokens: 1_000 })).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
  })

  it('the RPC engine holds turn and tool-call counts hard', () => {
    expect(PI_RPC_CAPS.budgets).toBe('hard')
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxTurns: 3 }))).toEqual({ ok: true })
    expect(checkPolicy(PI_RPC_CAPS, policy({ maxToolCalls: 2 }))).toEqual({ ok: true })
  })

  it('declares the RPC caps only for an instance whose config asks for the RPC engine', () => {
    const unused = () => { throw new Error('unused') }
    const rpc = { runtime: unused, catalog: unused }
    const driver = piDriver({ client: unused, rpc })
    // A private home only for the RPC engine: legacy instances keep their home id (and bindings).
    const privateHome = driver.alwaysPrivateHome as (config: ReturnType<typeof driver.decodeConfig>) => boolean
    expect(privateHome(driver.decodeConfig({ engine: 'rpc' }))).toBe(true)
    expect(privateHome(driver.decodeConfig({}))).toBe(false)
    expect(driver.mcpTurnBinding).toBe('per_call')
    expect(driver.caps(driver.decodeConfig({ engine: 'rpc' }))).toBe(PI_RPC_CAPS)
    expect(driver.caps(driver.decodeConfig({}))).toBe(PI_LEGACY_CAPS)
    expect(driver.caps(driver.decodeConfig({ engine: 'nonsense' }))).toBe(PI_LEGACY_CAPS)
    // Without the profile's RPC options every instance stays on the legacy loop.
    const legacyOnly = piDriver({ client: unused })
    expect(legacyOnly.caps(legacyOnly.decodeConfig({ engine: 'rpc' }))).toBe(PI_LEGACY_CAPS)
  })
})
