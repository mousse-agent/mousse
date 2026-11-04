import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { currentUserRequest, withoutUserRequest, withUserRequest, type UserAction } from '../git/gitPolicy'
import { gitAsync, LISTING, mergeTreesAsync, requireCleanAsync, treeOfAsync, tryGitAsync } from './git'
import { publishedRef, sameTreeAsync, takeSnapshotAsync } from './snapshots'
import { ChangeReceiptService } from './ChangeReceiptService'
import { ThreadActionService } from './ThreadActionService'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { mergeIdentityAsync } from './leftMerge'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { waitForFolderAccess } from '../files/folderAccess'

/** Whether `path` is there, as `existsSync` answers, once its volume answers; never blocks the daemon. */
async function exists(path: string): Promise<boolean> {
  await waitForFolderAccess([path])
  return access(path).then(() => true, () => false)
}

export interface PublishOptions {
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  /** The thread's files as the person reviewed them (a snapshot, or any commit with the same files). Publishing refuses when the files differ. */
  expectedSourceSha?: string
  expectedTargetSha?: string
  expectedJournalRevision?: number
  /** The commit message in the primary checkout. */
  message?: string
  /** The user's request to publish; the commit and the fast-forward in the primary checkout run under it. */
  userRequested?: UserAction
}

export interface PublishResult {
  operationId: string
  /** The snapshot of the thread's files that was published. */
  sourceSha?: string
  receiptId?: string
  state: 'completed' | 'conflict'
  prePublishSha: string
  publishSha?: string
  conflictFiles?: string[]
}

/** What `prepared` records: the commit is made before the primary moves, so recovery can tell whether it landed. */
interface PublishIntent {
  prePublishSha: string
  targetBranch: string
  sourceBranch?: string
  sourceSha: string
  publishSha: string
  tree: string
}

const DEFAULT_MESSAGE = 'Changes from a Mousse thread'
/** A publish in one of these states started and did not finish; `recovery_required` is what older versions left. */
const PENDING_STATES = ['prepared', 'git_applied', 'recovery_required']

export type PublishRecovery =
  | { operationId: string; state: 'completed'; result: PublishResult }
  | { operationId: string; state: 'cancelled'; mergeInProgress?: string }
  /** The primary checkout could not be read; the publish stays as it is and is looked at again on the next recovery. */
  | { operationId: string; state: 'pending'; reason: string }

/**
 * Untracked, ignored files in `checkout` that moving from `from` to `to` would write over: a path the new tree adds or
 * changes, or a folder above one. Reads only.
 */
async function ignoredInTheWay(checkout: string, from: string, to: string): Promise<string[]> {
  const written = (await gitAsync(checkout, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=AMT', from, to], undefined, undefined, LISTING)).split('\0').filter(Boolean)
  if (!written.length) return []
  const candidates = new Set<string>()
  for (const path of written) {
    const parts = path.split('/')
    for (let depth = 1; depth <= parts.length; depth++) candidates.add(parts.slice(0, depth).join('/'))
  }
  const found = new Set<string>()
  const list = [...candidates]
  for (let start = 0; start < list.length; start += 500) {
    const chunk = list.slice(start, start + 500).map((path) => `:(literal)${path}`)
    for (const path of (await gitAsync(checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...chunk], undefined, undefined, LISTING)).split('\0').filter(Boolean)) found.add(path)
  }
  return [...found].sort()
}

/**
 * Publishes the thread's files into the primary checkout as one commit on its current branch, made with the person's
 * own Git identity. The files come from the thread's latest snapshot, not its branch, so uncommitted turn results are
 * published and Mousse's snapshots never reach the primary's history. The result is a three-way merge of the snapshot
 * onto the primary (base: what the thread last published, else where it started); a conflict refuses with the file
 * names and changes nothing. The primary must be clean and on the target branch.
 */
export class PublishService {
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
  }

  async publish(
    threadWorkspace: string,
    primaryCheckout: string,
    targetBranch: string,
    signal?: AbortSignal,
    options: PublishOptions = {}
  ): Promise<PublishResult> {
    return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish', async () => {
      const previous = options.operationId ? this.journal.latestByOperation().get(options.operationId) : undefined
      if (previous?.state === 'completed') {
        const result = previous.details as PublishResult
        if (await this.differs(threadWorkspace, options.expectedSourceSha, result.sourceSha) || (options.expectedTargetSha && result.prePublishSha !== options.expectedTargetSha)) throw new Error('Publish operation identity was reused for different revisions.')
        return result
      }
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (previous && PENDING_STATES.includes(previous.state)) {
        const intent = this.intentOf(options.operationId!)
        if (!intent || await this.differs(threadWorkspace, options.expectedSourceSha, intent.expected.sourceSha) || (options.expectedTargetSha && intent.expected.prePublishSha !== options.expectedTargetSha) || intent.expected.targetBranch !== targetBranch) throw new Error('Publish recovery requires the original reviewed revisions.')
        // The earlier attempt is recorded first. Only when it did not land does this explicit Publish go on to publish again.
        const recovered = await withoutUserRequest(() => this.settle(primaryCheckout, options.operationId!, intent.expected))
        if (recovered.state === 'completed') return recovered.result
        if (recovered.state === 'pending') throw new Error(`An earlier publish is not settled yet: ${recovered.reason}.`)
      }
      // Another publish that did not finish is settled first; one that cannot be settled yet stops only this publish.
      for (const entry of this.journal.latestByOperation().values()) {
        if (entry.operationId === options.operationId || !['publish', 'change-publish'].includes(entry.operationType) || !PENDING_STATES.includes(entry.state)) continue
        const intent = this.intentOf(entry.operationId)
        const recorded = intent?.paths.primaryCheckout
        const checkout = recorded && await exists(recorded) ? recorded : primaryCheckout
        const settled = intent ? await withoutUserRequest(() => this.settle(checkout, entry.operationId, intent.expected)) : undefined
        if (settled?.state === 'pending') throw new Error(`An earlier publish is not settled yet: ${settled.reason}.`)
      }
      receipts.assertNoPendingOperation()
      new ThreadActionService(this.threadDirectory).assertExpectedRevision(options.expectedJournalRevision)
      if ((await resolveRepositoryIdentityAsync(threadWorkspace)).key !== (await resolveRepositoryIdentityAsync(primaryCheckout)).key) throw new Error('Publish destination belongs to a different repository.')
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      // The thread's files as they are now. Edits made outside Mousse since the last action are recorded first, so a
      // refused publish still leaves the next review looking at the files that would be published.
      const source = metadata && await gitAsync(metadata.worktreePath, ['rev-parse', '--show-toplevel']) === await gitAsync(threadWorkspace, ['rev-parse', '--show-toplevel'])
        ? (await new ThreadActionService(this.threadDirectory).recordOutsideChangesHeld({ threadId: metadata.threadId, conversationBranchId: metadata.conversationBranchId, workspacePath: threadWorkspace })).startSha
        : (await takeSnapshotAsync(threadWorkspace, { reason: 'publish', operationId: options.operationId })).sha
      if (await this.differs(threadWorkspace, options.expectedSourceSha, source)) throw new Error('Publish source revision changed; refresh review.')
      const prePublishSha = await gitAsync(primaryCheckout, ['rev-parse', 'HEAD'])
      if (options.expectedTargetSha && prePublishSha !== options.expectedTargetSha) throw new Error('Publish destination revision changed; refresh review.')
      const currentTarget = await gitAsync(primaryCheckout, ['branch', '--show-current'])
      if (currentTarget !== targetBranch) throw new Error(`Primary checkout must be on ${targetBranch}, found ${currentTarget}`)
      // The primary's files are rewritten in place, so nothing in them may be waiting: no uncommitted edit is set aside or merged over.
      await requireCleanAsync(primaryCheckout, 'Primary checkout')
      const operationId = options.operationId ?? randomUUID()
      const base = (metadata && (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', `${publishedRef(metadata.threadId)}^{commit}`])).stdout) || metadata?.baseSha || await gitAsync(primaryCheckout, ['merge-base', prePublishSha, source])
      const merged = await mergeTreesAsync(await gitAsync(primaryCheckout, ['rev-parse', '--show-toplevel']), base, prePublishSha, source)
      if ('conflicts' in merged) return { operationId, state: 'conflict', prePublishSha, sourceSha: source, conflictFiles: merged.conflicts }
      // Nothing to add: the primary already has these files, as when the same changes were merged another way.
      if (merged.tree === await treeOfAsync(primaryCheckout, prePublishSha)) return this.completePublish(primaryCheckout, operationId, prePublishSha, source, prePublishSha)
      // An ignored file in the primary is the person's (a local config, a build output) and is never written over.
      const ignored = await ignoredInTheWay(primaryCheckout, prePublishSha, merged.tree)
      if (ignored.length) throw new Error(`Publish would overwrite ignored files in ${primaryCheckout}: ${ignored.slice(0, 10).join(', ')}${ignored.length > 10 ? ` and ${ignored.length - 10} more` : ''}. Move them aside, then publish again. Nothing was changed.`)
      // The commit and the move of the primary's branch are the user's request; nothing else in a publish borrows it.
      const request = options.userRequested ?? currentUserRequest()
      const asked = <T>(work: () => T): T => request ? withUserRequest(request, work) : work()
      const publishSha = await asked(() => this.commit(primaryCheckout, merged.tree, prePublishSha, options.message))
      const sourceBranch = (await tryGitAsync(threadWorkspace, ['branch', '--show-current'])).stdout || undefined
      this.journal.append({
        operationId,
        operationType: 'publish',
        state: 'prepared',
        expectedPreState: { prePublishSha, targetBranch, sourceBranch, sourceSha: source, publishSha, tree: merged.tree } satisfies PublishIntent,
        details: { threadWorkspace, primaryCheckout }
      })
      // The branch, the index and the files move together or not at all; a fast-forward refuses before touching anything
      // it cannot update, and never writes over an ignored file.
      const moved = await asked(() => tryGitAsync(primaryCheckout, ['merge', '--ff-only', '--no-overwrite-ignore', publishSha]))
      if (!moved.ok) {
        // The branch did not move, so there is nothing to recover: the attempt is closed and the thread stays usable.
        const left = await gitAsync(primaryCheckout, ['status', '--porcelain', '--untracked-files=all'], undefined, undefined, LISTING)
        this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { prePublishSha, targetBranch, error: moved.stderr, ...(left ? { leftFiles: true } : {}) } })
        throw new Error(`Publish could not update ${primaryCheckout}: ${moved.stderr || 'Git refused the update'}. ${left ? 'Some of its files may have been updated; check git status there.' : 'Nothing was changed.'}`)
      }
      return this.completePublish(primaryCheckout, operationId, prePublishSha, source, publishSha)
    }, signal, options.heldThreadLease)
  }

  /** Whether the reviewed revision names other files than the one published. A missing one never differs. */
  private async differs(cwd: string, expected: string | undefined, actual: string | undefined): Promise<boolean> {
    // Publish commits Git's form of the files, so a file whose line endings alone changed since the review is the same.
    return Boolean(expected) && (!actual || !await sameTreeAsync(cwd, expected!, actual, { exact: false }))
  }

  /** The one commit in the primary, with the tree the merge produced and the person's own author and committer. */
  private async commit(primaryCheckout: string, tree: string, parent: string, message = DEFAULT_MESSAGE): Promise<string> {
    try {
      return await gitAsync(primaryCheckout, ['commit-tree', tree, '-p', parent, '-m', message.trim() || DEFAULT_MESSAGE])
    } catch (error) {
      const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message)
      if (/ident|who you are|user\.(name|email)|empty name|empty email/i.test(detail)) throw new Error(`Git does not know who you are in ${primaryCheckout}. Set user.name and user.email, then publish again.`, { cause: error })
      throw error
    }
  }

  private async completePublish(primaryCheckout: string, operationId: string, prePublishSha: string, sourceSha: string, publishSha: string): Promise<PublishResult> {
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    // The next publish brings in only what the thread changed after these files.
    if (metadata) await gitAsync(primaryCheckout, ['update-ref', '--no-deref', publishedRef(metadata.threadId), sourceSha])
    const receipt = await receipts.record(primaryCheckout, {
      operationId, kind: 'publish', actor: { kind: 'user' }, beforeSha: prePublishSha, afterSha: publishSha,
      introducedCommits: prePublishSha === publishSha ? [] : [publishSha],
      contributions: [{ baseSha: prePublishSha, resultSha: sourceSha }], externalEffects: [],
      publishedReceiptIds: this.includedReceipts()
    })
    const result: PublishResult = { operationId, state: 'completed', prePublishSha, publishSha, sourceSha, receiptId: receipt.id }
    this.journal.append({ operationId, operationType: 'publish', state: 'completed', details: result })
    return result
  }

  /**
   * The thread's receipts whose changes are in the published files: every receipt but a publish, on the active
   * conversation branch, that has not been undone. The files are the thread's latest, so all of them are in.
   */
  private includedReceipts(): string[] {
    const active = new ThreadWorkspaceManager(this.threadDirectory).load()?.conversationBranchId
    const actions = new ThreadActionService(this.threadDirectory).list()
    return new ChangeReceiptService(this.threadDirectory).list().filter((item) => {
      if (item.kind === 'publish') return false
      const action = actions.find((entry) => entry.receiptId === item.id || entry.id === item.actionId)
      if (!action) return true
      return (!active || action.conversationBranchId === active) && action.state !== 'undone'
    }).map((item) => item.id)
  }

  /**
   * Settles every publish that did not finish: one that landed is recorded as completed, any other is cancelled. It
   * only reads the primary checkout and records; it never publishes again and never touches the primary's files,
   * index or branches. A publish an older version left waiting (`recovery_required`) is settled the same way.
   */
  async recoverPending(_threadWorkspace: string, primaryCheckout: string, heldThreadLease?: ThreadLeaseHandle): Promise<PublishRecovery[]> {
    // Recovery only records what an interrupted publish did; it never runs under the user's request.
    return withoutUserRequest(async () => {
      const pending = [...this.journal.latestByOperation().values()].filter((entry) => ['publish', 'change-publish'].includes(entry.operationType) && PENDING_STATES.includes(entry.state))
      if (!pending.length) return []
      // The primary cannot even be locked when it cannot be read: nothing is decided, and the next recovery tries again.
      if (!await exists(primaryCheckout) || !(await tryGitAsync(primaryCheckout, ['rev-parse', '--git-dir'])).ok) return pending.map((entry) => ({ operationId: entry.operationId, state: 'pending' as const, reason: `${primaryCheckout} could not be read` }))
      return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish-recovery', async () => {
        // One at a time, in the journal's order.
        const settled: PublishRecovery[] = []
        for (const entry of pending) {
          const intent = this.intentOf(entry.operationId)
          if (!intent) {
            this.journal.append({ operationId: entry.operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, reason: 'The publish left no record of what it was about to do; nothing was checked or changed.' } })
            settled.push({ operationId: entry.operationId, state: 'cancelled' as const })
            continue
          }
          // The checkout the publish was made in; the one the thread now names when that one is gone.
          const recorded = intent.paths.primaryCheckout
          const checkout = recorded && await exists(recorded) ? recorded : primaryCheckout
          settled.push(await this.settle(checkout, entry.operationId, intent.expected))
        }
        return settled
      }, undefined, heldThreadLease)
    })
  }

  /** The intent a publish recorded before it moved the primary, and where it ran. */
  private intentOf(operationId: string): { expected: PublishIntent; paths: { threadWorkspace?: string; primaryCheckout?: string } } | undefined {
    const intent = [...this.journal.list()].reverse().find((entry) => entry.operationId === operationId && entry.state === 'prepared')
    const expected = intent?.expectedPreState as PublishIntent | undefined
    if (!expected?.prePublishSha || !expected.sourceSha || !expected.targetBranch) return undefined
    return { expected, paths: (intent!.details ?? {}) as { threadWorkspace?: string; primaryCheckout?: string } }
  }

  /**
   * Records how an interrupted publish ended, from the target branch's tip: completed when its commit is there (or,
   * for one made before snapshots, its merge), cancelled otherwise. Reads only; never publishes again.
   */
  private async settle(primaryCheckout: string, operationId: string, expected: PublishIntent): Promise<PublishRecovery> {
    const tip = await exists(primaryCheckout) ? (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', `refs/heads/${expected.targetBranch}^{commit}`])).stdout : ''
    const contains = async (sha: string): Promise<boolean> => Boolean(tip) && (tip === sha || (await tryGitAsync(primaryCheckout, ['merge-base', '--is-ancestor', sha, tip])).ok)
    const receipt = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
    // A publish interrupted before snapshots was a merge commit that has the reviewed commit as a parent.
    const mergedBefore = !expected.publishSha && Boolean(tip) && tip !== expected.prePublishSha && await contains(expected.sourceSha)
    const landed = receipt?.afterSha && await contains(receipt.afterSha) ? receipt.afterSha : expected.publishSha && await contains(expected.publishSha) ? expected.publishSha : mergedBefore ? tip : undefined
    if (landed) return { operationId, state: 'completed', result: await this.completePublish(primaryCheckout, operationId, expected.prePublishSha, expected.sourceSha, landed) }
    if (!tip) {
      // The checkout reads, and the branch is gone: the publish can never land there, so it is closed and later ones go on.
      const readable = await exists(primaryCheckout) && (await tryGitAsync(primaryCheckout, ['rev-parse', '--git-dir'])).ok
      if (readable && !(await tryGitAsync(primaryCheckout, ['show-ref', '--verify', '-q', `refs/heads/${expected.targetBranch}`])).ok) {
        this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, prePublishSha: expected.prePublishSha, targetBranch: expected.targetBranch, reason: `The publish did not land: target branch ${expected.targetBranch} no longer exists, and nothing was changed by recovery.` } })
        return { operationId, state: 'cancelled' }
      }
      // Unreadable now (a disk that is not mounted): nothing is decided, and recovery tries again.
      return { operationId, state: 'pending', reason: `${primaryCheckout} or its branch ${expected.targetBranch} could not be read` }
    }
    // A publish made before snapshots merged in the primary; a merge it left there is reported, and stays abortable.
    const mergeInProgress = !expected.publishSha && (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).ok ? primaryCheckout : undefined
    const reason = mergeInProgress ? `a merge from an earlier version is still in progress in ${primaryCheckout}; abort it or finish it with Git`
      : tip === expected.prePublishSha ? `${expected.targetBranch} did not move, and nothing was changed by recovery` : `${expected.targetBranch} moved elsewhere, and nothing was changed by recovery`
    this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, prePublishSha: expected.prePublishSha, targetBranch: expected.targetBranch, tip, ...(mergeInProgress ? { mergeInProgress, mergeIdentity: await mergeIdentityAsync(mergeInProgress), sourceSha: expected.sourceSha } : {}), reason: `The publish did not land: ${reason}.` } })
    return { operationId, state: 'cancelled', ...(mergeInProgress ? { mergeInProgress } : {}) }
  }
}
