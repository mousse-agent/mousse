/**
 * PR 5a-1: a tombstone survives an older Mousse. Profile A removes OpenRouter, profile B saves the
 * shared key again, and an older build (which knows no tombstones) re-seeds `pi:openrouter` into
 * A's stored map. This build still treats it as removed everywhere, leaves that entry on disk as
 * it is, runs nothing on it, and an explicit Add brings it back in one write.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { PI_LEGACY_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { configInstanceStore, ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './fixtures/piInstallationCredentials'
import olderBuildWrite from './fixtures/preTombstoneProvidersWrite.json'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

const device = { kind: 'device' } as const

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-tombstone-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** This build starting on a profile home: its config store, instance map and gateway, as `MmsProfileServices` wires them. */
function start(home: string, credentials: PiInstallationCredentials) {
  const config = MousseConfigStore.load(home)
  const store = configInstanceStore(config)
  let writes = 0
  const instances = new ProviderInstanceService({ store: { read: store.read, write: (state) => { writes += 1; store.write(state) } }, providerAuth: credentials })
  const harness = testHarness({
    profileHome: home,
    instances,
    drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('no model call in this test') } }) as never, credentials: () => credentials as never })]
  })
  cleanups.push(() => harness.stop())
  return { config, instances, harness, writes: () => writes }
}

const confOf = (home: string) => readFileSync(join(home, 'mousse.conf'), 'utf8')
const providersOf = (home: string) => (JSON.parse(confOf(home)) as { providers: { instances?: Record<string, unknown>; removedInstances?: string[] } }).providers

describe('a tombstone across a downgrade', () => {
  it('stays authoritative over an older build\'s re-seed until Add, which clears it in one write', async () => {
    const credentials = new PiInstallationCredentials()
    const homeA = scratch()
    const homeB = scratch()

    // Profile A adds OpenRouter with a key, then removes it: tombstone written, key deleted.
    const a = start(homeA, credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await a.harness.instances.setSecret('pi:openrouter', 'fixture-key-a')
    await a.harness.instances.remove('pi:openrouter')
    expect(providersOf(homeA).removedInstances).toEqual(['pi:openrouter'])
    expect(credentials.has('openrouter')).toBe(false)

    // Profile B saves the shared key again.
    const b = start(homeB, credentials)
    await b.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await b.harness.instances.setSecret('pi:openrouter', 'fixture-key-b')

    // An older build runs on A and writes its seed the way it always did. Simulated: the fixture is
    // the instance entry a pre-5a-1 build seeds, written through `updateProvidersSection`'s shallow
    // merge, which this PR does not change.
    const older = MousseConfigStore.load(homeA)
    const section = older.getProvidersSection()
    older.updateProvidersSection({
      instances: { ...(section.instances ?? {}), ...olderBuildWrite.instances },
      instancesSeedVersion: olderBuildWrite.instancesSeedVersion
    })
    expect(providersOf(homeA)).toMatchObject({ instances: { 'pi:openrouter': { driver: 'pi', enabled: true } }, removedInstances: ['pi:openrouter'] })
    const onDisk = confOf(homeA)

    // This build starts on A again.
    const next = start(homeA, credentials)
    const startTurn = vi.spyOn(PiLoopAdapter.prototype, 'startTurn')
    // (The agents are seeded on a profile's first start; no driver serves them in this test.)
    expect(Object.keys(next.instances.list())).toEqual(['antigravity', 'claude', 'codex'])
    expect(next.instances.get('pi:openrouter')).toBeUndefined()
    expect((await next.harness.instances.snapshots(device)).map((snapshot) => snapshot.instanceId)).toEqual([])
    expect((await next.harness.llmProviders(device)).map((option) => option.instanceId)).toEqual([])
    expect(next.instances.configuredProviders().map((provider) => provider.instanceId)).toEqual([])
    expect(next.harness.catalog.addOptions().find((option) => option.id === 'openrouter')).toMatchObject({ added: false, hasSavedKey: true })
    // A thread pinned to it runs nothing.
    await expect(next.harness.bind({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', driver: 'pi', model: 'openrouter-model', caps: PI_LEGACY_CAPS }, { mode: 'default' }))
      .rejects.toMatchObject({ code: 'instance_unknown' })
    expect(() => next.harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: 'openrouter', model: 'openrouter-model' }, { purpose: 'turn' })).toThrow()
    expect(startTurn).not.toHaveBeenCalled()
    // Reading wrote nothing: the older build's entry is still on disk byte-for-byte.
    expect(next.writes()).toBe(0)
    expect(confOf(homeA)).toBe(onDisk)

    // Add brings it back: present, tombstone gone, one store write.
    const added = await next.harness.instances.addInstance({ driver: 'pi', config: { provider: 'openrouter' } })
    expect(added.existed).toBe(false)
    expect(next.writes()).toBe(1)
    expect(providersOf(homeA).removedInstances).toBeUndefined()
    expect(providersOf(homeA).instances?.['pi:openrouter']).toEqual({ driver: 'pi', enabled: true })
    expect((await next.harness.llmProviders(device)).map((option) => option.instanceId)).toEqual(['pi:openrouter'])
  })
})
