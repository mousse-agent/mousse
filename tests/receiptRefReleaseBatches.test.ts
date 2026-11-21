/**
 * Receipt release discovers ownership before it takes the repository lease, then holds the lease only for short
 * batches: each re-reads what it must under the lease, checks every claim from the records with nothing awaited until
 * its one Git transaction starts, and lets go when a turn wants the repository. These cases pin what that must keep:
 * - a turn that asks for the repository during a long release gets it between batches;
 * - a claim written by another thread after discovery (a fork copying the receipt) still keeps the ref;
 * - a thread registered after discovery makes the release discover again, not decide on a stand-in;
 * - a stop between the recorded intent and the delete leaves the refs, and the next run finishes the release.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { RELEASE_BATCH_SIZE, ReceiptRefReleaseService } from '../src/mms/actions/ReceiptRefReleaseService'
import { acquireRepositoryLease, repositoryLeaseWanted } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { discoverOwnershipFacts } from '../src/mms/lifecycle/ownershipDiscovery'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { unverifiableThread } from './support/unverifiableThread'

// Each case makes several checkpoints, each a few Git processes; process starts are slow on Windows.
vi.setConfig({ testTimeout: 180_000 })

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())

async function fixture(receipts = 1) {
  writeFileSync(join(f.thread, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'default', profileHome: f.home, allowedTaskRoots: [f.root] })
  store.registerTask({ taskId: 'task', location: f.thread })
  const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
  for (let i = 0; i < receipts; i++) {
    await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(workspace.worktreePath, `turn-${i}`), () => writeFileSync(join(workspace.worktreePath, 'value.txt'), `change ${i}\n`))
  }
  let now = Date.now()
  const retention = new UndoRetentionService(f.thread, () => now)
  await retention.configure(workspace.worktreePath, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 100000 }, true)
  now += 10000
  await retention.sweep(workspace.worktreePath)
  return { store, workspace, receipts: new ChangeReceiptService(f.thread).list(), release: new ReceiptRefReleaseService(store, 'task', () => now) }
}

const refExists = (ref: string): boolean => git(f.repo, 'for-each-ref', '--format=%(refname)', ref) === ref

it('a turn that asks for the repository during a long release gets it between batches', async () => {
  const { workspace, receipts, release } = await fixture(RELEASE_BATCH_SIZE + 1)
  // A turn of another thread asks for the repository lease while the first batch holds it.
  const identity = resolveRepositoryIdentity(f.repo)
  const order: string[] = []
  let turn: Promise<void> | undefined
  const result = await release.release(workspace.worktreePath, {
    afterCheck: () => {
      order.push('batch')
      turn ??= acquireRepositoryLease(identity).then((lease) => { order.push('turn'); lease.release() })
    }
  })
  await turn
  expect(result.retained).toEqual([])
  expect(result.releasedRefs).toHaveLength(receipts.length * 2)
  // The turn ran after the first batch and before the second, not after the whole release.
  expect(order).toEqual(['batch', 'turn', 'batch'])
})

it('a claim another thread writes after discovery still keeps the ref', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const receipt = receipts[0]!
  const discovery = await discoverOwnershipFacts(store)
  // A fork in another thread copies the receipt into its own journal after ownership was discovered.
  const fork = join(f.root, 'fork')
  mkdirSync(join(fork, 'journal'), { recursive: true })
  writeFileSync(join(fork, 'meta.json'), JSON.stringify({ id: 'fork' }))
  store.registerTask({ taskId: 'fork', location: fork })
  new ThreadJournal(fork).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt } })
  const result = await release.release(workspace.worktreePath, { discovery })
  expect(result.releasedRefs).toEqual([])
  expect(result.retained).toEqual([{ receiptId: receipt.id, reason: expect.stringContaining('another task or profile') }])
  for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
})

it('a thread registered while the release waits for the lease makes it discover again before deciding', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const receipt = receipts[0]!
  // The release discovers, then waits for the lease while a new thread with a worktree in this repository appears.
  const identity = resolveRepositoryIdentity(f.repo)
  const held = await acquireRepositoryLease(identity)
  const running = release.release(workspace.worktreePath)
  while (!repositoryLeaseWanted(identity.key)) await new Promise((resolve) => setImmediate(resolve))
  const broken = unverifiableThread(store, { id: 'late', name: 'Fix prices', repo: f.repo, how: 'unlinked' })
  held.release()
  const result = await running
  // Discovered again, the new thread's worktree is read: it can't be verified, so it holds this repository's refs.
  expect(result.releasedRefs).toEqual([])
  expect(result.retained).toEqual([{ receiptId: receipt.id, reason: expect.stringContaining(broken.worktree) }])
  for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
})

it('a stop between the recorded intent and the delete keeps the refs, and the next run finishes the release', async () => {
  const { workspace, receipts, release } = await fixture(2)
  const stopped = await release.release(workspace.worktreePath, { afterPrepared: () => { throw new Error('stopped') } })
  expect(stopped.releasedRefs).toEqual([])
  expect(stopped.retained.map((item) => item.reason)).toEqual(['stopped', 'stopped'])
  for (const receipt of receipts) for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
  const prepared = [...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'undo-ref-release')
  expect(prepared.map((entry) => entry.state)).toEqual(['prepared', 'prepared'])
  const finished = await release.release(workspace.worktreePath)
  expect(finished.retained).toEqual([])
  expect(finished.releasedRefs.sort()).toEqual(receipts.flatMap((receipt) => receipt.retainedRefs).sort())
  for (const receipt of receipts) for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(false)
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual([])
})
