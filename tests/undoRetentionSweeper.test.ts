/**
 * The undo-retention sweeper runs Git synchronously in each thread's folder. It must never hold the daemon
 * while it starts, and it skips a thread whose folder is on a volume that is not answering (one macOS is
 * still asking about), instead of blocking the daemon on that volume's Git calls.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../src/mms/actions/ReceiptRefReleaseService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { folderAccess } from '../src/mms/files/folderAccess'
import type { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { gitFoundationFixture } from './fixtures/gitFoundation'

const STUCK = '/Volumes/stuck'

let f: ReturnType<typeof gitFoundationFixture>
let sweep: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  f = gitFoundationFixture()
  // A volume at STUCK never answers; every other folder answers at once.
  folderAccess.reset({
    probe: (path) => path.startsWith(STUCK) ? new Promise<void>(() => undefined) : Promise.resolve(),
    lstat: async () => ({ isSymbolicLink: () => false }),
    commonDir: async () => null,
    keyOf: (path) => path.startsWith(STUCK) ? STUCK : '/',
    stuckAfterMs: 20,
    platform: 'darwin'
  })
  sweep = vi.spyOn(UndoRetentionService.prototype, 'sweep').mockResolvedValue({ expired: [] } as never)
  vi.spyOn(ReceiptRefReleaseService.prototype, 'release').mockResolvedValue({ releasedRefs: [], retained: [] } as never)
})
afterEach(() => { vi.restoreAllMocks(); folderAccess.reset(); f.dispose() })

/** A sweeper over one active thread whose worktree is at `worktreePath`. */
function sweeper(worktreePath: string, options = { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20, firstPassAfterMs: 0 }) {
  vi.spyOn(ThreadWorkspaceManager.prototype, 'loadOrSnapshot').mockReturnValue({ lifecycle: 'ready', worktreePath } as never)
  const store = { list: () => [{ taskId: 'thread-1', state: 'active', location: f.thread }] } as unknown as ResourceLifecycleStore
  return new UndoRetentionSweeper(store, options)
}

it('skips a thread whose folder is on a volume that is not answering, and sweeps it once it answers', async () => {
  const stuck = sweeper(`${STUCK}/worktrees/thread-1`)
  await stuck.tick()
  expect(sweep).not.toHaveBeenCalled()
  expect(stuck.outcomes.get('thread-1')?.reason).toMatch(/not answering/)

  const answering = sweeper(f.repo)
  await answering.tick()
  expect(sweep).toHaveBeenCalledTimes(1)
  expect(sweep.mock.calls[0]![0]).toBe(f.repo)
})

it('does not sweep while the daemon starts: the first pass waits', async () => {
  const later = sweeper(f.repo, { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20, firstPassAfterMs: 60_000 })
  later.start()
  await new Promise((settle) => setTimeout(settle, 50))
  expect(sweep).not.toHaveBeenCalled()
  await later.stop()

  const soon = sweeper(f.repo, { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20, firstPassAfterMs: 0 })
  soon.start()
  await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1))
  await soon.stop()
})
