/**
 * Antigravity's personal Google sign-in runs only turns its owner drives: the gateway's one check at
 * turn admission reads the binding's origin and the run as stored, on every attempt, and refuses
 * everything else before a prompt reaches the provider. Mousse's own background requests never use it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDriver, InstanceConfig } from '../../src/mms/harness/driver'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import type { ExecutionBinding, Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { RunProvenance } from '../../src/mms/harness/ownerOnly'
import type { ProviderAdapter, TurnResult } from '../../src/mms/harness/adapter'
import type { HarnessDriverKind } from '../../src/shared/harness/types'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiStubAdapter } from '../support/piStub'

const dirs: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const noop = () => {}

function turnSpec(binding: ExecutionBinding, runId: string, attemptId: string, extra: Partial<TurnSpec> = {}): TurnSpec {
  return {
    binding,
    input: {
      runId, attemptId, threadId: 'thread', cwd: null, instanceId: binding.instanceId,
      model: binding.model, llmProvider: '', modelPinned: true, mode: 'agent', prompt: 'hello',
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

/** One instance `id` of `driver` with `config`, plus a Claude entry, and the runs the gate reads. */
function setup(driver: HarnessDriverKind, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-owner-only-'))
  dirs.push(dir)
  const started: string[] = []
  const adapterOf = (kind: HarnessDriverKind): ProviderAdapter => ({
    driver: kind,
    capabilities: new PiStubAdapter().capabilities,
    configured: () => true,
    startTurn: vi.fn(async (input): Promise<TurnResult> => {
      started.push(`${input.instanceId}:${input.attemptId}`)
      return {
        text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [],
        providerRef: { provider: '', instanceId: input.instanceId, model: input.model }
      }
    })
  })
  const oneShot = vi.fn(async () => ({ text: 'A title' }))
  const generateImage = vi.fn(async () => ({ mimeType: 'image/png', data: '' }))
  const compactConversation = vi.fn(async () => true)
  const runtime = { auth: async () => ({ state: 'signed_in' as const }), oneShot, generateImage, imageModels: () => [{ id: 'img', name: 'Image' }], compactConversation }
  // The ACP entry keeps its source, as the real ACP driver's config does.
  const decode = (raw: Record<string, unknown> | undefined): InstanceConfig =>
    ({ ...decodeInstanceConfig(raw, { privateHome: false }), ...(raw?.source ? { source: raw.source as InstanceConfig['source'] } : {}) })
  const drivers: HarnessDriver[] = [driver, 'claude'].map((kind) => ({
    ...adapterDriver(adapterOf(kind as HarnessDriverKind), { runtime: runtime as never }), oneShot: true, decodeConfig: decode
  }))
  let stored: unknown = {
    agent: { driver, enabled: true, config },
    claude: { driver: 'claude', enabled: true },
    old: { driver: 'claude', enabled: true, config: { movedTo: 'agent' } }
  }
  const map = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers, instances: map, profileHome: dir })
  harnesses.push(harness)
  const runs = new Map<string, RunProvenance>()
  harness.setRunProvenance((runId) => runs.get(runId))
  const bind = (origin: 'interactive' | null = 'interactive', instanceId = 'agent') =>
    harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent', ...(origin ? { origin } : {}) })
  return { harness, runs, started, oneShot, generateImage, compactConversation, bind }
}

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(() => 'ran', (error: { code?: string; details?: { reason?: string } }) => error.code === 'not_eligible' ? error.details?.reason : error.code)

const OWNER: RunProvenance = { source: 'gui', ownerProof: { via: 'gui' }, clientRequestId: 'm1' }

/** The same binding with another origin (or none, as bindings stored before origins existed). */
const withOrigin = (binding: ExecutionBinding, origin: string | undefined): ExecutionBinding => {
  const { origin: _, ...policy } = binding.policy
  return { ...binding, policy: (origin ? { ...policy, origin } : policy) as ExecutionBinding['policy'] }
}

describe('Antigravity runs only turns its owner drives', () => {
  it('runs a message the owner sent from a window or another of their computers, on every attempt', async () => {
    const fake = setup('antigravity')
    fake.runs.set('gui', OWNER)
    fake.runs.set('bridge', { source: 'gui', ownerProof: { via: 'bridge', node: 'laptop' }, clientRequestId: 'm2' })
    const binding = await fake.bind()
    expect(await reasonOf(fake.harness.startTurn(turnSpec(binding, 'gui', 'a1')).result)).toBe('ran')
    expect(await reasonOf(fake.harness.startTurn(turnSpec(binding, 'gui', 'retry', { attemptOrdinal: 2 })).result)).toBe('ran')
    expect(await reasonOf(fake.harness.startTurn(turnSpec(binding, 'gui', 'recovery', { previous: binding })).result)).toBe('ran')
    expect(await reasonOf(fake.harness.startTurn(turnSpec(binding, 'bridge', 'b1')).result)).toBe('ran')
    expect(fake.started).toEqual(['agent:a1', 'agent:retry', 'agent:recovery', 'agent:b1'])
  })

  it('sends no prompt for any turn the owner did not drive', async () => {
    const fake = setup('antigravity')
    const binding = await fake.bind()
    fake.runs.set('schedule', { source: 'schedule', clientRequestId: 'm' })
    fake.runs.set('cli', { source: 'cli', clientRequestId: 'm' })
    fake.runs.set('forged', { source: 'gui', clientRequestId: 'm' })
    fake.runs.set('agent', { ...OWNER, sentByAgent: true })
    fake.runs.set('labelled', { source: 'schedule', ownerProof: { via: 'gui' }, clientRequestId: 'm' })
    fake.runs.set('gui', OWNER)
    const cases: Array<[ExecutionBinding, string, string]> = [
      [binding, 'schedule', 'owner_only:not_owner'],
      [binding, 'cli', 'owner_only:not_owner'],
      [binding, 'forged', 'owner_only:not_owner'],
      [binding, 'labelled', 'owner_only:not_owner'],
      [binding, 'agent', 'owner_only:agent'],
      [binding, 'unknown', 'owner_only:unknown_run'],
      // The owner's run on a binding made for anything but their chat, or one with no origin at all.
      [withOrigin(binding, 'delegated'), 'gui', 'owner_only:not_interactive'],
      [withOrigin(binding, 'workflow'), 'gui', 'owner_only:not_interactive'],
      [withOrigin(binding, 'bot'), 'gui', 'owner_only:not_interactive'],
      [withOrigin(binding, undefined), 'gui', 'owner_only:not_interactive']
    ]
    for (const [b, runId, reason] of cases)
      expect([runId, await reasonOf(fake.harness.startTurn(turnSpec(b, runId, `x-${runId}`, { attemptOrdinal: 2 })).result)]).toEqual([runId, reason])
    // Without the run store, nothing can be confirmed.
    fake.harness.setRunProvenance(null)
    expect(await reasonOf(fake.harness.startTurn(turnSpec(binding, 'gui', 'no-store')).result)).toBe('owner_only:unknown_run')
    expect(fake.started).toEqual([])
  })

  it('continues a paused turn only when every turn back to the first is the owner’s', async () => {
    const fake = setup('antigravity')
    const binding = await fake.bind()
    const resumed = (continuationOf?: string): RunProvenance => ({ source: 'resume_now', ownerProof: { via: 'gui' }, clientRequestId: null, ...(continuationOf ? { continuationOf } : {}) })
    fake.runs.set('first', OWNER)
    fake.runs.set('again', resumed('first'))
    fake.runs.set('twice', resumed('again'))
    fake.runs.set('scheduled', { source: 'schedule', clientRequestId: 'm' })
    fake.runs.set('of-scheduled', resumed('scheduled'))
    fake.runs.set('no-request', { source: 'gui', ownerProof: { via: 'gui' }, clientRequestId: null })
    fake.runs.set('of-no-request', resumed('no-request'))
    fake.runs.set('of-missing', resumed('gone'))
    fake.runs.set('unanchored', resumed())
    fake.runs.set('auto', { source: 'resume', clientRequestId: null, continuationOf: 'first' })
    fake.runs.set('loop-a', resumed('loop-b'))
    fake.runs.set('loop-b', resumed('loop-a'))
    const outcome = async (runId: string) => reasonOf(fake.harness.startTurn(turnSpec(binding, runId, `c-${runId}`)).result)
    expect(await outcome('again')).toBe('ran')
    expect(await outcome('twice')).toBe('ran')
    expect(await outcome('of-scheduled')).toBe('owner_only:continuation_unproven')
    expect(await outcome('of-no-request')).toBe('owner_only:continuation_unproven')
    expect(await outcome('of-missing')).toBe('owner_only:continuation_unproven')
    expect(await outcome('unanchored')).toBe('owner_only:continuation_unproven')
    expect(await outcome('loop-a')).toBe('owner_only:continuation_unproven')
    // An automatic resume was not pressed by anyone.
    expect(await outcome('auto')).toBe('owner_only:not_owner')
    expect(fake.started).toEqual(['agent:c-again', 'agent:c-twice'])
  })

  it('binds only a person’s chat that chose it, never a selection moved to it', async () => {
    const fake = setup('antigravity')
    expect(await reasonOf(fake.bind(null))).toBe('owner_only:not_interactive')
    const resolved = fake.harness.resolveStored({ instanceId: 'agent', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    for (const origin of ['delegated', 'workflow', 'bot', 'automation'] as const)
      expect(await reasonOf(fake.harness.bind(resolved, { mode: 'agent', origin }))).toBe('owner_only:not_interactive')
    expect(await reasonOf(fake.bind('interactive', 'old'))).toBe('owner_only:moved')
  })

  it('runs none of Mousse’s own requests, and compacts without a model', async () => {
    const fake = setup('antigravity')
    const single = fake.harness.oneShot({ selection: { instanceId: 'agent', llmProvider: '', model: 'm' }, purpose: 'title', system: 's', prompt: 'p', maxChars: 50 })
    await expect(single).rejects.toMatchObject({ code: 'not_eligible', details: { reason: 'owner_only:one_shot' }, message: expect.stringContaining('choose Gemini through Pi or Vertex AI instead') })
    await expect(fake.harness.generateImage!({ instanceId: 'agent', model: 'img', prompt: 'p' })).rejects.toMatchObject({ code: 'not_eligible', details: { reason: 'owner_only:one_shot' } })
    expect(await fake.harness.compactConversation({ threadId: 't', history: '', instanceId: 'agent' })).toBe(false)
    expect(fake.oneShot).not.toHaveBeenCalled()
    expect(fake.generateImage).not.toHaveBeenCalled()
    expect(fake.compactConversation).not.toHaveBeenCalled()
  })

  it('holds a recognised Antigravity ACP entry to the same rule, and no other', async () => {
    const registry = setup('acp', { source: { kind: 'registry', agentId: 'antigravity', version: '1.0.0', distribution: 'binary' } })
    expect(registry.harness.ownerOnly!('agent')).toBe(true)
    expect(await reasonOf(registry.harness.startTurn(turnSpec(await registry.bind(), 'cli', 'r1')).result)).toBe('owner_only:unknown_run')
    const command = setup('acp', { source: { kind: 'local', command: 'C:\\Tools\\agy_acp_server.exe', args: [] } })
    expect(command.harness.ownerOnly!('agent')).toBe(true)
    const other = setup('acp', { source: { kind: 'registry', agentId: 'gemini', version: '1.0.0', distribution: 'npx' } })
    expect(other.harness.ownerOnly!('agent')).toBe(false)
    expect(await reasonOf(other.harness.startTurn(turnSpec(await other.bind(null), 'cli', 'o1')).result)).toBe('ran')
  })

  it('leaves every other provider as it was, with or without a run store', async () => {
    const fake = setup('antigravity')
    fake.harness.setRunProvenance(null)
    expect(fake.harness.ownerOnly!('claude')).toBe(false)
    const binding = await fake.bind(null, 'claude')
    expect(await reasonOf(fake.harness.startTurn(turnSpec(withOrigin(binding, 'delegated'), 'cli', 'c1')).result)).toBe('ran')
    const single = await fake.harness.oneShot({ selection: { instanceId: 'claude', llmProvider: '', model: 'm' }, purpose: 'title', system: 's', prompt: 'p', maxChars: 50 })
    expect(single).toMatchObject({ text: 'A title' })
    expect(await fake.harness.compactConversation({ threadId: 't', history: '', instanceId: 'claude' })).toBe(true)
    expect(fake.started).toEqual(['claude:c1'])
  })
})
