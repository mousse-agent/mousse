/**
 * PR 2 §5: `pi:*` instances stay on the legacy loop by default until the parity gate passes; one the
 * user switched (`engine: 'rpc'`, Advanced → Engine: New engine) runs on Pi's agent when the profile
 * gives the driver its RPC inputs. The legacy-only providers (`openai-codex`, `cursor`) and the bare
 * route never do. The engine is part of the record key and the home, so a binding made on the loop
 * before a switch is `binding_stale` after it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { PI_LEGACY_CAPS, PI_RPC_CAPS, piDriver, piEngineFor } from '../../src/mms/harness/drivers/pi'
import type { PiRpcDriverOptions } from '../../src/mms/harness/drivers/pi'
import { findPiRuntime } from '../../src/mms/harness/drivers/pi/profile'
import { piRuntimePaths } from '../../src/mms/harness/pi/launch'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const unused = () => { throw new Error('unused') }
const rpc: PiRpcDriverOptions = { runtime: unused, catalog: unused }
const credentials = {
  has: () => true,
  getConfiguredProviders: () => [],
  getConfiguredLlmProviders: () => []
}

function setup(options: { rpc?: PiRpcDriverOptions; home?: string; stored?: Record<string, unknown> } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'mousse-pi-engine-'))
  if (!options.home) homes.push(home)
  let stored: unknown = options.stored ?? {
    'pi:openrouter': { driver: 'pi', enabled: true },
    'pi:openai-codex': { driver: 'pi', enabled: true },
    'pi:cursor': { driver: 'pi', enabled: true },
    'pi:groq': { driver: 'pi', enabled: true, config: { engine: 'legacy' } },
    'pi:mistral': { driver: 'pi', enabled: true, config: { engine: 'rpc' } },
    'pi:openai': { driver: 'pi', enabled: true, config: { engine: 'rpc' } }
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({
    drivers: [piDriver({ client: () => ({ chat: unused }), credentials: () => credentials as never, ...(options.rpc ? { rpc: options.rpc } : {}) })],
    instances,
    profileHome: home
  })
  harnesses.push(harness)
  const caps = (instanceId: string) => harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }).caps
  return { home, harness, caps }
}

describe('Pi engine routing', () => {
  it('keeps the loop by default and runs a provider the user opted in on Pi’s agent', () => {
    const { caps } = setup({ rpc })
    expect(caps('pi:openrouter')).toBe(PI_LEGACY_CAPS)
    expect(caps('pi:groq')).toBe(PI_LEGACY_CAPS)
    expect(caps('pi:mistral')).toBe(PI_RPC_CAPS)
    expect(caps('pi:openai')).toBe(PI_RPC_CAPS)
    expect(caps('pi:openai-codex')).toBe(PI_LEGACY_CAPS)
    expect(caps('pi:cursor')).toBe(PI_LEGACY_CAPS)
  })

  it('keeps every instance on the loop when the build ships no runtime', () => {
    const { caps } = setup()
    expect(caps('pi:mistral')).toBe(PI_LEGACY_CAPS)
  })

  it('keeps the bare route on the loop', () => {
    const { harness } = setup({ rpc })
    expect(harness.resolveStored({ instanceId: '', llmProvider: '', model: 'm' }, { purpose: 'turn', unselectedDefault: true }).caps).toBe(PI_LEGACY_CAPS)
  })

  it('reports the engine in effect and whether it can be switched', () => {
    const driver = piDriver({ client: unused, rpc })
    expect(driver.engine?.('pi:openrouter', undefined)).toEqual({ effective: 'legacy', switchable: true })
    expect(driver.engine?.('pi:openrouter', { engine: 'rpc' })).toEqual({ effective: 'rpc', switchable: true })
    expect(driver.engine?.('pi:openrouter', { engine: 'legacy' })).toEqual({ effective: 'legacy', switchable: true })
    expect(driver.engine?.('pi:openai-codex', { engine: 'rpc' })).toEqual({ effective: 'legacy', switchable: false })
    expect(driver.engine?.('pi:cursor', undefined)).toEqual({ effective: 'legacy', switchable: false })
    const noRuntime = piDriver({ client: unused })
    expect(noRuntime.engine?.('pi:openrouter', undefined)).toEqual({ effective: 'legacy', switchable: false })
    // A stored `rpc` for a legacy-only provider never runs it on the RPC engine.
    expect(piEngineFor('openai-codex', 'rpc', true)).toBe('legacy')
    expect(driver.caps(driver.decodeConfig({ engine: 'rpc' }, 'pi:openai-codex'))).toBe(PI_LEGACY_CAPS)
  })

  it('refuses a retry of a binding made on the loop before the user switched to Pi’s agent', async () => {
    const before = setup({ stored: { 'pi:openrouter': { driver: 'pi', enabled: true } } })
    const binding = await before.harness.bind(before.harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    expect(binding.caps).toEqual(PI_LEGACY_CAPS)
    expect(binding.homeId).toBe('default')
    // The switch: the same profile, the instance now on the new engine.
    const after = setup({ rpc, home: before.home, stored: { 'pi:openrouter': { driver: 'pi', enabled: true, config: { engine: 'rpc' } } } })
    expect(after.caps('pi:openrouter')).toBe(PI_RPC_CAPS)
    const spec: TurnSpec = {
      binding,
      input: { threadId: 't', instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    }
    await expect(after.harness.startTurn(spec).result).rejects.toMatchObject({ code: 'binding_stale' })
  })

  it('finds the runtime beside the bundle that runs, unpacked from an asar', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-pi-runtime-'))
    homes.push(home)
    const install = (root: string) => {
      const paths = piRuntimePaths(root)
      mkdirSync(join(paths.entry, '..'), { recursive: true })
      writeFileSync(paths.entry, '')
      writeFileSync(paths.extension, '')
      return paths
    }
    const dev = join(home, 'dev')
    expect(findPiRuntime(join(dev, 'out', 'cli', 'mousse.mjs'))).toBeUndefined()
    const paths = install(dev)
    expect(findPiRuntime(join(dev, 'out', 'cli', 'mousse.mjs'))).toEqual(paths)
    // Packaged: the code runs from app.asar, the runtime sits in app.asar.unpacked.
    const asar = join(home, 'resources', 'app.asar')
    const packaged = install(asar)
    expect(packaged.entry).toContain('app.asar.unpacked')
    expect(findPiRuntime(join(asar, 'out', 'main', 'index.js'))).toEqual(packaged)
  })
})
