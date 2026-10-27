/**
 * PR 4 unit 4h: the Mousse agent engine (the legacy Pi loop) is gone, so every stored `pi:*`
 * connection runs on Pi's agent.
 * - A stored `engine` (`legacy`, the old default, or `rpc`) is ignored on read: the instance runs on
 *   Pi's agent, and its snapshot shows no engine setting.
 * - The first write of the instance's config drops `engine` and keeps everything else, so an older
 *   Mousse reading the file sees only keys it knows.
 * - A connection that was on the legacy engine shows a one-time notice on its first turn; one that was
 *   already on Pi's agent (its notice already recorded) shows none.
 * - Without Pi's runtime in the build, a turn is refused with the reason instead of crashing.
 * - A binding made on the loop froze the loop's caps; they read as the instance's live caps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriverContext } from '../../src/mms/harness/driver'
import { PI_RPC_CAPS, PI_RPC_EXACT_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { loopCaps } from '../../src/mms/harness/gateway'
import { ENGINE_NOTICE_FILE, createRpcRuntime } from '../../src/mms/harness/drivers/pi/engines/rpc'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-pi-engine-migration-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const unused = () => { throw new Error('must not spawn or reach a provider') }
const credentials = () => ({ has: () => true, getConfiguredProviders: () => [], getConfiguredLlmProviders: () => [] }) as never

/** A profile whose instance map holds `stored` for `pi:openrouter`, and records every write. */
function profile(stored: Record<string, unknown>, options: { rpc?: boolean } = {}) {
  const dir = scratch()
  const writes: Array<Record<string, unknown>> = []
  let current = { instances: { 'pi:openrouter': { driver: 'pi', enabled: true, config: { ...stored } } }, seedVersion: 1 }
  const instances = new ProviderInstanceService({
    store: {
      read: () => structuredClone(current),
      write: (next: typeof current) => {
        current = structuredClone(next)
        writes.push(structuredClone(next.instances['pi:openrouter']?.config ?? {}) as Record<string, unknown>)
      }
    } as never
  })
  const harness = testHarness({
    profileHome: dir,
    instances,
    drivers: [piDriver({ credentials, ...(options.rpc === false ? {} : { rpc: { runtime: unused, catalog: unused, evidence: [] } }) })]
  })
  cleanups.push(() => harness.stop())
  return { harness, writes, stored: () => current.instances['pi:openrouter']?.config as Record<string, unknown> }
}

describe('stored Pi engine setting', () => {
  for (const engine of ['legacy', 'rpc', undefined]) {
    it(`reads a connection stored with engine ${engine ?? '(none)'} as one on Pi's agent`, async () => {
      const { harness } = profile({ displayName: 'Router', ...(engine ? { engine } : {}) })
      const resolved = harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm' }, { purpose: 'composer', allowDisabled: true })
      // Pi's agent without an evidence record here: approval-only, never the loop's caps.
      expect(resolved.caps).toEqual(PI_RPC_CAPS)
      expect('definitionLimits' in resolved.caps).toBe(false)
      const snapshot = (await harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'pi:openrouter')!
      expect(snapshot).toBeDefined()
      expect('engine' in snapshot).toBe(false)
    })
  }

  it('drops engine on the next write and keeps the rest for older builds', async () => {
    const { harness, stored } = profile({ displayName: 'Router', engine: 'legacy', laterField: 'kept' })
    await harness.instances.configure('pi:openrouter', { displayName: 'Router 2' })
    expect(stored().engine).toBeUndefined()
    expect(stored()).toMatchObject({ displayName: 'Router 2', laterField: 'kept' })
  })

  it('ignores an engine patch from an older client', async () => {
    const { harness, stored } = profile({ engine: 'rpc' })
    await harness.instances.configure('pi:openrouter', { displayName: 'Router', engine: 'legacy' } as never)
    expect(stored().engine).toBeUndefined()
  })

  it('refuses a turn with the reason when the build has no Pi runtime', async () => {
    const { harness } = profile({ engine: 'legacy' }, { rpc: false })
    const resolved = harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm' }, { purpose: 'composer', allowDisabled: true })
    expect(resolved.caps).toEqual(PI_RPC_CAPS)
    const runtime = piDriver({ credentials }).create({ instanceId: 'pi:openrouter', config: { home: 'default' } } as unknown as DriverContext)
    await expect(runtime.adapter.startTurn({ instanceId: 'pi:openrouter' } as TurnInput, {} as never, {} as never, {} as never))
      .rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('no Pi runtime') })
  })
})

describe('bindings made on the loop', () => {
  it('reads caps frozen on the loop as stale, and current caps as current', () => {
    const frozen = { ...PI_RPC_EXACT_CAPS, historyInjection: 'native', contextUsage: 'measured', budgets: 'observed', spendLimits: 'unsupported', definitionLimits: 'in_loop' }
    expect(loopCaps(frozen as never)).toBe(true)
    expect(loopCaps({ ...PI_RPC_EXACT_CAPS, definitionLimits: 'none' } as never)).toBe(false)
    expect(loopCaps(PI_RPC_EXACT_CAPS)).toBe(false)
    expect(loopCaps(PI_RPC_CAPS)).toBe(false)
  })
})

describe('the one-time notice', () => {
  function runtimeIn(stateDir: string) {
    const context = {
      instanceId: 'pi:openrouter',
      builtIn: true,
      config: { home: 'default' },
      // No home: the engine refuses to start, after the notice decision (nothing is spawned).
      env: { instanceId: 'pi:openrouter', homeId: 'x', env: {} },
      profileHome: stateDir,
      installationHome: stateDir,
      stateDir,
      questions: {} as DriverContext['questions'],
      findBinary: () => undefined,
      changed: () => {}
    } as unknown as DriverContext
    const runtime = createRpcRuntime(context, 'openrouter', 'OpenRouter', () => undefined, { runtime: unused, catalog: unused })
    cleanups.push(() => runtime.stop())
    const notices: string[] = []
    runtime.setLiveHost?.({ notice: (_threadId, text) => notices.push(text) })
    const turn = (threadId: string) => runtime.adapter.startTurn({ threadId, instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput, { providerRef: () => {} } as never, {} as never, {} as never).catch(() => undefined)
    return { notices, turn }
  }

  it('tells a connection that was on the legacy engine once', async () => {
    const stateDir = scratch()
    const { notices, turn } = runtimeIn(stateDir)
    await turn('a')
    await turn('b')
    expect(notices).toEqual(["The Mousse agent engine was removed; OpenRouter now runs on Pi's agent, so its tools and replies may differ slightly."])
  })

  it('says nothing to a connection already on Pi\'s agent', async () => {
    const stateDir = scratch()
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, ENGINE_NOTICE_FILE), JSON.stringify({ engine: 'rpc', shownAt: '2026-10-01T00:00:00.000Z' }))
    const { notices, turn } = runtimeIn(stateDir)
    await turn('a')
    expect(notices).toEqual([])
  })
})
