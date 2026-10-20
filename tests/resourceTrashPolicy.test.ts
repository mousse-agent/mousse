import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(count = 1, options: { soleCopy?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-trash-policy-')); roots.push(home)
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home })
  registerThreadLifecycleGate(home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  for (let index = 0; index < count; index++) {
    const taskId = `task-${index}`, location = join(home, 'thread-data', taskId)
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: taskId })); writeFileSync(join(location, 'messages.json'), '[]')
    if (options.soleCopy) {
      mkdirSync(join(location, 'terminal-workspace'), { recursive: true }); writeFileSync(join(location, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
      writeFileSync(join(location, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: taskId, workspaceRelativePath: 'terminal-workspace' }))
    }
    store.registerTask({ taskId, location }); await coordinator.trash({ taskId, operationId: `trash-${index}` })
    store.update(taskId, (record) => { record.trashedAt = new Date(Date.now() - 40 * 86_400_000).toISOString() })
  }
  return { store, coordinator, cleanup: coordinator.cleanup }
}

test('trash policy is opt in, preserves immutable grace date, and rotates past blocked batches', async () => {
  const f = await fixture(7)
  await f.cleanup.sweep(); expect(f.store.list().every((record) => record.state === 'trashed')).toBe(true)
  const firstTrash = f.store.require('task-0').trashedAt
  f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
  const original = f.cleanup.preview.bind(f.cleanup), visited: string[] = []
  vi.spyOn(f.cleanup, 'preview').mockImplementation(async (taskId) => {
    visited.push(taskId)
    const preview = await original(taskId)
    if (taskId < 'task-5') preview.blockers.push('Retained by an unresolved external handle')
    return preview
  })
  await f.cleanup.sweep()
  expect(visited).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4'])
  expect(f.store.require('task-0').trashedAt).toBe(firstTrash)
  expect(f.store.require('task-0').blockedReason).toBe('Retained by an unresolved external handle')
  await f.cleanup.sweep()
  expect(f.store.require('task-5').state).toBe('purged'); expect(f.store.require('task-6').state).toBe('purged')
  expect(existsSync(f.store.require('task-0').location)).toBe(true)
})

test('clock discontinuities suspend automatic trash deletion until a human acknowledges policy', async () => {
  const f = await fixture()
  f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
  await f.cleanup.sweep(Date.now() + 2 * 86_400_000)
  expect(f.cleanup.sweepStatus().suspended).toBe(true); expect(f.store.require('task-0').state).toBe('trashed')
  await f.cleanup.sweep(); expect(f.store.require('task-0').state).toBe('trashed')
  expect(() => f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, false)).toThrow(/human/)
  f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
  await f.cleanup.sweep()
  expect(f.store.require('task-0').state).toBe('purged')
})

test('automatic sweep never discards sole-copy content and records why the task stays in trash', async () => {
  const f = await fixture(1, { soleCopy: true })
  f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
  await f.cleanup.sweep()
  const record = f.store.require('task-0')
  expect(record.state).toBe('trashed')
  expect(record.blockedReason).toMatch(/sole-copy content; review permanent deletion/)
  expect(readFileSync(join(record.location, 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
})

test('automatic sweep records a failing purge as the blocked reason and leaves the task recoverable', async () => {
  const f = await fixture()
  f.cleanup.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
  vi.spyOn(f.cleanup, 'purge').mockRejectedValue(new Error('Repository is unavailable'))
  await f.cleanup.sweep()
  expect(f.store.require('task-0')).toMatchObject({ state: 'trashed', blockedReason: 'Repository is unavailable' })
})

test.each([
  [{ schemaVersion: 1, graceDays: 0, automaticPurge: true }],
  [{ schemaVersion: 1, graceDays: 3651, automaticPurge: true }],
  [{ schemaVersion: 1, graceDays: 1.5, automaticPurge: true }],
  [{ schemaVersion: 1, graceDays: 30, automaticPurge: 'yes' }],
  [{ schemaVersion: 2, graceDays: 30, automaticPurge: true }]
])('configure refuses the invalid policy %j and keeps the saved one', async (invalid) => {
  const f = await fixture()
  const saved = f.cleanup.configure({ schemaVersion: 1, graceDays: 7, automaticPurge: false }, true)
  expect(() => f.cleanup.configure(invalid as never, true)).toThrow(expect.objectContaining({ code: 'resource_policy_invalid' }) as never)
  expect(f.cleanup.policy()).toEqual(saved)
})
