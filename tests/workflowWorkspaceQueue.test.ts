/**
 * Workflow scripts working in one folder take turns, in the order they called. The queue is found by the folder's real
 * path, read without blocking: a folder whose path is slow to read holds up only its own callers, and a caller that
 * cancels while it waits leaves at once.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSerializedWorkspace } from '../src/mms/workspace/WorkflowWorkspace'

/** `realpath` of a folder named `stalled-folder` waits until released. */
const stall = vi.hoisted(() => ({ releases: [] as Array<() => void> }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = (async (...args: Parameters<typeof real.realpath>) => {
    if (String(args[0]).includes('stalled-folder')) await new Promise<void>((release) => { stall.releases.push(release) })
    return real.realpath(...args)
  }) as typeof real.realpath
  return { ...real, realpath }
})

const roots: string[] = []
afterEach(() => {
  for (const release of stall.releases.splice(0)) release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** `promise`'s outcome, or `'still waiting'` after `ms`. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T | 'still waiting'> {
  return Promise.race([promise, new Promise<'still waiting'>((settle) => setTimeout(() => settle('still waiting'), ms))])
}

it('a folder whose path is slow to read holds up only its own callers, and a caller that cancels leaves at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-queue-')); roots.push(root)
  const slow = join(root, 'stalled-folder'), other = join(root, 'other-folder')
  mkdirSync(slow); mkdirSync(other)
  const controller = new AbortController()
  let ran = false
  const waiting = withSerializedWorkspace(slow, async () => { ran = true; return 'slow' }, controller.signal)
  waiting.catch(() => undefined)
  await vi.waitFor(() => expect(stall.releases.length).toBe(1))
  // Another folder's caller goes ahead while the first folder's path is still being read.
  expect(await within(withSerializedWorkspace(other, async () => 'other'))).toBe('other')
  // Cancelling ends the wait to join, and the work never runs, even once the path is read.
  controller.abort()
  expect(await within(waiting.then(() => 'finished', (error: { code?: string }) => error.code))).toBe('cancelled')
  for (const release of stall.releases.splice(0)) release()
  await new Promise((settle) => setTimeout(settle, 20))
  expect(ran).toBe(false)
  // The folder's queue still works afterwards.
  const next = withSerializedWorkspace(slow, async () => 'after')
  await vi.waitFor(() => expect(stall.releases.length).toBe(1))
  for (const release of stall.releases.splice(0)) release()
  expect(await within(next)).toBe('after')
})
