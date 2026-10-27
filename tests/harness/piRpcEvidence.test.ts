import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTAINMENT_EVIDENCE, PI_RPC_EVIDENCE_ITEMS, type ContainmentEvidence } from '../../src/mms/harness/compatibility'
import type { DriverContext } from '../../src/mms/harness/driver'
import { PI_LEGACY_CAPS, PI_RPC_CAPS, PI_RPC_EXACT_CAPS, piDriver, piRpcCaps, type PiRpcDriverOptions } from '../../src/mms/harness/drivers/pi'
import { piRuntimeVersion } from '../../src/mms/harness/drivers/pi/engines/rpc'
import { checkPolicy } from '../../src/mms/harness/policy'
import { definitionFeatureGaps } from '../../src/mms/agentDefinitions/definitionRuntime'

// PR 4 4d-rpc: Pi RPC is `exact`/`strong`, and runs agent definitions, only on a platform whose
// evidence record for the pinned Pi holds every item. Everywhere else definitions stay on the loop.

const piRoot = resolve(__dirname, '..', '..', 'node_modules/@earendil-works/pi-coding-agent')
const version = piRuntimeVersion(piRoot)!
const record = (overrides: Partial<ContainmentEvidence> = {}): ContainmentEvidence =>
  ({ driver: 'pi', kind: 'tools', cliVersion: version, platform: 'linux', items: PI_RPC_EVIDENCE_ITEMS, recordedAt: '2026-10-27T00:00:00Z', ...overrides })

function driver(platform: NodeJS.Platform, evidence: readonly ContainmentEvidence[]) {
  const rpc = { runtime: () => ({ root: piRoot, entry: join(piRoot, 'dist/bundle/rpc-entry.js'), extension: 'unused.mjs' }), catalog: () => ({ revision: 1, provider: { id: 'x', builtin: false, models: [] } }), platform, evidence } as unknown as PiRpcDriverOptions
  return piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }), rpc })
}

const definitionPolicy = { mode: 'default' as const, origin: 'definition' as const, approvals: 'grants' as const, tools: { allow: ['read'] }, authority: { kind: 'definition' as const, digest: 'd' }, budget: { maxTurns: 3, maxToolCalls: 5 } }

describe('Pi RPC’s evidence gate', () => {
  it('reads the pinned Pi’s version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(piRuntimeVersion(join(piRoot, 'missing'))).toBeUndefined()
  })

  it('is exact only with a full record for this platform and this Pi', () => {
    expect(piRpcCaps({ platform: 'linux', piVersion: version, evidence: [record()] })).toBe(PI_RPC_EXACT_CAPS)
    expect(PI_RPC_EXACT_CAPS).toMatchObject({ toolControl: 'exact', containment: 'strong', budgets: 'hard', spendLimits: 'reserved', definitionLimits: 'none' })
    for (const input of [
      { platform: 'darwin' as const, piVersion: version, evidence: [record()] },
      { platform: 'win32' as const, piVersion: version, evidence: [record()] },
      { platform: 'linux' as const, piVersion: '0.0.1', evidence: [record()] },
      { platform: 'linux' as const, piVersion: undefined, evidence: [record()] },
      { platform: 'linux' as const, piVersion: version, evidence: [record({ items: PI_RPC_EVIDENCE_ITEMS.filter((item) => item !== 10) })] },
      { platform: 'linux' as const, piVersion: version, evidence: [record({ driver: 'claude' })] },
      { platform: 'linux' as const, piVersion: version, evidence: [] }
    ]) expect(piRpcCaps(input), JSON.stringify(input)).toBe(PI_RPC_CAPS)
    expect(PI_RPC_CAPS).toMatchObject({ toolControl: 'approval_only', containment: 'weak' })
  })

  it('the shipped records claim nothing on macOS or Windows', () => {
    for (const platform of ['darwin', 'win32'] as const)
      expect(piRpcCaps({ platform, piVersion: version, evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_CAPS)
  })

  it('with evidence, an RPC instance runs definitions itself; without it, and on the legacy engine, they stay on the loop', () => {
    const rpc = { engine: 'rpc' as const }
    const proven = driver('linux', [record()])
    expect(proven.caps(rpc)).toBe(PI_RPC_EXACT_CAPS)
    expect(proven.definitionCaps!(rpc)).toBe(PI_RPC_EXACT_CAPS)
    expect(proven.definitionCaps!({})).toBe(PI_LEGACY_CAPS)
    expect(checkPolicy(proven.definitionCaps!(rpc), definitionPolicy)).toEqual({ ok: true })

    const unproven = driver('darwin', [record()])
    expect(unproven.caps(rpc)).toBe(PI_RPC_CAPS)
    expect(unproven.definitionCaps!(rpc)).toBe(PI_LEGACY_CAPS)
    // Definitions keep running on the loop there, as before.
    expect(checkPolicy(unproven.definitionCaps!(rpc), definitionPolicy)).toEqual({ ok: true })
    expect(checkPolicy(unproven.caps(rpc), definitionPolicy)).toMatchObject({ ok: false, error: { missing: expect.arrayContaining(['toolControl']) } })
  })

  it('a runtime built where the evidence passed has no loop adapter for definitions; one built elsewhere keeps it', () => {
    const context = (stateDir: string) => ({ instanceId: 'pi:x', stateDir, config: { engine: 'rpc' }, env: { env: {}, home: join(stateDir, 'home') } }) as unknown as DriverContext
    const stateDir = join(tmpdir(), `mousse-pi-evidence-${process.pid}`)
    const proven = driver('linux', [record()]).create(context(stateDir))
    const unproven = driver('darwin', [record()]).create(context(stateDir))
    expect(proven.definitionAdapter).toBeUndefined()
    expect(unproven.definitionAdapter).toBeDefined()
    void proven.stop?.()
    void unproven.stop?.()
  })
})

describe('definition settings Pi RPC must hold', () => {
  const features = { outputFormat: 'markdown' as const, browserMode: 'disabled' as const, memoryScope: 'off' as const, delegation: false }

  it('admits JSON and schema output and thread memory; refuses the browser, persistent memory and delegation', () => {
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, outputFormat: 'schema', memoryScope: 'thread' })).toEqual([])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, outputFormat: 'json' })).toEqual([])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, browserMode: 'structured' }).map((gap) => gap.pointer)).toEqual(['/settings/browser/mode'])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, memoryScope: 'profile_agent' }).map((gap) => gap.pointer)).toEqual(['/settings/memory/scope'])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, delegation: true }).map((gap) => gap.pointer)).toEqual(['/settings/delegation/maxConcurrentChildren'])
  })

  it('the loop holds them all, as it always has', () => {
    expect(definitionFeatureGaps(PI_LEGACY_CAPS, { outputFormat: 'schema', browserMode: 'structured', memoryScope: 'thread', delegation: true })).toEqual([])
  })
})
