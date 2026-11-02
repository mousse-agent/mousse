/**
 * A permanent deletion removes only the bytes the person reviewed. Each entry is read and checked without blocking, and
 * right before it is unlinked it is checked again synchronously: a file that changed after its check read it is refused,
 * and its new bytes stay.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ownedHome } from './support/fixtureGit'

/** Changes a file right after the purge's check of that entry has read it: the check then holds bytes that are gone. */
const change = vi.hoisted(() => ({ path: null as string | null, to: '', done: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = (async (...args: Parameters<typeof real.readFile>) => {
    // Called synchronously from the check, so its name is on the stack here (before any await).
    const fromCheck = /\b(proveFrozenContentEntryAsync|assertFrozenContentEntryAsync)\b/.test(new Error().stack ?? '')
    const value = await real.readFile(...args)
    if (fromCheck && !change.done && change.path && String(args[0]) === change.path) {
      change.done = true
      await real.writeFile(change.path, change.to)
    }
    return value
  }) as typeof real.readFile
  return { ...real, readFile }
})

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  change.path = null; change.done = false
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a file that changes after the purge checked it is not unlinked, and the purge does not report the thread purged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-purge-frozen-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true }); owned.push(ownedHome(home))
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  // A workflow's scratch workspace, its only copy reviewed in the preview.
  const key = 'scratch-call', hash = createHash('sha256').update(key).digest('hex')
  const bindings = join(home, 'workflow-agent-bindings', 'workspaces'), scratch = join(bindings, hash)
  mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'result.txt'), 'sole copy')
  writeFileSync(join(bindings, `${hash}.json`), JSON.stringify({ version: 1, kind: 'scratch', profileId: 'test', threadId: 'task', idempotencyKey: key, worktreePath: scratch, projectCwd: scratch, lifecycle: 'ready' }))
  await coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  // The same length, so only the bytes differ.
  change.path = join(scratch, 'result.txt'); change.to = 'SOLE COPY'
  const purge = coordinator.purge({ taskId: 'task', operationId: 'scratch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest, discard: true, human: true })
  await expect(purge).rejects.toThrow()
  expect(change.done).toBe(true)
  expect(readFileSync(join(scratch, 'result.txt'), 'utf8')).toBe('SOLE COPY')
  expect(store.require('task').state).not.toBe('purged')
  expect(existsSync(scratch)).toBe(true)
})
