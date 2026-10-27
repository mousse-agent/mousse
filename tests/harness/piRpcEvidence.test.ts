import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTAINMENT_EVIDENCE, PI_RPC_EVIDENCE_ITEMS, PI_RPC_NO_SHELL_ITEMS, type ContainmentEvidence } from '../../src/mms/harness/compatibility'
import { PI_RPC_CAPS, PI_RPC_EXACT_CAPS, PI_RPC_NO_SHELL_CAPS, piDriver, piRpcCaps, piRpcEvidenceLevel, type PiRpcDriverOptions } from '../../src/mms/harness/drivers/pi'
import { piRuntimeVersion } from '../../src/mms/harness/drivers/pi/engines/rpc'
import { checkPolicy } from '../../src/mms/harness/policy'
import { definitionFeatureGaps, definitionRunPolicy } from '../../src/mms/agentDefinitions/definitionRuntime'

// PR 4 4d-rpc: Pi RPC is `exact`/`strong`, and runs agent definitions, on a platform whose evidence
// record for the pinned Pi holds every item; `exact`/`weak` with a no-shell record (every item but the
// contained shell), and it runs definitions there too. Everywhere else definitions are refused.

const piRoot = resolve(__dirname, '..', '..', 'node_modules/@earendil-works/pi-coding-agent')
const version = piRuntimeVersion(piRoot)!
const record = (overrides: Partial<ContainmentEvidence> = {}): ContainmentEvidence =>
  ({ driver: 'pi', kind: 'tools', cliVersion: version, platform: 'linux', items: PI_RPC_EVIDENCE_ITEMS, recordedAt: '2026-10-27T00:00:00Z', ...overrides })

function driver(platform: NodeJS.Platform, evidence: readonly ContainmentEvidence[]) {
  const rpc = { runtime: () => ({ root: piRoot, entry: join(piRoot, 'dist/bundle/rpc-entry.js'), extension: 'unused.mjs' }), catalog: () => ({ revision: 1, provider: { id: 'x', builtin: false, models: [] } }), platform, evidence } as unknown as PiRpcDriverOptions
  return piDriver({ rpc })
}

const definitionPolicy = { mode: 'default' as const, origin: 'definition' as const, approvals: 'grants' as const, tools: { allow: ['read'] }, authority: { kind: 'definition' as const, digest: 'd' }, budget: { maxTurns: 3, maxToolCalls: 5 } }

describe('Pi RPC’s evidence gate', () => {
  it('reads the pinned Pi’s version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(piRuntimeVersion(join(piRoot, 'missing'))).toBeUndefined()
  })

  it('is exact only with a full record for this platform and this Pi', () => {
    expect(piRpcCaps({ platform: 'linux', piVersion: version, evidence: [record()] })).toBe(PI_RPC_EXACT_CAPS)
    expect(PI_RPC_EXACT_CAPS).toMatchObject({ toolControl: 'exact', containment: 'strong', budgets: 'hard', spendLimits: 'reserved' })
    for (const input of [
      { platform: 'darwin' as const, piVersion: version, evidence: [record()] },
      { platform: 'win32' as const, piVersion: version, evidence: [record()] },
      { platform: 'linux' as const, piVersion: '0.0.1', evidence: [record()] },
      { platform: 'linux' as const, piVersion: undefined, evidence: [record()] },
      { platform: 'linux' as const, piVersion: version, evidence: [record({ items: PI_RPC_EVIDENCE_ITEMS.filter((item) => item !== 11) })] },
      { platform: 'linux' as const, piVersion: version, evidence: [record({ items: PI_RPC_NO_SHELL_ITEMS.filter((item) => item !== 1) })] },
      { platform: 'linux' as const, piVersion: version, evidence: [record({ driver: 'claude' })] },
      { platform: 'linux' as const, piVersion: version, evidence: [] }
    ]) expect(piRpcCaps(input), JSON.stringify(input)).toBe(PI_RPC_CAPS)
    expect(PI_RPC_CAPS).toMatchObject({ toolControl: 'approval_only', containment: 'weak' })
  })

  it('a no-shell record (every item but the contained shell) is exact with weak containment, for this platform and this Pi only', () => {
    const noShell = record({ platform: 'win32', items: PI_RPC_NO_SHELL_ITEMS })
    expect(PI_RPC_NO_SHELL_ITEMS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12])
    expect(piRpcEvidenceLevel({ platform: 'win32', piVersion: version, evidence: [noShell] })).toBe('no_shell')
    expect(piRpcCaps({ platform: 'win32', piVersion: version, evidence: [noShell] })).toBe(PI_RPC_NO_SHELL_CAPS)
    expect(PI_RPC_NO_SHELL_CAPS).toEqual({ ...PI_RPC_CAPS, toolControl: 'exact' })
    expect(PI_RPC_NO_SHELL_CAPS.containment).toBe('weak')
    // Not another platform, version or driver; and a full record wins over a no-shell one.
    expect(piRpcCaps({ platform: 'darwin', piVersion: version, evidence: [noShell] })).toBe(PI_RPC_CAPS)
    expect(piRpcCaps({ platform: 'win32', piVersion: '0.86.0', evidence: [noShell] })).toBe(PI_RPC_CAPS)
    expect(piRpcCaps({ platform: 'win32', piVersion: version, evidence: [{ ...noShell, driver: 'claude' }] })).toBe(PI_RPC_CAPS)
    expect(piRpcCaps({ platform: 'win32', piVersion: version, evidence: [noShell, record({ platform: 'win32' })] })).toBe(PI_RPC_EXACT_CAPS)
  })

  it('with a no-shell record, definitions run on Pi RPC and pass admission; bots stay refused', () => {
    const noShell = driver('win32', [record({ platform: 'win32', items: PI_RPC_NO_SHELL_ITEMS })])
    expect(noShell.caps({})).toBe(PI_RPC_NO_SHELL_CAPS)
    // Interactive and unattended definition turns are admitted: shell is decided per call, at the gate.
    expect(checkPolicy(PI_RPC_NO_SHELL_CAPS, definitionPolicy)).toEqual({ ok: true })
    expect(checkPolicy(PI_RPC_NO_SHELL_CAPS, { ...definitionPolicy, origin: 'workflow' })).toEqual({ ok: true })
    // A bot authority is still refused, whatever the caps.
    expect(checkPolicy(PI_RPC_NO_SHELL_CAPS, { ...definitionPolicy, origin: 'bot', authority: { kind: 'bot', digest: 'b' } }, undefined, undefined, { hostApprovals: true })).toMatchObject({ ok: false, error: { missing: expect.arrayContaining(['containment']) } })
  })

  it('a record labelled as made in WSL2 holds for Linux', () => {
    expect(piRpcCaps({ platform: 'linux', piVersion: version, evidence: [record({ environment: 'wsl2' })] })).toBe(PI_RPC_EXACT_CAPS)
    expect(piRpcCaps({ platform: 'darwin', piVersion: version, evidence: [record({ environment: 'wsl2' })] })).toBe(PI_RPC_CAPS)
  })

  it('the shipped records: exact on Linux (from WSL2) and macOS, no-shell on Windows, for this Pi only', () => {
    expect(CONTAINMENT_EVIDENCE.filter((entry) => entry.driver === 'pi').map(({ platform, environment, cliVersion, items }) => ({ platform, environment, cliVersion, items }))).toEqual([
      { platform: 'linux', environment: 'wsl2', cliVersion: version, items: PI_RPC_EVIDENCE_ITEMS },
      { platform: 'win32', environment: undefined, cliVersion: version, items: PI_RPC_NO_SHELL_ITEMS },
      { platform: 'darwin', environment: undefined, cliVersion: version, items: PI_RPC_EVIDENCE_ITEMS }
    ])
    expect(piRpcCaps({ platform: 'linux', piVersion: version, evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_EXACT_CAPS)
    expect(piRpcCaps({ platform: 'win32', piVersion: version, evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_NO_SHELL_CAPS)
    expect(piRpcCaps({ platform: 'darwin', piVersion: version, evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_EXACT_CAPS)
    for (const platform of ['linux', 'win32', 'darwin'] as const)
      expect(piRpcCaps({ platform, piVersion: '0.86.0', evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_CAPS)
  })

  it('the shipped records claim nothing on a platform without a record', () => {
    expect(piRpcCaps({ platform: 'freebsd', piVersion: version, evidence: CONTAINMENT_EVIDENCE })).toBe(PI_RPC_CAPS)
  })

  it('with evidence, an instance runs definitions itself; without it, they are refused', () => {
    const proven = driver('linux', [record()])
    expect(proven.caps({})).toBe(PI_RPC_EXACT_CAPS)
    expect(checkPolicy(proven.caps({}), definitionPolicy)).toEqual({ ok: true })

    const unproven = driver('darwin', [record()])
    expect(unproven.caps({})).toBe(PI_RPC_CAPS)
    expect(checkPolicy(unproven.caps({}), definitionPolicy)).toMatchObject({ ok: false, error: { missing: expect.arrayContaining(['toolControl']) } })
  })
})

describe('definition settings Pi RPC must hold', () => {
  const features = { outputFormat: 'markdown' as const, browserMode: 'disabled' as const, memoryScope: 'off' as const, delegation: false }

  it('holds output formats, any memory, delegation settings and the browser; refuses settings it was not given', () => {
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, outputFormat: 'schema', memoryScope: 'thread' })).toEqual([])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, outputFormat: 'json', memoryScope: 'profile_agent', delegation: true })).toEqual([])
    // The browser is held as Mousse app tools: a runtime that cannot attach Mousse's MCP server cannot hold it.
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, { ...features, browserMode: 'structured' })).toEqual([])
    expect(definitionFeatureGaps(PI_RPC_NO_SHELL_CAPS, { ...features, browserMode: 'structured' })).toEqual([])
    expect(definitionFeatureGaps({ ...PI_RPC_EXACT_CAPS, mcp: false }, { ...features, browserMode: 'structured' }).map((gap) => gap.pointer)).toEqual(['/settings/browser/mode'])
    expect(definitionFeatureGaps({ ...PI_RPC_EXACT_CAPS, mcp: false }, features)).toEqual([])
    expect(definitionFeatureGaps(PI_RPC_EXACT_CAPS, undefined).map((gap) => gap.pointer)).toEqual(['/settings'])
  })

  it('a browser definition runs on Pi RPC under the definition’s authority', () => {
    const policy = definitionRunPolicy({ origin: 'definition', grants: { skills: [], mcpTools: [], builtinTools: [], denied: [] }, budget: { maxTurns: 1, maxToolCalls: 1, maxElapsedMs: 0 } as never, definition: { id: 'd', revision: 'r' }, features: { ...features, browserMode: 'structured' } })
    expect(policy.authority).toMatchObject({ kind: 'definition' })
  })
})
