/**
 * Tool control (agent CLIs plan §2): every driver states how far Mousse controls its tools, the
 * policy rules read it, and an instance whose runtime approves tools itself runs only turns a
 * person drives: by purpose at resolve, and by the binding's origin at every admission (first
 * dispatch, retry, continuation).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ANTIGRAVITY_CAPS } from '../../src/mms/harness/drivers/antigravity'
import { CLAUDE_CODE_CAPS } from '../../src/mms/harness/drivers/claudeCode'
import { CODEX_CAPS } from '../../src/mms/harness/drivers/codex'
import { PI_LEGACY_CAPS } from '../../src/mms/harness/drivers/piLegacy'
import { checkPolicy, INTERACTIVE_PURPOSES, purposeAllowed, toolControlLevel } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import type { HarnessCaps, RunPolicy } from '../../src/shared/harness/types'

const base: HarnessCaps = { ...CLAUDE_CODE_CAPS }
const caps = (toolControl: HarnessCaps['toolControl']): HarnessCaps => ({ ...base, toolControl })
const policy = (patch: Partial<RunPolicy> = {}): RunPolicy => ({ mode: 'default', approvals: 'ask', ...patch })

describe('tool control levels', () => {
  it('is declared by every driver', () => {
    expect(PI_LEGACY_CAPS.toolControl).toBe('exact')
    expect(CLAUDE_CODE_CAPS.toolControl).toBe('approval_only')
    expect(CODEX_CAPS.toolControl).toBe('approval_only')
    expect(ANTIGRAVITY_CAPS.toolControl).toBe('approval_only')
  })

  it('reads caps without the key as uncontrolled', () => {
    expect(toolControlLevel({})).toBe('uncontrolled')
  })
})

describe('checkPolicy', () => {
  it('needs exact control for a tool allowlist (the pi loop keeps it, agents refuse it)', () => {
    const tools = policy({ tools: { allow: ['read'] } })
    expect(checkPolicy(PI_LEGACY_CAPS, tools)).toEqual({ ok: true })
    expect(checkPolicy(CLAUDE_CODE_CAPS, tools)).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
  })

  it.each(['grants', 'never'] as const)('needs exact or approval_only control for approvals: %s', (approvals) => {
    expect(checkPolicy(caps('exact'), policy({ approvals }))).toEqual({ ok: true })
    expect(checkPolicy(caps('approval_only'), policy({ approvals }))).toEqual({ ok: true })
    expect(checkPolicy(caps('uncontrolled'), policy({ approvals }))).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
  })

  it('needs hard budgets for counts, hard budgets and reserved spend for tokens and USD, nothing for wall clock', () => {
    const limits = (budgets: HarnessCaps['budgets'], spendLimits: HarnessCaps['spendLimits'] = 'unsupported'): HarnessCaps => ({ ...caps('exact'), budgets, spendLimits })
    // A model whose output cap the driver bounds, with a price (the model rows are in `policyRules.test.ts`).
    const model = { label: 'M', outputCap: true, priced: true }
    expect(PI_LEGACY_CAPS.budgets).toBe('observed')
    for (const agent of [CLAUDE_CODE_CAPS, CODEX_CAPS, ANTIGRAVITY_CAPS]) expect(agent.budgets).toBe('unsupported')
    for (const any of [PI_LEGACY_CAPS, CLAUDE_CODE_CAPS, CODEX_CAPS, ANTIGRAVITY_CAPS]) expect(any.spendLimits).toBe('unsupported')
    expect(checkPolicy(limits('observed'), policy({ budget: { maxTurns: 3 } }))).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
    expect(checkPolicy(limits('observed'), policy({ budget: { maxToolCalls: 10 } }))).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
    expect(checkPolicy(limits('hard'), policy({ budget: { maxTurns: 3, maxToolCalls: 10 } }))).toEqual({ ok: true })
    // Token and spend limits: the failing keys in order.
    expect(checkPolicy(limits('unsupported'), policy({ budget: { maxUsd: 1 } }))).toMatchObject({ ok: false, error: { missing: ['budgets', 'spendLimits'] } })
    expect(checkPolicy(limits('hard'), policy({ budget: { maxInputTokens: 1000 } }))).toMatchObject({ ok: false, error: { missing: ['spendLimits'] } })
    expect(checkPolicy(limits('observed', 'reserved'), policy({ budget: { maxOutputTokens: 1000 } }), undefined, model)).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
    expect(checkPolicy(limits('hard', 'reserved'), policy({ budget: { maxTurns: 3, maxInputTokens: 1, maxOutputTokens: 1, maxUsd: 1 } }), undefined, model)).toEqual({ ok: true })
    expect(checkPolicy(PI_LEGACY_CAPS, policy({ budget: { maxTurns: 3 } }))).toEqual({ ok: false, error: expect.objectContaining({ missing: ['budgets'] }) })
    // Explicitly hard caps admit turn and spend limits.
    expect(checkPolicy({ ...PI_LEGACY_CAPS, budgets: 'hard', spendLimits: 'reserved' }, policy({ budget: { maxTurns: 3, maxUsd: 2 } }), undefined, model)).toEqual({ ok: true })
    expect(checkPolicy(CLAUDE_CODE_CAPS, policy({ budget: { maxTurns: 3 } }))).toMatchObject({ ok: false })
    expect(checkPolicy({ ...caps('uncontrolled'), budgets: 'unsupported' }, policy({ budget: { maxWallMs: 60_000 } }))).toEqual({ ok: true })
  })

  it.each(['delegated', 'workflow', 'definition', 'bot'] as const)('refuses an uncontrolled instance for a %s turn', (origin) => {
    expect(checkPolicy(caps('uncontrolled'), policy({ origin }))).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    expect(checkPolicy(caps('approval_only'), policy({ origin }))).toEqual({ ok: true })
  })

  it('runs an uncontrolled instance for a person, including bindings recorded before origins', () => {
    expect(checkPolicy(caps('uncontrolled'), policy({ origin: 'interactive' }))).toEqual({ ok: true })
    expect(checkPolicy(caps('uncontrolled'), policy())).toEqual({ ok: true })
  })

  it('still names a missing plan mode', () => {
    expect(checkPolicy({ ...caps('exact'), planMode: false }, policy({ mode: 'plan' }))).toMatchObject({ ok: false, error: { missing: ['planMode'] } })
  })
})

describe('purposes', () => {
  it('allows only the interactive purposes on an uncontrolled instance', () => {
    for (const purpose of INTERACTIVE_PURPOSES) expect(purposeAllowed(caps('uncontrolled'), purpose)).toBe(true)
    for (const purpose of ['delegate_task', 'definition', 'workflow', 'title', 'bot_reply'])
      expect(purposeAllowed(caps('uncontrolled'), purpose), purpose).toBe(false)
    expect(purposeAllowed(caps('approval_only'), 'delegate_task')).toBe(true)
  })
})

/** A runtime that approves tools itself; turns finish at once. */
class SelfApproving implements ProviderAdapter {
  readonly driver = 'codex' as const
  readonly capabilities = { ...CODEX_CAPS }
  readonly turns: TurnInput[] = []
  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1]): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('the gateway on an uncontrolled instance', () => {
  const homes: string[] = []
  const harnesses: Harness[] = []
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.stop()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'mousse-tool-control-'))
    homes.push(home)
    const adapter = new SelfApproving()
    let stored: unknown = { codex: { driver: 'codex', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const notices: Array<[string, string]> = []
    const harness = testHarness({ drivers: [adapterDriver(adapter, { toolControl: 'uncontrolled' })], instances, profileHome: home })
    harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
    harnesses.push(harness)
    const spec = (binding: TurnSpec['binding'], threadId = 'thread-1', previous?: TurnSpec['binding']): TurnSpec => ({
      binding,
      ...(previous ? { previous } : {}),
      input: { threadId, instanceId: 'codex', llmProvider: 'codex', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    return { harness, adapter, notices, spec }
  }

  it('resolves for the composer and refuses delegation, definitions, workflows and titles', () => {
    const { harness } = fixture()
    expect(harness.resolve({ instanceId: 'codex', model: 'm' }, { kind: 'device' }, 'composer').caps.toolControl).toBe('uncontrolled')
    for (const purpose of ['delegate_task', 'definition', 'workflow'] as const)
      expect(() => harness.resolve({ instanceId: 'codex', model: 'm' }, { kind: 'device' }, purpose)).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
    expect(() => harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'delegate_task' })).toThrow(/approves tools itself/)
  })

  it('refuses a delegated child turn, its retry and its continuation, and runs a person’s turn', async () => {
    const { harness, adapter, spec } = fixture()
    const resolved = harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const delegated = await harness.bind(resolved, { mode: 'agent', origin: 'delegated' })
    expect(delegated.policy.origin).toBe('delegated')
    // First dispatch, a retry of the same stored binding, and a continuation that names it as previous.
    await expect(harness.startTurn(spec(delegated, 'child')).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    await expect(harness.startTurn(spec(structuredClone(delegated), 'child')).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    await expect(harness.startTurn(spec(structuredClone(delegated), 'child', delegated)).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    const workflow = await harness.bind(resolved, { mode: 'agent', origin: 'workflow' })
    await expect(harness.startTurn(spec(workflow, 'step')).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(adapter.turns).toEqual([])
    const interactive = await harness.bind(resolved, { mode: 'agent' })
    await expect(harness.startTurn(spec(interactive)).result).resolves.toMatchObject({ text: 'ok' })
    expect(adapter.turns).toHaveLength(1)
  })

  it('tells a thread once that the instance approves tools itself', async () => {
    const { harness, notices, spec } = fixture()
    const resolved = harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const first = await harness.bind(resolved, { mode: 'agent' })
    await harness.startTurn(spec(first)).result
    const second = await harness.bind(resolved, { mode: 'agent' })
    await harness.startTurn(spec(second, 'thread-1', first)).result
    await harness.startTurn(spec(await harness.bind(resolved, { mode: 'agent' }), 'thread-2')).result
    expect(notices).toEqual([['thread-1', 'Test codex approves tools itself.'], ['thread-2', 'Test codex approves tools itself.']])
  })
})
