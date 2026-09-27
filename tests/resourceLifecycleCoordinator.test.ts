import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator, type ResourceLifecycleHooks } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import { buildResourceInventory } from '../src/mms/lifecycle/ResourceInventory'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture(hooks: Partial<ResourceLifecycleHooks> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'resource-coordinator-')); homes.push(home)
  const location = join(home, 'thread-data', 'standalone', 'task')
  const store = new ResourceLifecycleStore({ profileId: 'p', profileHome: home })
  registerThreadLifecycleGate(home, store)
  store.registerTask({ taskId: 'task', location, creating: true })
  mkdirSync(location, { recursive: true })
  atomicWriteJsonSync(join(location, 'meta.json'), { id: 'task' })
  atomicWriteJsonSync(join(location, 'messages.json'), [{ content: 'preserve conversation' }])
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, ...hooks })
  return { home, location, store, coordinator }
}

describe('reversible lifecycle moves and recovery', () => {
  it('preserves data, makes exact requests idempotent, rejects stale requests and blocks purge', async () => {
    const { location, store, coordinator } = fixture()
    const bytes = readFileSync(join(location, 'messages.json'))
    const admission = store.captureAdmission('task')
    const trashed = await coordinator.trash({ taskId: 'task', operationId: 'delete', expectedGeneration: 1 })
    expect(trashed.state).toBe('trashed'); expect(trashed.generation).toBe(2)
    expect(readFileSync(join(trashed.location, 'messages.json'))).toEqual(bytes)
    expect((await coordinator.trash({ taskId: 'task', operationId: 'delete', expectedGeneration: 1 })).generation).toBe(2)
    await expect(coordinator.restore({ taskId: 'task', operationId: 'delete' })).rejects.toThrow('different input')
    await expect(coordinator.restore({ taskId: 'task', operationId: 'restore', expectedGeneration: 1 })).rejects.toThrow('generation')
    expect(() => coordinator.purge('task')).toThrow('unavailable')
    const restored = await coordinator.restore({ taskId: 'task', operationId: 'restore', expectedGeneration: 2 })
    expect(restored.location).toBe(location); expect(restored.state).toBe('active'); expect(restored.generation).toBe(3)
    expect(readFileSync(join(location, 'messages.json'))).toEqual(bytes)
    expect(() => store.assertAdmission(admission)).toThrow('generation')
    const originalResult = coordinator.getOperationResult('task', 'delete')
    const recordBytes = readFileSync(store.recordPath('task'))
    expect((await coordinator.trash({ taskId: 'task', operationId: 'delete', expectedGeneration: 1 })).state).toBe('active')
    expect(coordinator.getOperationResult('task', 'delete')).toEqual(originalResult)
    expect(originalResult).toMatchObject({ kind: 'trash', state: 'trashed', generation: 2 })
    expect(readFileSync(store.recordPath('task'))).toEqual(recordBytes)
  })

  it('rejects busy preflight without fencing existing writers or changing generation', async () => {
    const { location, store, coordinator } = fixture({ assertCanTrash: () => { throw new Error('active execution') } })
    const admission = store.captureAdmission('task')
    await expect(coordinator.trash({ taskId: 'task', operationId: 'busy' })).rejects.toThrow('active execution')
    store.withAdmission(admission, 'write', () => atomicWriteJsonSync(join(location, 'completion.json'), { persisted: true }))
    expect(store.require('task').generation).toBe(1)
    expect(store.require('task').operations).toEqual([])
  })

  it('does not carry unsettled lock files or clear queued input on a failed move', async () => {
    const { location, store, coordinator } = fixture()
    atomicWriteJsonSync(join(location, 'queue.json'), [{ id: 'queued-user-input' }])
    writeFileSync(join(location, 'execution.lease'), 'unsettled')
    await expect(coordinator.trash({ taskId: 'task', operationId: 'move' })).rejects.toThrow('not settled')
    expect(existsSync(location)).toBe(true)
    expect(JSON.parse(readFileSync(join(location, 'queue.json'), 'utf8'))).toEqual([{ id: 'queued-user-input' }])
    expect(store.require('task').operations.at(-1)?.phase).toBe('drained')
    rmSync(join(location, 'execution.lease'))
    expect((await coordinator.recover('task')).state).toBe('trashed')
  })

  it('recovers a rename completed before mapping publication without recreating the old path', async () => {
    const { location, store, coordinator } = fixture({ onPhase: (_record, phase) => { if (phase === 'move-prepared') throw new Error('simulated exit') } })
    await expect(coordinator.trash({ taskId: 'task', operationId: 'move' })).rejects.toThrow('simulated exit')
    const intent = store.require('task').operations.at(-1)!
    mkdirSync(join(store.profileHome, 'trash', 'threads'), { recursive: true })
    renameSync(intent.from, intent.to)
    const restarted = new ResourceLifecycleStore({ profileId: 'p', profileHome: store.profileHome })
    let settled = false, projected = false
    const recovery = new ResourceLifecycleCoordinator(restarted, { drain: async () => {}, settleMutationOwnership: async () => { settled = true }, projectIndex: () => { projected = true } })
    expect((await recovery.recover('task')).state).toBe('trashed')
    expect(settled).toBe(false); expect(projected).toBe(true); expect(existsSync(location)).toBe(false)
  })

  it('holds the fence across failed index projection and restores idle using only the internal write permit', async () => {
    const { location, store, coordinator } = fixture()
    await coordinator.trash({ taskId: 'task', operationId: 'trash' })
    let attempts = 0
    const restore = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: (record) => {
      atomicWriteJsonSync(join(record.location, 'queue.json'), [])
      expect(() => store.withPathAdmission(record.location, 'execution', () => undefined)).toThrow('fenced')
      if (++attempts === 1) throw new Error('index interrupted')
    } })
    await expect(restore.restore({ taskId: 'task', operationId: 'restore' })).rejects.toThrow('index interrupted')
    expect(store.require('task').state).toBe('restore-moving')
    expect(() => atomicWriteJsonSync(join(location, 'late.json'), {})).toThrow('fenced')
    expect((await restore.recover('task')).state).toBe('active')
    expect(JSON.parse(readFileSync(join(location, 'queue.json'), 'utf8'))).toEqual([])
  })

  it('rejects concurrent lifecycle operations during drain without holding the stable gate', async () => {
    let release!: () => void
    const draining = new Promise<void>((resolve) => { release = resolve })
    const { store, coordinator } = fixture({ drain: () => draining })
    const pending = coordinator.trash({ taskId: 'task', operationId: 'first' })
    expect(store.withGate('task', () => true)).toBe(true)
    const other = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {} })
    await expect(other.trash({ taskId: 'task', operationId: 'first' })).rejects.toThrow('running')
    await expect(other.restore({ taskId: 'task', operationId: 'second' })).rejects.toThrow('Cannot restore')
    release(); expect((await pending).state).toBe('trashed')
  })

  it('blocks ambiguous source ownership and inventory cache never overrides repaired sources', async () => {
    const { location, store, coordinator } = fixture()
    writeFileSync(join(location, 'workspace.json'), '{broken')
    const inventory = buildResourceInventory(store, store.require('task'))
    expect(inventory.blockers.length).toBeGreaterThan(0)
    await expect(coordinator.trash({ taskId: 'task', operationId: 'bad' })).rejects.toThrow('ownership')
    expect(store.require('task').state).toBe('active')
    rmSync(join(location, 'workspace.json'))
    expect((await coordinator.trash({ taskId: 'task', operationId: 'fixed' })).state).toBe('trashed')
    expect(store.require('task').operations[0]?.phase).toBe('rejected')
  })
})
