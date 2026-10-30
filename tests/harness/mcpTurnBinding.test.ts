/**
 * PR 2 §2: every driver whose runtime can attach the Mousse MCP server declares how its calls are
 * tied to a turn (`mcpTurnBinding`), a static fact nothing in policy reads. A driver with `mcp: true`
 * and no declaration fails here; the test drivers use the same bindings as the real ones.
 */
import { describe, expect, it } from 'vitest'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { HARNESS_CAP_KEYS } from '../../src/shared/harness/types'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { adapterDriver } from '../../src/mms/run/testkit/harness'

const unused = (): never => { throw new Error('no runtime in this test') }

const DRIVERS: HarnessDriver[] = [
  claudeCodeDriver({ builtIn: unused }),
  codexDriver({ builtIn: unused }),
  antigravityDriver({ builtIn: unused }),
  acpDriver(),
  // With its RPC inputs, so the engine that attaches the Mousse MCP server is reachable.
  piDriver({ credentials: unused, rpc: { runtime: unused, catalog: unused } })
]

describe('MCP turn binding (PR 2 §2)', () => {
  it.each(DRIVERS.map((driver) => [driver.kind, driver] as const))('%s declares a turn binding when it attaches the Mousse MCP server', (_kind, driver) => {
    const attaches = driver.caps(driver.decodeConfig(undefined)).mcp
    if (attaches) expect(['per_call', 'drained_turn', 'rotate']).toContain(driver.mcpTurnBinding)
    else expect(driver.mcpTurnBinding).toBeUndefined()
  })

  it('keeps the bindings each runtime\'s proof allows', () => {
    const byKind = Object.fromEntries(DRIVERS.map((driver) => [driver.kind, driver.mcpTurnBinding]))
    // Claude stamps every call with the turn token (Mousse's PreToolUse hook), Pi's agent with the
    // attempt token (Mousse's extension); Codex and ACP agents keep their bearer only after a turn
    // proven drained.
    expect(byKind).toEqual({ claude: 'per_call', codex: 'drained_turn', antigravity: 'drained_turn', acp: 'drained_turn', pi: 'per_call' })
  })

  it('is not a capability: no capability key names it', () => {
    expect(HARNESS_CAP_KEYS as readonly string[]).not.toContain('mcpTurnBinding')
  })

  it('test drivers over an adapter use the real driver\'s binding', () => {
    for (const real of DRIVERS) {
      const caps = real.caps(real.decodeConfig(undefined))
      const adapter = { driver: real.kind, capabilities: caps, startTurn: unused, interrupt: unused } as unknown as ProviderAdapter
      expect(adapterDriver(adapter).mcpTurnBinding, real.kind).toBe(real.mcpTurnBinding)
    }
  })

  it('user MCP servers stay native for runtimes that attach them, and are proxied for the pi loop', () => {
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver.kind, driver.userMcp ?? 'native']))).toEqual({
      claude: 'native', codex: 'native', antigravity: 'native', acp: 'native', pi: 'proxy'
    })
  })

  it('every runtime but pi attaches the MCP relay; Codex and Cursor leave its approvals to Mousse, the rest to the runtime', () => {
    const drivers = [...DRIVERS, cursorDriver(), grokDriver()]
    expect(Object.fromEntries(drivers.map((driver) => [driver.kind, driver.relay?.approvals ?? null]))).toEqual({
      claude: 'runtime', codex: 'mousse', cursor: 'mousse', antigravity: 'runtime', acp: 'runtime', grok: 'runtime', pi: null
    })
    for (const real of drivers) {
      const adapter = { driver: real.kind, capabilities: real.caps(real.decodeConfig(undefined)), startTurn: unused, interrupt: unused } as unknown as ProviderAdapter
      expect(adapterDriver(adapter).relay, real.kind).toEqual(real.relay)
    }
  })
})
