/**
 * PR 4 §4 `checkPolicy` rows: what each restriction needs from the instance, the model-level
 * `reason` of token and USD limits, the `schedule` origin and purpose (refused on an `uncontrolled`
 * instance), and the new typed error codes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { checkPolicy, INTERACTIVE_PURPOSES, purposeAllowed, type SpendModelFacts } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import type { ProviderAdapter, TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { harnessAppError, HARNESS_ERROR_CODES, type HarnessCaps, type RunPolicy } from '../../src/shared/harness/types'
import { CLAUDE_CODE_CAPS } from '../../src/mms/harness/drivers/claudeCode'

const caps = (patch: Partial<HarnessCaps> = {}): HarnessCaps => ({ ...CLAUDE_CODE_CAPS, toolControl: 'exact', budgets: 'hard', spendLimits: 'reserved', ...patch })
const policy = (patch: Partial<RunPolicy> = {}): RunPolicy => ({ mode: 'default', approvals: 'ask', ...patch })
const model = (patch: Partial<SpendModelFacts> = {}): SpendModelFacts => ({ label: 'Model X', outputCap: true, priced: true, ...patch })
const missing = (result: ReturnType<typeof checkPolicy>) => (result.ok ? [] : result.error.missing)
const reason = (result: ReturnType<typeof checkPolicy>) => (result.ok ? undefined : result.error.reason)

describe('checkPolicy rows', () => {
  it('an exact tool allowlist needs exact tool control', () => {
    const tools = policy({ tools: { allow: ['read'] } })
    expect(checkPolicy(caps(), tools)).toEqual({ ok: true })
    expect(missing(checkPolicy(caps({ toolControl: 'approval_only' }), tools))).toEqual(['toolControl'])
  })

  it('turn and tool-call counts need hard budgets', () => {
    for (const budget of [{ maxTurns: 2 }, { maxToolCalls: 4 }]) {
      expect(checkPolicy(caps({ spendLimits: 'unsupported' }), policy({ budget }))).toEqual({ ok: true })
      expect(missing(checkPolicy(caps({ budgets: 'observed' }), policy({ budget })))).toEqual(['budgets'])
    }
  })

  it.each([{ maxInputTokens: 10_000 }, { maxOutputTokens: 2_000 }])('token limit %o needs hard budgets, reserved spend and a model whose output can be capped', (budget) => {
    expect(checkPolicy(caps(), policy({ budget }), 'i', model())).toEqual({ ok: true })
    // An unpriced model still holds a token limit.
    expect(checkPolicy(caps(), policy({ budget }), 'i', model({ priced: false }))).toEqual({ ok: true })
    expect(missing(checkPolicy(caps({ budgets: 'observed' }), policy({ budget }), 'i', model()))).toEqual(['budgets'])
    expect(missing(checkPolicy(caps({ spendLimits: 'unsupported' }), policy({ budget }), 'i', model()))).toEqual(['spendLimits'])
    const uncapped = checkPolicy(caps(), policy({ budget }), 'i', model({ outputCap: false }))
    expect(uncapped).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['spendLimits'], instanceId: 'i' } })
    expect(reason(uncapped)).toBe('Model X does not always send its output cap, so token and cost limits cannot be held. Pick a model that reports its output cap, or remove the token and cost limits.')
    expect(uncapped.ok ? '' : uncapped.error.message).toContain(reason(uncapped))
  })

  it('a USD limit also needs a priced model', () => {
    const budget = { maxUsd: 1 }
    expect(checkPolicy(caps(), policy({ budget }), 'i', model())).toEqual({ ok: true })
    const unpriced = checkPolicy(caps(), policy({ budget }), 'i', model({ priced: false }))
    expect(missing(unpriced)).toEqual(['spendLimits'])
    expect(reason(unpriced)).toBe('Model X has no price, so a cost limit cannot be held. Set a price for the model, or use a token limit instead.')
  })

  it('unknown model facts refuse spend limits; a missing capability carries no model reason', () => {
    const unknown = checkPolicy(caps(), policy({ budget: { maxOutputTokens: 100 } }))
    expect(missing(unknown)).toEqual(['spendLimits'])
    expect(reason(unknown)).toMatch(/cannot tell whether this model caps its output/)
    const lacking = checkPolicy(caps({ spendLimits: 'unsupported' }), policy({ budget: { maxUsd: 1 } }), 'i', model({ priced: false }))
    expect(lacking).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
    expect(reason(lacking)).toBeUndefined()
  })

  it('approvals other than ask need more than uncontrolled', () => {
    for (const approvals of ['grants', 'never'] as const) {
      expect(checkPolicy(caps({ toolControl: 'approval_only' }), policy({ approvals }))).toEqual({ ok: true })
      expect(missing(checkPolicy(caps({ toolControl: 'uncontrolled' }), policy({ approvals })))).toEqual(['toolControl'])
    }
  })

  it.each(['delegated', 'workflow', 'definition', 'bot', 'schedule'] as const)('a %s origin needs more than uncontrolled', (origin) => {
    expect(checkPolicy(caps({ toolControl: 'approval_only' }), policy({ origin }))).toEqual({ ok: true })
    expect(missing(checkPolicy(caps({ toolControl: 'uncontrolled' }), policy({ origin })))).toEqual(['toolControl'])
  })

  it('a wall-clock budget needs nothing', () => {
    expect(checkPolicy(caps({ toolControl: 'uncontrolled', budgets: 'unsupported', spendLimits: 'unsupported' }), policy({ budget: { maxWallMs: 1_000 } }))).toEqual({ ok: true })
  })
})

describe('error codes', () => {
  it.each([
    ['no_model_selected', 'invalid'],
    ['budget_exhausted', 'denied'],
    ['provider_retired', 'unsupported']
  ] as const)('%s is a %s harness error', (code, category) => {
    expect(HARNESS_ERROR_CODES).toContain(code)
    expect(harnessAppError({ code, message: 'm' }).errorInfo).toMatchObject({ category, retryable: false })
  })

  it('carries the limit and the reason as details', () => {
    const error = harnessAppError({ code: 'budget_exhausted', message: 'Out of turns.', limit: { kind: 'turns', limit: 2, actual: 2 } })
    expect(error.details).toEqual({ limit: { kind: 'turns', limit: 2, actual: 2 } })
    expect(harnessAppError({ code: 'policy_unenforceable', message: 'm', missing: ['spendLimits'], reason: 'no price' }).details).toEqual({ missing: ['spendLimits'], reason: 'no price' })
  })
})

describe('the schedule purpose and origin on the gateway', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  /** A runtime whose turns finish at once. */
  function adapter(): ProviderAdapter & { turns: TurnInput[] } {
    const turns: TurnInput[] = []
    return {
      driver: 'codex',
      capabilities: { ...CODEX_CAPABILITIES },
      configured: () => true,
      turns,
      startTurn: async (input) => {
        turns.push(input)
        return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'codex' } }
      },
      interrupt: async () => 'not_active'
    }
  }

  function fixture(extra: Parameters<typeof adapterDriver>[1]) {
    const home = mkdtempSync(join(tmpdir(), 'mousse-policy-rules-'))
    homes.push(home)
    const runtime = adapter()
    let stored: unknown = { codex: { driver: 'codex', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [adapterDriver(runtime, extra)], instances, profileHome: home })
    const spec = (binding: TurnSpec['binding']): TurnSpec => ({
      binding,
      input: { threadId: 'thread-1', instanceId: 'codex', llmProvider: 'codex', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    return { harness, runtime, spec }
  }

  it('is not an interactive purpose: an uncontrolled instance is refused for it', () => {
    expect(INTERACTIVE_PURPOSES.has('schedule')).toBe(false)
    expect(purposeAllowed({ toolControl: 'uncontrolled' }, 'schedule')).toBe(false)
    const { harness } = fixture({ toolControl: 'uncontrolled' })
    expect(() => harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'schedule' }))
      .toThrow(expect.objectContaining({ code: 'policy_unenforceable', details: expect.objectContaining({ missing: ['toolControl'] }) }))
    harness.stop()
  })

  it('a schedule-origin binding is refused at admission on an uncontrolled instance', async () => {
    const { harness, runtime, spec } = fixture({ toolControl: 'uncontrolled' })
    const resolved = harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const binding = await harness.bind(resolved, { mode: 'agent', origin: 'schedule' })
    expect(binding.policy).toMatchObject({ origin: 'schedule', approvals: 'ask' })
    await expect(harness.startTurn(spec(binding)).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(runtime.turns).toHaveLength(0)
    harness.stop()
  })

  it('admission reads the runtime\'s model facts for spend limits and refuses with their reason', async () => {
    const facts: string[] = []
    const { harness, runtime, spec } = fixture({
      budgets: 'hard',
      spendLimits: 'reserved',
      runtime: { spendModel: (name) => (facts.push(name), { label: 'Model M', outputCap: true, priced: name !== 'm' }) }
    })
    const resolved = harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const bound = await harness.bind(resolved, { mode: 'agent' })
    // No spend limit: the facts are not read.
    await harness.startTurn(spec(bound)).result
    expect(facts).toEqual([])
    await harness.startTurn(spec({ ...bound, policy: { ...bound.policy, budget: { maxOutputTokens: 500 } } })).result
    await expect(harness.startTurn(spec({ ...bound, policy: { ...bound.policy, budget: { maxUsd: 1 } } })).result)
      .rejects.toMatchObject({ code: 'policy_unenforceable', details: { missing: ['spendLimits'], reason: 'Model M has no price, so a cost limit cannot be held. Set a price for the model, or use a token limit instead.' } })
    expect(facts).toEqual(['m', 'm'])
    expect(runtime.turns).toHaveLength(2)
    harness.stop()
  })
})
