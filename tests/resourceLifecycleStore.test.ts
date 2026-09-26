import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertLifecyclePath, ResourceLifecycleStore, validateResourceInventory } from '../src/mms/lifecycle/ResourceLifecycleStore'
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

  it('checks every path component without repeated canonical filesystem walks', () => {
    const { home } = fixture()
    const root = join(home, 'thread-data'), target = join(root, 'real')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const canonicalize = vi.spyOn(realpathSync, 'native')
    try {
      expect(() => assertLifecyclePath(root, join(target, 'missing', 'data.json'))).not.toThrow()
      expect(() => assertLifecyclePath(root, join(root, 'alias', 'missing', 'data.json'))).toThrow('link')
      expect(() => assertLifecyclePath(root, join(root, '..', 'escaped'))).toThrow('escapes')
      expect(() => assertLifecyclePath(root, `${root}-sibling`)).toThrow('escapes')
      if (process.platform === 'win32') expect(() => assertLifecyclePath(root.toUpperCase(), target)).not.toThrow()
      expect(canonicalize).not.toHaveBeenCalled()
    } finally { canonicalize.mockRestore() }
  })

  it('retains resolved lifecycle identity without canonicalizing validated location comparisons', () => {
    const { store, make } = fixture()
    const location = make('identity')
    const admission = store.captureAdmission('identity', join(location, 'child', '..'))
    const canonicalize = vi.spyOn(realpathSync, 'native')
    try {
      store.assertAdmission(admission)
      expect(store.findByLocation(join(location, 'nested', 'data.json'))?.taskId).toBe('identity')
      if (process.platform === 'win32') expect(store.captureAdmission('identity', location.toUpperCase()).taskId).toBe('identity')
      expect(() => store.captureAdmission('identity', `${location}-sibling`)).toThrow('location changed')
      expect(canonicalize).not.toHaveBeenCalled()
    } finally { canonicalize.mockRestore() }
  })

  it('rejects unknown retention claims and claims without source records', () => {
    const inventory: ResourceInventorySnapshot = { schemaVersion: 1, profileId: 'p', taskId: 't', generation: 1, observedAt: '', blockers: [], sources: [{ id: 's', path: '/source', digest: 'digest', status: 'verified' }], resources: [{ id: 'r', kind: 'git-ref', identity: 'refs/mousse/test', ownerTaskId: 't', materialization: 'unknown', sourceIds: ['s'], claims: [{ schemaVersion: 1, kind: 'undo', sourceId: 's', ownerTaskId: 't', condition: 'retained action' }] }] }
    expect(() => validateResourceInventory(inventory)).not.toThrow()
    ;(inventory.resources[0]!.claims[0] as { kind: string }).kind = 'future-pin'
    expect(() => validateResourceInventory(inventory)).toThrow('Unknown retention')
    inventory.resources[0]!.claims[0]!.kind = 'undo'; inventory.sources = []
    expect(() => validateResourceInventory(inventory)).toThrow('source')
  })

  it('adopts uniquely owned legacy trash without reviving or moving its data', async () => {
    const { home, store } = fixture()
    const originalLocation = join(home, 'thread-data', 'standalone', 'legacy')
    const location = join(home, 'trash', 'threads', 'legacy-old')
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'legacy' }))
    writeFileSync(join(home, 'trash', 'threads', 'index.json'), JSON.stringify([{ threadId: 'legacy', originalPath: originalLocation, trashPath: location, tombstonedAt: '2026-01-01T00:00:00Z' }]))
    expect(store.adoptTrashedTask({ taskId: 'legacy', originalLocation, location }).state).toBe('trashed')
    expect(() => store.registerTask({ taskId: 'legacy', location: originalLocation, creating: true })).toThrow('tombstone')
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {} })
    expect((await coordinator.restore({ taskId: 'legacy', operationId: 'restore' })).state).toBe('active')
    expect(existsSync(location)).toBe(false); expect(existsSync(join(originalLocation, 'meta.json'))).toBe(true)
  })

  it('routes hot-path writes without enumerating a thousand retained task records', () => {
    const { home, store, make } = fixture()
    const location = make('active')
    const template = store.require('active')
    // Extra retained records model a large profile. They must not be parsed for this task's writes.
    for (let i = 0; i < 1000; i++) writeFileSync(store.recordPath(`retained-${i}`), JSON.stringify({ ...template, taskId: `retained-${i}`, location: join(home, 'thread-data', 'standalone', `retained-${i}`) }))
    const enumerate = vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('all-task scan on write path') })
    for (let i = 0; i < 10; i++) store.withPathAdmission(join(location, 'nested', 'data.json'), 'write', () => undefined)
    expect(enumerate).not.toHaveBeenCalled()
    enumerate.mockRestore()
  })

  it('rejects altered immutable completion receipts and unowned operation paths', async () => {
    const { store, make } = fixture(); make('task')
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {} })
    await coordinator.trash({ taskId: 'task', operationId: 'trash' })
    const path = store.recordPath('task'), saved = readFileSync(path, 'utf8')
    const changed = JSON.parse(saved)
    changed.operations[0].result.generation += 100
    writeFileSync(path, JSON.stringify(changed))
    expect(() => store.get('task')).toThrow('result receipt')
    const altered = JSON.parse(saved)
    altered.operations[0].to = join(store.profileHome, 'trash', 'threads', 'unowned')
    writeFileSync(path, JSON.stringify(altered))
    expect(() => store.get('task')).toThrow('not owned')
  })
})
