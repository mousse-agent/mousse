import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceLifecycleStore, validateResourceInventory } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import type { ResourceInventorySnapshot } from '../src/shared/resourceLifecycle'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'resource-store-')); homes.push(home)
  const store = new ResourceLifecycleStore({ profileId: 'profile-a', profileHome: home })
  registerThreadLifecycleGate(home, store)
  const make = (taskId: string, parentTaskId?: string) => {
    const location = join(home, 'thread-data', 'standalone', taskId)
    store.registerTask({ taskId, location, parentTaskId, creating: true })
    store.withPathAdmission(location, 'write', () => { mkdirSync(location, { recursive: true }); atomicWriteJsonSync(join(location, 'meta.json'), { id: taskId }) })
    return location
  }
  return { home, store, make }
}

describe('stable task lifecycle storage and admission', () => {
  it('requires explicit registration before directory birth and supports nested atomic writes', () => {
    const { home, store, make } = fixture()
    const path = join(home, 'thread-data', 'standalone', 'unregistered')
    expect(() => atomicWriteJsonSync(join(path, 'meta.json'), { id: 'unregistered' })).toThrow('registered')
    expect(existsSync(path)).toBe(false)
    const location = make('task')
    const admission = store.captureAdmission('task', location)
    store.withAdmission(admission, 'write', () => atomicWriteJsonSync(join(location, 'nested', 'context.json'), { kept: true }))
    expect(JSON.parse(readFileSync(join(location, 'nested', 'context.json'), 'utf8'))).toEqual({ kept: true })
  })

  it('rejects descendant stale paths and queued child admissions across parent trash and restore', async () => {
    const { store, make } = fixture()
    const parent = make('parent'), child = make('child', 'parent')
    const oldChild = store.captureAdmission('child', child)
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {} })
    await coordinator.trash({ taskId: 'parent', operationId: 'trash' })
    expect(() => atomicWriteJsonSync(join(parent, 'context.json'), {})).toThrow()
    expect(existsSync(parent)).toBe(false)
    expect(() => store.withPathAdmission(child, 'execution', () => undefined)).toThrow('fenced')
    await coordinator.restore({ taskId: 'parent', operationId: 'restore' })
    expect(() => store.assertAdmission(oldChild)).toThrow('Parent task lifecycle generation changed')
    expect(() => store.assertAdmission(store.captureAdmission('child', child))).not.toThrow()
    expect(() => store.registerTask({ taskId: 'parent', location: join(parent, 'different'), creating: true })).toThrow()
  })

  it('fails closed for future/corrupt authority, missing authority manifest and ownership cycles', () => {
    const { home, store, make } = fixture()
    make('a'); make('b', 'a')
    const path = store.recordPath('a')
    const saved = readFileSync(path, 'utf8')
    writeFileSync(path, saved.replace('"schemaVersion": 1', '"schemaVersion": 999'))
    expect(() => store.captureAdmission('a')).toThrow('schema')
    writeFileSync(path, '{')
    expect(() => store.withPathAdmission(join(home, 'thread-data', 'standalone', 'a'), 'write', () => undefined)).toThrow('unreadable')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(saved), parentTaskId: 'b' }))
    expect(() => store.captureAdmission('b')).toThrow('cycle')
    writeFileSync(path, saved)
    rmSync(join(store.root, 'manifest.json'))
    expect(() => new ResourceLifecycleStore({ profileId: 'profile-a', profileHome: home })).toThrow('manifest missing')
  })

  it('rejects linked storage paths even when the link stays inside the owned root', () => {
    const { home, store } = fixture()
    const root = join(home, 'thread-data'); mkdirSync(join(root, 'real'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => store.registerTask({ taskId: 'task', location: join(root, 'alias', 'task'), creating: true })).toThrow('link')
  })

  it('rejects unknown retention claims and claims without source records', () => {
    const inventory: ResourceInventorySnapshot = { schemaVersion: 1, profileId: 'p', taskId: 't', generation: 1, observedAt: '', blockers: [], sources: [{ id: 's', path: '/source', digest: 'digest', status: 'verified' }], resources: [{ id: 'r', kind: 'git-ref', identity: 'refs/mousse/test', ownerTaskId: 't', materialization: 'unknown', sourceIds: ['s'], claims: [{ schemaVersion: 1, kind: 'undo', sourceId: 's', ownerTaskId: 't', condition: 'retained action' }] }] }
    expect(() => validateResourceInventory(inventory)).not.toThrow()
    ;(inventory.resources[0]!.claims[0] as { kind: string }).kind = 'future-pin'
    expect(() => validateResourceInventory(inventory)).toThrow('Unknown retention')
    inventory.resources[0]!.claims[0]!.kind = 'undo'; inventory.sources = []
    expect(() => validateResourceInventory(inventory)).toThrow('source')
  })
})
