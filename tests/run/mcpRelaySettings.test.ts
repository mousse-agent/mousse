/**
 * Which runtimes get the MCP relay (SPEC §15.5): on by default for every runtime but pi, off per
 * runtime when the user stores `false`, and off for all when MCP is off.
 */
import { describe, expect, it } from 'vitest'
import { MCP_RELAY_RUNTIMES, relayEnabledFor, type McpRelayRuntime } from '../../src/shared/integrations'
import { PROVIDER_DRIVER_KINDS } from '../../src/shared/providerInstances'
import { getDefaultSettings } from '../../src/shared/settings'

describe('MCP relay settings', () => {
  it('names every driver kind but pi', () => {
    expect([...MCP_RELAY_RUNTIMES].sort()).toEqual(PROVIDER_DRIVER_KINDS.filter((kind) => kind !== 'pi').sort())
  })

  it('defaults to on for every relay runtime', () => {
    const mcp = getDefaultSettings().integrations.mcp
    expect(mcp.relay).toEqual({ runtimes: {} })
    for (const runtime of MCP_RELAY_RUNTIMES) expect(relayEnabledFor(mcp, runtime), runtime).toBe(true)
    expect(relayEnabledFor(mcp, 'pi')).toBe(false)
  })

  it('is on when relay settings are absent (settings saved before the relay)', () => {
    for (const runtime of MCP_RELAY_RUNTIMES) expect(relayEnabledFor({ enabled: true }, runtime), runtime).toBe(true)
  })

  it('turns off only the runtimes stored as false', () => {
    const runtimes: Partial<Record<McpRelayRuntime, boolean>> = { codex: false, cursor: true }
    const settings = { enabled: true, relay: { runtimes } }
    expect(Object.fromEntries(MCP_RELAY_RUNTIMES.map((runtime) => [runtime, relayEnabledFor(settings, runtime)]))).toEqual({
      claude: true, codex: false, cursor: true, acp: true, antigravity: true, grok: true
    })
  })

  it('is off for every runtime when MCP is off', () => {
    for (const runtime of MCP_RELAY_RUNTIMES) expect(relayEnabledFor({ enabled: false, relay: { runtimes: { [runtime]: true } } }, runtime), runtime).toBe(false)
  })
})
