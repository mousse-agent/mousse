import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadJournal } from '../data/ThreadJournal'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { getMousseHomeDir } from '../data/paths'
import { hiddenStoreIdentity, inHiddenStore, runStoreGit } from '../git/hiddenStore'
import { repoProgramEnv } from '../git/repoPrograms'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { collectStoreGarbage, dropSnapshotStoreUser, loadSnapshotWorkspace, readSnapshotWorkspaceRecord, removeThreadSnapshots, SNAPSHOT_TRASH_QUIET_MS, threadPinRef, trashProjectStoreIfUnused } from '../workspace/SnapshotWorkspace'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, tryGit } from './git'
import { UndoRetentionService } from './UndoRetentionService'

export interface SnapshotReleaseResult {
  releasedRefs: string[]
  retained: Array<{ receiptId: string; reason: string }>
  /** Garbage was collected in the store after refs were released. */
  collected: boolean
}

const ACTIVE = ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required']

function refValue(top: string, name: string): string | undefined {
  return tryGit(top, ['rev-parse', '--verify', '-q', name]).stdout || undefined
}

/**
 * Releases the refs of receipts whose Undo has expired, in the hidden store of a folder without Git, and then
 * collects the store's garbage. `ReceiptRefReleaseService` does this for a worktree and never collects garbage, because
 * the repository is the person's; the store is Mousse's own and holds nothing but snapshots, so what no ref pins any
 * more can go at once (`git gc --prune=now`).
 *
 * Only a receipt's own pair (`refs/mousse/changes/<id>/{before,after}`) is deleted, and only while it still points where the
 * receipt says. The thread's latest-snapshot pin and its conversation branches' pins stay.
 */
export async function releaseSnapshotRefs(threadDirectory: string, options: { limit?: number; signal?: AbortSignal; heldThreadLease?: ThreadLeaseHandle; now?: () => number } = {}): Promise<SnapshotReleaseResult> {
  const workspace = loadSnapshotWorkspace(threadDirectory)
  if (!workspace) throw new Error('This thread has no snapshot workspace.')
  const limit = options.limit ?? 20
  return withGitMutationLocks(threadDirectory, workspace.record.workTree, 'undo-ref-release', () => {
    const retention = new UndoRetentionService(threadDirectory, options.now)
    if (!retention.clockAllowsRelease()) throw new Error('Clock review or recovery is required before physical receipt release.')
    const journal = new ThreadJournal(threadDirectory)
    if ([...journal.latestByOperation().values()].some((entry) => ACTIVE.includes(entry.state))) throw new Error('Active or recovery operations protect receipt refs.')
    const expired = retention.expiredReceiptIds()
    const result: SnapshotReleaseResult = { releasedRefs: [], retained: [], collected: false }
    const top = workspace.store.workTree
    for (const receipt of new ChangeReceiptService(threadDirectory).list().filter((item) => expired.has(item.id))) {
      if (result.releasedRefs.length >= limit * 2) break
      const names = [`refs/mousse/changes/${receipt.id}/before`, `refs/mousse/changes/${receipt.id}/after`]
      if (JSON.stringify(receipt.retainedRefs) !== JSON.stringify(names)) {
        result.retained.push({ receiptId: receipt.id, reason: 'Receipt owns an unexpected reference namespace.' })
        continue
      }
      const expectedValues = [receipt.beforeSha, receipt.afterSha]
      const present = names.map((name, index) => ({ name, expected: expectedValues[index]!, current: refValue(top, name) })).filter((ref) => ref.current !== undefined)
      const changed = present.find((ref) => ref.current !== ref.expected)
      if (changed) {
        result.retained.push({ receiptId: receipt.id, reason: `Receipt reference changed: ${changed.name}` })
        continue
      }
      for (const ref of present) {
        git(top, ['update-ref', '-d', ref.name, ref.current!])
        result.releasedRefs.push(ref.name)
      }
    }
    if (result.releasedRefs.length) {
      collectStoreGarbage(workspace.store)
      result.collected = true
    }
    return result
  }, options.signal, options.heldThreadLease)
}

/**
 * What a thread leaves in snapshot stores when it is deleted for good. A thread with no project has a store of its own,
 * which is removed. A thread of a project that is not a Git repository shares the project's store: its
 * latest-snapshot pin, its receipts' pairs and its conversation branches' pins are dropped and the store's garbage is
 * collected, while another thread's pins, and so the snapshots they hold, stay. Returns the refs dropped.
 */
export async function releaseThreadSnapshots(threadDirectory: string, signal?: AbortSignal): Promise<string[]> {
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  if (record?.kind === 'standalone') {
    removeThreadSnapshots(record.threadId)
    return []
  }
  const workspace = loadSnapshotWorkspace(threadDirectory)
  if (!workspace || workspace.record.kind !== 'project') return []
  const lease = await acquireRepositoryLease(hiddenStoreIdentity(workspace.store), { signal })
  try {
    return inHiddenStore(workspace.store, () => {
      const top = workspace.store.workTree
      const names = new Set<string>()
      const pins = tryGit(top, ['for-each-ref', '--format=%(refname)', `refs/mousse/threads/${workspace.record.threadId}/`])
      for (const name of pins.stdout.split(/\r?\n/).filter(Boolean)) names.add(name)
      names.add(threadPinRef(workspace.record.threadId))
      for (const receipt of new ChangeReceiptService(threadDirectory, { readOnly: true }).list()) for (const name of receipt.retainedRefs) names.add(name)
      const branches = join(threadDirectory, 'conversation-branches.json')
      if (existsSync(branches)) {
        try {
          for (const branch of JSON.parse(readFileSync(branches, 'utf8')) as Array<{ id?: string; retainedRef?: string }>) {
            if (branch.retainedRef) names.add(branch.retainedRef)
            else if (branch.id) names.add(`refs/mousse/conversation-branches/${branch.id}`)
          }
        } catch { /* An unreadable branch list names no refs; its pins are collected by the project's removal. */ }
      }
      const released: string[] = []
      for (const name of names) {
        // Only Mousse's own namespaces: a name that came from a record is never trusted to point elsewhere.
        if (!name.startsWith('refs/mousse/')) continue
        const current = refValue(top, name)
        if (current === undefined) continue
        git(top, ['update-ref', '-d', name, current])
        released.push(name)
      }
      // Files a restore of this thread kept (`refs/mousse/preserved/<operation>-…`) exist nowhere else: they move to the
      // trash namespace, which the storage cleanup empties after the trash's wait (`expireTrashedSnapshotRefs`).
      const operations = new ChangeReceiptService(threadDirectory, { readOnly: true }).list().map((receipt) => receipt.operationId)
      const preserved = tryGit(top, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/preserved/']).stdout.split(/\r?\n/).filter(Boolean)
      const trashed = `refs/mousse/trash/${Date.now()}`
      for (const line of preserved) {
        const [name, sha] = line.split(' ') as [string, string]
        const leaf = name.slice('refs/mousse/preserved/'.length)
        if (!operations.some((operation) => leaf.startsWith(`${operation}-`))) continue
        git(top, ['update-ref', '--no-deref', `${trashed}/preserved/${leaf}`, sha])
        git(top, ['update-ref', '-d', name, sha])
        released.push(name)
      }
      if (released.length) collectStoreGarbage(workspace.store)
      dropSnapshotStoreUser(workspace.store.gitDir, workspace.record.threadId)
      return released
    })
  } finally {
    lease.release()
    // The last thread of a removed project lets the store go to the trash, after the lease that lives in it is let go.
    if (workspace.record.projectId) trashProjectStoreIfUnused(workspace.record.projectId)
  }
}

/**
 * Empties the trash namespace of every project store: the preserved files of deleted threads, once they have waited
 * `SNAPSHOT_TRASH_QUIET_MS`, then collects the store's garbage. Returns the refs it deleted.
 */
export async function expireTrashedSnapshotRefs(now = Date.now(), home = getMousseHomeDir()): Promise<string[]> {
  const root = join(home, 'project-data')
  let projects: string[]
  try { projects = readdirSync(root) } catch { return [] }
  const deleted: string[] = []
  for (const projectId of projects) {
    const gitDir = join(root, projectId, 'snapshots.git')
    if (!existsSync(join(gitDir, 'HEAD'))) continue
    const store = { workTree: gitDir, gitDir }
    const lease = await acquireRepositoryLease(hiddenStoreIdentity(store))
    try {
      const run = (args: string[]): string => runStoreGit(store, args, repoProgramEnv())
      const refs = run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/trash/']).split(/\r?\n/).filter(Boolean)
      let removed = 0
      for (const line of refs) {
        const [name, sha] = line.split(' ') as [string, string]
        const at = Number(name.split('/')[3])
        if (!Number.isFinite(at) || now - at < SNAPSHOT_TRASH_QUIET_MS) continue
        run(['update-ref', '-d', name, sha])
        deleted.push(name)
        removed++
      }
      if (removed) collectStoreGarbage(store)
    } finally {
      lease.release()
    }
  }
  return deleted
}
