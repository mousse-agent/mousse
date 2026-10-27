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
import { checkPolicy, policyDigest } from '../../src/mms/harness/policy'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import type { BearerTurn } from '../../src/mms/run/mcp/McpCredentials'
import type { McpAttachmentProvider } from '../../src/mms/run/mcp/MousseMcpServer'
import { stableStringify } from '../../src/mms/run/json'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { BindPolicy, ExecutionBinding } from '../../src/shared/harness/types'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const BOT_POLICY: BindPolicy = {
  approvals: 'grants',
  approve: 'host',
  tools: { allow: ['Read', 'Edit'] },
  budget: { maxWallMs: 60_000 },
  authority: { kind: 'bot', digest: 'manifest-1' }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-bind-policy-'))
  homes.push(home)
  const hosts: AdapterHost[] = []
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
    configured: () => true,
    startTurn: async (input, _sink, _ctl, host) => {
      hosts.push(host)
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
    },
    interrupt: async () => 'not_active'
  }
  // A runtime whose every tool Mousse decides, as a locked bot runtime is.
  const driver = adapterDriver(adapter, { toolControl: 'exact' })
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: undefined }), write: () => {} } })
  const harness = testHarness({ drivers: [driver], instances, profileHome: home })
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
      app: { turnToken: 'turn-token', modeCeiling: 'default', mcpEligible: true, instructions: () => ({ sessionInstructions: 'S', turnPreamble: 'P' }) },
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
    expect(binding.policy).toEqual({ ...BOT_POLICY, mode: 'default', origin: 'bot' })
    const expected = createHash('sha256').update(stableStringify({ ...BOT_POLICY, mode: 'default', origin: 'bot' })).digest('hex')
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
    const reordered: BindPolicy = { authority: { digest: 'manifest-1', kind: 'bot' }, budget: { maxWallMs: 60_000 }, tools: { allow: ['Read', 'Edit'] }, approve: 'host', approvals: 'grants' }
    const a = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: BOT_POLICY })
    const b = await s.harness.bind(s.resolved(), { mode: 'agent', origin: 'bot', policy: reordered })
    expect(b.policyDigest).toBe(a.policyDigest)
  })

  it('keeps approvals as the shorthand, and records no digest without a policy', async () => {
    const s = setup()
    const plain = await s.harness.bind(s.resolved(), { mode: 'agent', approvals: 'never' })
    expect(plain.policy).toEqual({ mode: 'default', approvals: 'never', origin: 'interactive' })
    expect(plain.policyDigest).toBeUndefined()
    expect(Object.isFrozen(plain.policy)).toBe(true)
    const both = await s.harness.bind(s.resolved(), { mode: 'agent', approvals: 'never', policy: { approvals: 'grants' } })
    expect(both.policy.approvals).toBe('grants')
  })

  it('needs exact tool control for a host authority', () => {
    const policy = { mode: 'default' as const, approvals: 'ask' as const, authority: { kind: 'bot' as const, digest: 'd' } }
    expect(checkPolicy({ ...CLAUDE_SUBSCRIPTION_CAPABILITIES, planMode: true, contextUsage: 'reported', toolControl: 'exact', budgets: 'unsupported', spendLimits: 'unsupported' }, policy)).toEqual({ ok: true })
    expect(checkPolicy({ ...CLAUDE_SUBSCRIPTION_CAPABILITIES, planMode: true, contextUsage: 'reported', toolControl: 'approval_only', budgets: 'unsupported', spendLimits: 'unsupported' }, policy))
      .toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
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
