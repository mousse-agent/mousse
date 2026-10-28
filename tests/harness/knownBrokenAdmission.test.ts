/**
 * A version with a known problem (plan PR 5 §5): every dispatch passes one gate, so a blocked
 * version starts no turn on any path; "Run anyway with <version>" holds only for the version,
 * executable and install receipt the gateway checked itself.
 */
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownBrokenVersions } from '../../src/mms/harness/compatibility'
import type { HarnessDriver, ManagedInstall } from '../../src/mms/harness/driver'
import type { BindInput, Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { ProviderAdapter, TurnResult } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiStubAdapter } from '../support/piStub'

const dirs: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const noop = () => {}
const KNOWN_BROKEN: KnownBrokenVersions[] = [{ range: '2.1.5 - 2.1.9', reason: 'Turns stop after the first tool call', fixedIn: '2.1.10' }]

function turnSpec(binding: TurnSpec['binding'], attemptId: string, extra: Partial<TurnSpec> = {}): TurnSpec {
  return {
    binding,
    input: {
      runId: `run-${attemptId}`, attemptId, threadId: 'thread', cwd: null, instanceId: binding.instanceId,
      model: binding.model, llmProvider: 'claude-subscription', modelPinned: true, mode: 'agent', prompt: 'hello',
      messages: [], nativeHistory: '', signal: new AbortController().signal
    },
    sink: {
      text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop,
      usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop
    },
    control: { drainSteer: () => undefined, heartbeat: noop },
    host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
    ...extra
  }
}

/** An agent installed by Mousse (a file standing in for its executable) whose version the test sets. */
function setup(version = '2.1.5') {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-known-broken-'))
  dirs.push(dir)
  const binary = join(dir, 'agent.exe')
  writeFileSync(binary, 'agent v1')
  chmodSync(binary, 0o755)
  const install: ManagedInstall = { path: binary, version, receiptHash: 'a'.repeat(64) }
  const started: string[] = []
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities: new PiStubAdapter().capabilities,
    configured: () => true,
    startTurn: vi.fn(async (input): Promise<TurnResult> => {
      started.push(input.attemptId)
      return {
        text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [],
        providerRef: { provider: 'claude-subscription', instanceId: input.instanceId, model: input.model }
      }
    })
  }
  const oneShot = vi.fn(async () => ({ text: 'A title' }))
  const base = adapterDriver(adapter, { runtime: { auth: async () => ({ state: 'signed_in' }), managed: () => ({ ...install }), oneShot } })
  const driver: HarnessDriver = { ...base, oneShot: true, testedVersions: { min: '2.0.0', max: '2.1.999' }, knownBroken: KNOWN_BROKEN }
  let stored: unknown = { claude: { driver: 'claude', enabled: true } }
  const map = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [driver], instances: map, profileHome: dir })
  harnesses.push(harness)
  return {
    harness, started, oneShot, binary, install,
    consent: () => (stored as Record<string, { config?: Record<string, unknown> }>).claude?.config?.knownProblemConsent,
    bind: (input: Partial<BindInput> = {}) =>
      harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' }), { mode: 'agent', ...input })
  }
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code)

describe('a known-broken version at admission', () => {
  it('starts nothing: first turn, retry, recovery, delegated child, workflow step and single request', async () => {
    const fake = setup('2.1.0')
    await fake.harness.instances.recheck('claude')
    // Bound while the version still worked.
    const interactive = await fake.bind()
    const delegated = await fake.bind({ origin: 'delegated' })
    const workflow = await fake.bind({ origin: 'workflow' })
    // The program is now a version with a known problem, at the same path.
    fake.install.version = '2.1.5'
    const snapshot = await fake.harness.instances.recheck('claude')
    expect(snapshot.compatibility).toMatchObject({ state: 'known_broken', knownProblem: { reason: 'Turns stop after the first tool call', fixedIn: '2.1.10' } })
    expect(snapshot.runs).toMatchObject({ state: 'no', failure: 'known_broken' })

    expect(await codeOf(fake.bind())).toBe('known_broken')
    expect(await codeOf(fake.harness.startTurn(turnSpec(interactive, 'retry', { attemptOrdinal: 2 })).result)).toBe('known_broken')
    expect(await codeOf(fake.harness.startTurn(turnSpec(interactive, 'recovery', { previous: interactive })).result)).toBe('known_broken')
    expect(await codeOf(fake.harness.startTurn(turnSpec(delegated, 'child')).result)).toBe('known_broken')
    expect(await codeOf(fake.harness.startTurn(turnSpec(workflow, 'step')).result)).toBe('known_broken')
    const single = fake.harness.oneShot({ selection: { instanceId: 'claude', llmProvider: '', model: 'sonnet' }, purpose: 'title', system: 's', prompt: 'p', maxChars: 50 })
    await expect(single).rejects.toMatchObject({ code: 'known_broken', message: expect.stringContaining('Update it, or allow this version in Settings → Providers.') })
    expect(fake.started).toEqual([])
    expect(fake.oneShot).not.toHaveBeenCalled()
  })

  it('runs once the user allows the version, and the card says it runs anyway', async () => {
    const fake = setup()
    await fake.harness.instances.recheck('claude')
    expect(await codeOf(fake.bind())).toBe('known_broken')
    const snapshot = await fake.harness.instances.allowKnownProblem('claude', '2.1.5')
    expect(snapshot.compatibility.knownProblem).toMatchObject({ allowed: true })
    expect(snapshot.runs.state).toBe('yes')
    expect(fake.consent()).toMatchObject({ version: '2.1.5', binary: { path: fake.binary }, receiptHash: 'a'.repeat(64) })
    const binding = await fake.bind()
    expect(await fake.harness.startTurn(turnSpec(binding, 'a1')).result).toMatchObject({ aborted: false })
    expect(fake.started).toEqual(['a1'])
  })

  it('a changed executable at the same path drops the consent and starts nothing', async () => {
    const fake = setup()
    await fake.harness.instances.recheck('claude')
    await fake.harness.instances.allowKnownProblem('claude', '2.1.5')
    const binding = await fake.bind()
    appendFileSync(fake.binary, ' updated in place')
    // Never on the old reading: refused, and checked again.
    expect(await codeOf(fake.harness.startTurn(turnSpec(binding, 'a1')).result)).toBe('binding_stale')
    await fake.harness.instances.recheck('claude')
    expect(fake.consent()).toBeUndefined()
    expect(await codeOf(fake.bind())).toBe('known_broken')
    expect(fake.started).toEqual([])
  })

  it('another version, or another install receipt, needs the consent again', async () => {
    const fake = setup()
    await fake.harness.instances.recheck('claude')
    await fake.harness.instances.allowKnownProblem('claude', '2.1.5')
    fake.install.receiptHash = 'b'.repeat(64)
    expect(await codeOf(fake.bind())).toBe('known_broken')
    expect(fake.consent()).toBeUndefined()

    await fake.harness.instances.allowKnownProblem('claude', '2.1.5')
    fake.install.version = '2.1.6'
    await fake.harness.instances.recheck('claude')
    expect(await codeOf(fake.bind())).toBe('known_broken')
    expect(fake.consent()).toBeUndefined()
    expect(fake.started).toEqual([])
  })

  it('consent comes only from a check of the gateway itself, for the version it found', async () => {
    const fake = setup()
    await fake.harness.instances.recheck('claude')
    await expect(fake.harness.instances.allowKnownProblem('claude', '2.1.4')).rejects.toMatchObject({ code: 'unsupported' })
    // `configure` never takes it.
    const consent = { version: '2.1.5', binary: { path: fake.binary, size: 8, mtimeMs: 1 } }
    await fake.harness.instances.configure('claude', { knownProblemConsent: consent } as never)
    expect(fake.consent()).toBeUndefined()
    expect(await codeOf(fake.bind())).toBe('known_broken')
    // A tested version has nothing to allow.
    fake.install.version = '2.1.0'
    await expect(fake.harness.instances.allowKnownProblem('claude', '2.1.0')).rejects.toMatchObject({ code: 'unsupported' })
    expect(fake.started).toEqual([])
  })
})
