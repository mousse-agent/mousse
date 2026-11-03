import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadJournal } from '../data/ThreadJournal'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { getMousseHomeDir } from '../data/paths'
import { hiddenStoreIdentity, inHiddenStore, runStoreGitAsync } from '../git/hiddenStore'
import { repoProgramEnv } from '../git/repoPrograms'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { collectStoreGarbageAsync, dropSnapshotStoreUser, loadSnapshotWorkspaceAsync, projectStorePath, readSnapshotWorkspaceRecord, removeThreadSnapshots, SNAPSHOT_TRASH_QUIET_MS, threadPinRef, threadStorePath, trashProjectStoreIfUnused } from '../workspace/SnapshotWorkspace'
import { ChangeReceiptService } from './ChangeReceiptService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { gitAsync, LISTING, tryGitAsync } from './git'
import { UndoRetentionService } from './UndoRetentionService'
import { settlesItself } from '../../shared/resourceLifecycle'
import { keptFilesFromListing, PRESERVED_REF_FORMAT, PRESERVED_REFS, threadPreservedIndex, type KeptFilesRef } from './preservedFiles'

export interface SnapshotReleaseResult {
  releasedRefs: string[]
  retained: Array<{ receiptId: string; reason: string }>
  /** Garbage was collected in the store after refs were released. */
  collected: boolean
}

const ACTIVE = ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required']

async function refValueAsync(top: string, name: string): Promise<string | undefined> {
  return (await tryGitAsync(top, ['rev-parse', '--verify', '-q', name])).stdout || undefined
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
  const workspace = await loadSnapshotWorkspaceAsync(threadDirectory)
  if (!workspace) throw new Error('This thread has no snapshot workspace.')
  const limit = options.limit ?? 20
  return withGitMutationLocks(threadDirectory, workspace.record.workTree, 'undo-ref-release', async () => {
    const retention = new UndoRetentionService(threadDirectory, options.now)
    if (!retention.clockAllowsRelease()) throw new Error('Clock review or recovery is required before physical receipt release.')
    const journal = new ThreadJournal(threadDirectory)
    // An unsettled expiry of kept files touches no receipt ref: it never holds this release back.
    if ([...journal.latestByOperation().values()].some((entry) => ACTIVE.includes(entry.state) && !settlesItself(entry.operationType))) throw new Error('Active or recovery operations protect receipt refs.')
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
      const values: Array<{ name: string; expected: string; current: string | undefined }> = []
      for (const [index, name] of names.entries()) values.push({ name, expected: expectedValues[index]!, current: await refValueAsync(top, name) })
      const present = values.filter((ref) => ref.current !== undefined)
      const changed = present.find((ref) => ref.current !== ref.expected)
      if (changed) {
        result.retained.push({ receiptId: receipt.id, reason: `Receipt reference changed: ${changed.name}` })
        continue
      }
      for (const ref of present) {
        await gitAsync(top, ['update-ref', '-d', ref.name, ref.current!])
        result.releasedRefs.push(ref.name)
      }
    }
    if (result.releasedRefs.length) {
      await collectStoreGarbageAsync(workspace.store)
      result.collected = true
    }
    return result
  }, options.signal, options.heldThreadLease)
}

/**
 * The thread's own kept-files refs in its hidden snapshot store (a folder without Git), with the store's Git directory:
 * the same `discardReason` rule as in a repository (`keptFilesFromListing`). Undefined for a thread with no store. Reads
 * only, and needs neither the thread's folder nor a lease; the store's Git runs as a child process.
 */
export async function threadStoreKeptFilesAsync(threadDirectory: string, now = Date.now()): Promise<{ gitDir: string; refs: KeptFilesRef[] } | undefined> {
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  if (!record || (record.kind === 'project' && !record.projectId)) return undefined
  const gitDir = record.kind === 'project' ? projectStorePath(record.projectId!) : threadStorePath(record.threadId)
  if (!existsSync(join(gitDir, 'HEAD'))) return undefined
  const listing = await runStoreGitAsync({ workTree: gitDir, gitDir }, ['for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, PRESERVED_REFS], repoProgramEnv(), LISTING.maxBuffer)
  return { gitDir, refs: keptFilesFromListing(listing, threadDirectory, now) }
}

/**
 * What a thread leaves in snapshot stores when it is deleted for good. A thread with no project has a store of its own,
 * which is removed. A thread of a project that is not a Git repository shares the project's store: its
 * latest-snapshot pin, its receipts' pairs and its conversation branches' pins are dropped and the store's garbage is
 * collected, while another thread's pins, and so the snapshots they hold, stay. Kept files still within their Undo
 * window go only with `discardAuthorized`, the person's discard in the purge; otherwise nothing is released. Returns the
 * refs dropped.
 */
export async function releaseThreadSnapshots(threadDirectory: string, signal?: AbortSignal, options: { discardAuthorized?: boolean } = {}): Promise<string[]> {
  // Kept files that may be the only copy of a file leave only with the person's discard (the purge preview lists them).
  const young = options.discardAuthorized ? [] : (await threadStoreKeptFilesAsync(threadDirectory))?.refs.filter((item) => item.discardReason) ?? []
  if (young.length) throw new Error(`Files set aside before a restore or an abort may be the only copy (${young.map((item) => item.ref).join(', ')}); deleting this thread for good needs them discarded.`)
  const record = readSnapshotWorkspaceRecord(threadDirectory)
  if (record?.kind === 'standalone') {
    removeThreadSnapshots(record.threadId)
    return []
  }
  const workspace = await loadSnapshotWorkspaceAsync(threadDirectory)
  if (!workspace || workspace.record.kind !== 'project') return []
  const lease = await acquireRepositoryLease(hiddenStoreIdentity(workspace.store), { signal })
  try {
    // Awaited here, so the lease is let go only once the work in the store is done.
    return await inHiddenStore(workspace.store, async () => {
      const top = workspace.store.workTree
      const names = new Set<string>()
      const pins = await tryGitAsync(top, ['for-each-ref', '--format=%(refname)', `refs/mousse/threads/${workspace.record.threadId}/`], undefined, LISTING)
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
        const current = await refValueAsync(top, name)
        if (current === undefined) continue
        await gitAsync(top, ['update-ref', '-d', name, current])
        released.push(name)
      }
      // Files a restore of this thread kept (`refs/mousse/preserved/<operation>-…`) exist nowhere else: they move to the
      // trash namespace, which the storage cleanup empties after the trash's wait (`expireTrashedSnapshotRefs`).
      // Only the thread's own, by the exact names their writers use (`threadPreservedIndex`), never by a prefix.
      const owned = threadPreservedIndex(threadDirectory)
      const preserved = (await tryGitAsync(top, ['for-each-ref', '--format=%(refname) %(objectname)', PRESERVED_REFS], undefined, LISTING)).stdout.split(/\r?\n/).filter(Boolean)
      const trashed = `refs/mousse/trash/${Date.now()}`
      for (const line of preserved) {
        const [name, sha] = line.split(' ') as [string, string]
        const leaf = name.slice(PRESERVED_REFS.length)
        if (!owned.owns(name)) continue
        await gitAsync(top, ['update-ref', '--no-deref', `${trashed}/preserved/${leaf}`, sha])
        await gitAsync(top, ['update-ref', '-d', name, sha])
        released.push(name)
      }
      if (released.length) await collectStoreGarbageAsync(workspace.store)
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
      const run = (args: string[]): Promise<string> => runStoreGitAsync(store, args, repoProgramEnv(), LISTING.maxBuffer)
      const refs = (await run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/trash/'])).split(/\r?\n/).filter(Boolean)
      let removed = 0
      for (const line of refs) {
        const [name, sha] = line.split(' ') as [string, string]
        const at = Number(name.split('/')[3])
        if (!Number.isFinite(at) || now - at < SNAPSHOT_TRASH_QUIET_MS) continue
        await run(['update-ref', '-d', name, sha])
        deleted.push(name)
        removed++
      }
      if (removed) await collectStoreGarbageAsync(store)
    } finally {
      lease.release()
    }
  }
  return deleted
}
