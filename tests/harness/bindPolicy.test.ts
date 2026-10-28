/**
 * PR 6 §2: `bind(…, {policy})`. The caller's policy (tools, approvals, approve, budget, authority)
 * is frozen into the binding with its digest; a stored binding runs on exactly that policy (retries
 * reuse it); and a thread whose next binding has another digest gets a new Mousse MCP epoch.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { BOT_RUNTIME_GAPS, botRuntimeGapReason, checkPolicy, HOST_APPROVALS_UNAVAILABLE, policyDigest } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter } from '../../src/mms/harness/adapter'
import type { BearerTurn } from '../../src/mms/run/mcp/McpCredentials'
import type { McpAttachmentProvider } from '../../src/mms/run/mcp/MousseMcpServer'
import { stableStringify } from '../../src/mms/run/json'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { BindPolicy, ExecutionBinding } from '../../src/shared/harness/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const BOT_POLICY: BindPolicy = {
  approvals: 'grants',
  tools: { allow: ['Read', 'Edit'] },
  budget: { maxWallMs: 60_000 },
  authority: { kind: 'bot', digest: 'manifest-1' }
}

/** A bot authority as the bot engine registers it with a turn's app context. */
const APP_BOT = { activationId: 'act-1', check: () => ({ ok: true }) } as unknown as BotAuthority

function setup(options: { botAuthority?: boolean; gaps?: readonly string[]; startTurn?: ProviderAdapter['startTurn'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bind-policy-'))
  homes.push(home)
  const hosts: AdapterHost[] = []
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
    configured: () => true,
    startTurn: options.startTurn ?? (async (input, _sink, _ctl, host) => {
      hosts.push(host)
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
    }),
    interrupt: async () => 'not_active'
  }
  // A runtime whose every tool Mousse decides, as a locked bot runtime is.
  const base = adapterDriver(adapter, { toolControl: 'exact' })
  const driver = options.botAuthority ? { ...base, botAuthority: () => true } : base
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: undefined }), write: () => {} } })
  // Bot runtimes are refused while they lack a piece (`BOT_RUNTIME_GAPS`); these tests remove the switch unless they test it.
  const harness = testHarness({ drivers: [driver], instances, profileHome: home, botRuntimeGaps: options.gaps ?? [] })
  const bearers: BearerTurn[] = []
  const mcp: McpAttachmentProvider = {
    bearerForTurn: (input) => {
      bearers.push(input)
      return { url: 'http://127.0.0.1:1/mcp', token: `tok-${bearers.length}`, tokenHash: `hash-${bearers.length}` }
    },
    turnEnded: () => 'kept',
    revokeThread: () => {}
  }
  harness.setMcpAttachment(mcp)
  const resolved = () => harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'm' }, { purpose: 'turn' })
  const spec = (binding: ExecutionBinding, runId = 'run-1', attemptOrdinal?: number): TurnSpec => {
    const noop = () => {}
    return {
      binding,
      input: { runId, attemptId: `${runId}-${attemptOrdinal ?? 1}`, threadId: 'thread-1', cwd: null, instanceId: 'claude', model: 'm', llmProvider: 'claude', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
      app: { turnToken: 'turn-token', modeCeiling: 'default', mcpEligible: true, instructions: () => ({ sessionInstructions: 'S', turnPreamble: 'P' }), ...(binding.policy.authority?.kind === 'bot' ? { bot: APP_BOT } : {}) },
      ...(attemptOrdinal ? { attemptOrdinal } : {})
    }
  }
  return { harness, hosts, bearers, resolved, spec }
}

/** A binding as the run store keeps it and reads it back (`RunStore`: stable JSON). */
function stored(binding: ExecutionBinding): ExecutionBinding {
  return JSON.parse(stableStringify(binding)) as ExecutionBinding
}

describe('bind with a policy', () => {
  it('records the caller\'s policy with the mode and origin, frozen, with the digest of its canonical JSON', async () => {
    const s = setup()
    const caller = structuredClone(BOT_POLICY)
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: caller })
    expect(binding.policy).toEqual({ ...BOT_POLICY, mode: 'default', origin: 'bot', permissionMode: 'ask' })
    const expected = createHash('sha256').update(stableStringify({ ...BOT_POLICY, mode: 'default', origin: 'bot', permissionMode: 'ask' })).digest('hex')
    expect(binding.policyDigest).toBe(expected)
    expect(policyDigest(binding.policy)).toBe(expected)
    // Frozen to its leaves; the caller's own object stays the caller's.
    expect(Object.isFrozen(binding.policy)).toBe(true)
    expect(Object.isFrozen(binding.policy.tools!.allow)).toBe(true)
    expect(Object.isFrozen(binding.policy.authority)).toBe(true)
    expect(() => { (binding.policy.tools!.allow as string[]).push('Bash') }).toThrow()
    caller.tools!.allow.push('Bash')
    caller.authority!.digest = 'manifest-2'
    expect(binding.policy.tools).toEqual({ allow: ['Read', 'Edit'] })
    expect(binding.policy.authority).toEqual({ kind: 'bot', digest: 'manifest-1' })
  })

  it('gives the same digest whatever order the caller wrote the policy in', async () => {
    const s = setup()
    const reordered: BindPolicy = { authority: { digest: 'manifest-1', kind: 'bot' }, budget: { maxWallMs: 60_000 }, tools: { allow: ['Read', 'Edit'] }, approvals: 'grants' }
    const a = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY })
    const b = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: reordered })
    expect(b.policyDigest).toBe(a.policyDigest)
  })

  it('keeps approvals as the shorthand, and records no digest without a policy', async () => {
    const s = setup()
    const plain = await s.harness.bind(s.resolved(), { mode: 'agent', approvals: 'never' })
    expect(plain.policy).toEqual({ mode: 'default', approvals: 'never', origin: 'interactive', permissionMode: 'ask' })
    expect(plain.policyDigest).toBeUndefined()
    expect(Object.isFrozen(plain.policy)).toBe(true)
    const both = await s.harness.bind(s.resolved(), { mode: 'agent', approvals: 'never', policy: { approvals: 'grants' } })
    expect(both.policy.approvals).toBe('grants')
  })

  it('needs exact tool control for a host authority', () => {
    const policy = { mode: 'default' as const, approvals: 'ask' as const, authority: { kind: 'bot' as const, digest: 'd' } }
    expect(checkPolicy({ ...CLAUDE_SUBSCRIPTION_CAPABILITIES, planMode: true, contextUsage: 'reported', toolControl: 'exact', budgets: 'unsupported', spendLimits: 'unsupported' }, policy, undefined, undefined, { botRuntimeGaps: [] })).toEqual({ ok: true })
    expect(checkPolicy({ ...CLAUDE_SUBSCRIPTION_CAPABILITIES, planMode: true, contextUsage: 'reported', toolControl: 'approval_only', budgets: 'unsupported', spendLimits: 'unsupported' }, policy, undefined, undefined, { botRuntimeGaps: [] }))
      .toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
  })
})

describe('approvals answered by the host', () => {
  it('are recorded in the binding but refused at admission until a runtime answers them', async () => {
    const s = setup()
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, approve: 'host' } })
    expect(binding.policy.approve).toBe('host')
    expect(binding.policyDigest).not.toBe((await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY })).policyDigest)
    await expect(s.harness.startTurn(s.spec(binding)).result).rejects.toMatchObject({ code: 'policy_unenforceable', details: { missing: ['toolControl'], reason: HOST_APPROVALS_UNAVAILABLE } })
    expect(s.hosts).toHaveLength(0)
    const exact = { ...CLAUDE_SUBSCRIPTION_CAPABILITIES, planMode: true, contextUsage: 'reported' as const, toolControl: 'exact' as const, budgets: 'hard' as const, spendLimits: 'unsupported' as const }
    expect(checkPolicy(exact, { mode: 'default', approvals: 'grants', approve: 'host' })).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'], reason: HOST_APPROVALS_UNAVAILABLE } })
    expect(checkPolicy(exact, { mode: 'default', approvals: 'grants' })).toEqual({ ok: true })
  })
})

describe('approvals answered by a bot authority (PR 6 6c-1)', () => {
  const authority = { activationId: 'act-1', check: () => ({ ok: true }) } as unknown as BotAuthority

  it('are admitted on a runtime that holds every call to it, which receives that authority and the shared counts', async () => {
    const s = setup({ botAuthority: true })
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, approve: 'host' } })
    const charged: string[] = []
    const counters = { charge: (kind: 'request' | 'tool') => { charged.push(kind); return { ok: true as const, count: charged.length } } }
    const spec = s.spec(binding)
    await s.harness.startTurn({ ...spec, app: { ...spec.app!, bot: authority }, host: { ...spec.host, bot: { forged: true } as never }, counters }).result
    expect(s.hosts).toHaveLength(1)
    // The authority comes only from the app context; one the caller put on the host is dropped.
    expect(s.hosts[0].bot).toBe(authority)
    expect(s.harness.checkPolicy('claude', { mode: 'default', origin: 'bot', ...BOT_POLICY, approve: 'host' })).toEqual({ ok: true })
  })

  it('a bot policy without its bot authority never reaches the runtime, nor does a bot authority on another policy', async () => {
    const s = setup({ botAuthority: true })
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, approve: 'host' } })
    const spec = s.spec(binding)
    const { bot: _bot, ...plainApp } = spec.app!
    // An ordinary app context, and a forged authority on the host, are both refused.
    await expect(s.harness.startTurn({ ...spec, app: plainApp, host: { ...spec.host, bot: APP_BOT } }).result).rejects.toMatchObject({ code: 'policy_unenforceable', message: 'This bot turn has no bot authority, so it does not run.' })
    const plain = await s.harness.bind(s.resolved(), { mode: 'agent', approvals: 'grants' })
    await expect(s.harness.startTurn({ ...s.spec(plain), app: { ...s.spec(plain).app!, bot: APP_BOT } }).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(s.hosts).toHaveLength(0)
  })

  it('fail closed: with bot runtimes still lacking a piece, a bot turn is refused at admission', async () => {
    const s = setup({ botAuthority: true, gaps: BOT_RUNTIME_GAPS })
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, approve: 'host' } })
    await expect(s.harness.startTurn(s.spec(binding)).result).rejects.toMatchObject({ code: 'policy_unenforceable', details: { missing: ['containment'], reason: botRuntimeGapReason(BOT_RUNTIME_GAPS) } })
    expect(s.hosts).toHaveLength(0)
    expect(s.harness.checkPolicy('claude', { mode: 'default', origin: 'bot', ...BOT_POLICY, approve: 'host' })).toMatchObject({ ok: false, error: { missing: ['containment'] } })
  })

  it('a wall-clock budget stops the attempt when it runs out', async () => {
    let seen: AbortSignal | undefined
    const s = setup({
      botAuthority: true,
      startTurn: async (input) => {
        seen = input.signal
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { text: '', aborted: true, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
      }
    })
    const binding = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, approve: 'host', budget: { maxWallMs: 30 } } })
    const result = await s.harness.startTurn(s.spec(binding)).result
    expect(result.aborted).toBe(true)
    expect(seen?.aborted).toBe(true)
  })

  it('are refused on the same runtime for anything but a bot authority', () => {
    const s = setup({ botAuthority: true })
    expect(s.harness.checkPolicy('claude', { mode: 'default', approvals: 'grants', approve: 'host', authority: { kind: 'definition', digest: 'd' } }))
      .toMatchObject({ ok: false, error: { reason: HOST_APPROVALS_UNAVAILABLE } })
    expect(s.harness.checkPolicy('missing', { mode: 'default', approvals: 'ask' })).toMatchObject({ ok: false, error: { code: 'policy_unenforceable' } })
  })
})

describe('a stored binding keeps its policy', () => {
  it('a retry of the run runs on the stored binding\'s policy, and a binding whose policy changed is refused', async () => {
    const s = setup()
    const binding = stored(await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY }))
    await s.harness.startTurn(s.spec(binding)).result
    await s.harness.startTurn(s.spec(stored(binding), 'run-1', 2)).result
    expect(s.hosts).toHaveLength(2)
    expect(s.hosts.map((host) => host.bridge?.toolPolicy)).toEqual([{ allow: ['Read', 'Edit'] }, { allow: ['Read', 'Edit'] }])
    // A record whose policy was widened after it was bound never runs.
    const widened = stored(binding)
    widened.policy.tools = { allow: ['Read', 'Edit', 'Bash'] }
    await expect(s.harness.startTurn(s.spec(widened, 'run-2')).result).rejects.toMatchObject({ code: 'protocol' })
    expect(s.hosts).toHaveLength(2)
  })
})

describe('a policy change is a new MCP epoch', () => {
  it('adds the digest to the bearer\'s generation: the same policy keeps it, another digest changes it', async () => {
    const s = setup()
    const first = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY })
    await s.harness.startTurn(s.spec(first, 'run-1')).result
    const same = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY })
    await s.harness.startTurn(s.spec(same, 'run-2')).result
    const narrower = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: { ...BOT_POLICY, tools: { allow: ['Read'] }, authority: { kind: 'bot', digest: 'manifest-2' } } })
    await s.harness.startTurn(s.spec(narrower, 'run-3')).result
    const generations = s.bearers.map((bearer) => bearer.generation)
    expect(generations[0]).toBe(`claude|default|0|0|${first.policyDigest}`)
    expect(generations[1]).toBe(generations[0])
    expect(generations[2]).toBe(`claude|default|0|0|${narrower.policyDigest}`)
    expect(generations[2]).not.toBe(generations[0])
  })

  it('leaves the generation of a binding without a policy as it was', async () => {
    const s = setup()
    await s.harness.startTurn(s.spec(await s.harness.bind(s.resolved(), { mode: 'agent' }))).result
    expect(s.bearers[0].generation).toBe('claude|default|0|0')
  })
})
