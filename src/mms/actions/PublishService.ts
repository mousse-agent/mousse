import { randomUUID } from 'node:crypto'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, mergeTrees, requireClean, refuseUnsafeChanges, treeOf, tryGit } from './git'
import { publishedRef, sameTree, takeSnapshot } from './snapshots'
import { ChangeReceiptService } from './ChangeReceiptService'
import { ThreadActionService } from './ThreadActionService'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'

export interface PublishOptions {
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  /** The thread's files as the person reviewed them (a snapshot, or any commit with the same files). Publishing refuses when the files differ. */
  expectedSourceSha?: string
  expectedTargetSha?: string
  expectedJournalRevision?: number
  /** The commit message in the primary checkout. */
  message?: string
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
        if (this.differs(threadWorkspace, options.expectedSourceSha, result.sourceSha) || (options.expectedTargetSha && result.prePublishSha !== options.expectedTargetSha)) throw new Error('Publish operation identity was reused for different revisions.')
        return result
      }
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (previous && ['prepared', 'git_applied'].includes(previous.state)) {
        const intent = this.journal.list().find((entry) => entry.operationId === options.operationId && entry.state === 'prepared')
        const expected = intent?.expectedPreState as PublishIntent | undefined
        if (!expected || this.differs(threadWorkspace, options.expectedSourceSha, expected.sourceSha) || (options.expectedTargetSha && expected.prePublishSha !== options.expectedTargetSha) || expected.targetBranch !== targetBranch) throw new Error('Publish recovery requires the original reviewed revisions.')
        // Recovery reads HEAD and records; nothing else in the checkout is touched.
        refuseUnsafeChanges(primaryCheckout, 'Primary checkout')
        if (git(primaryCheckout, ['branch', '--show-current']) !== targetBranch) throw new Error('Publish recovery destination branch changed.')
        const head = git(primaryCheckout, ['rev-parse', 'HEAD'])
        const receipt = receipts.list().find((item) => item.operationId === options.operationId)
        // A publish interrupted before snapshots was a merge commit that has the reviewed commit as a parent.
        const mergedBefore = !expected.publishSha && head !== expected.prePublishSha && tryGit(primaryCheckout, ['merge-base', '--is-ancestor', expected.sourceSha, head]).ok
        if (receipt?.afterSha === head || (expected.publishSha && head === expected.publishSha) || mergedBefore) {
          return this.completePublish(primaryCheckout, options.operationId!, expected.prePublishSha, expected.sourceSha, head)
        }
        if (head !== expected.prePublishSha) throw new Error('Publish recovery HEAD does not match the original operation.')
        this.journal.append({ operationId: options.operationId!, operationType: 'publish', state: 'cancelled', details: { recoveredBeforeGit: true } })
      }
      receipts.assertNoPendingOperation()
      new ThreadActionService(this.threadDirectory).assertExpectedRevision(options.expectedJournalRevision)
      if (resolveRepositoryIdentity(threadWorkspace).key !== resolveRepositoryIdentity(primaryCheckout).key) throw new Error('Publish destination belongs to a different repository.')
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      // The thread's files as they are now. Edits made outside Mousse since the last action are recorded first, so a
      // refused publish still leaves the next review looking at the files that would be published.
      const source = metadata && git(metadata.worktreePath, ['rev-parse', '--show-toplevel']) === git(threadWorkspace, ['rev-parse', '--show-toplevel'])
        ? new ThreadActionService(this.threadDirectory).recordOutsideChangesHeld({ threadId: metadata.threadId, conversationBranchId: metadata.conversationBranchId, workspacePath: threadWorkspace }).startSha
        : takeSnapshot(threadWorkspace, { reason: 'publish', operationId: options.operationId }).sha
      if (this.differs(threadWorkspace, options.expectedSourceSha, source)) throw new Error('Publish source revision changed; refresh review.')
      const prePublishSha = git(primaryCheckout, ['rev-parse', 'HEAD'])
      if (options.expectedTargetSha && prePublishSha !== options.expectedTargetSha) throw new Error('Publish destination revision changed; refresh review.')
      const currentTarget = git(primaryCheckout, ['branch', '--show-current'])
      if (currentTarget !== targetBranch) throw new Error(`Primary checkout must be on ${targetBranch}, found ${currentTarget}`)
      // The primary's files are rewritten in place, so nothing in them may be waiting: no uncommitted edit is set aside or merged over.
      requireClean(primaryCheckout, 'Primary checkout')
      const operationId = options.operationId ?? randomUUID()
      const base = (metadata && tryGit(primaryCheckout, ['rev-parse', '--verify', '-q', `${publishedRef(metadata.threadId)}^{commit}`]).stdout) || metadata?.baseSha || git(primaryCheckout, ['merge-base', prePublishSha, source])
      const merged = mergeTrees(git(primaryCheckout, ['rev-parse', '--show-toplevel']), base, prePublishSha, source)
      if ('conflicts' in merged) return { operationId, state: 'conflict', prePublishSha, sourceSha: source, conflictFiles: merged.conflicts }
      // Nothing to add: the primary already has these files, as when the same changes were merged another way.
      if (merged.tree === treeOf(primaryCheckout, prePublishSha)) return this.completePublish(primaryCheckout, operationId, prePublishSha, source, prePublishSha)
      const publishSha = this.commit(primaryCheckout, merged.tree, prePublishSha, options.message)
      this.journal.append({
        operationId,
        operationType: 'publish',
        state: 'prepared',
        expectedPreState: { prePublishSha, targetBranch, sourceBranch: tryGit(threadWorkspace, ['branch', '--show-current']).stdout || undefined, sourceSha: source, publishSha, tree: merged.tree } satisfies PublishIntent,
        details: { threadWorkspace, primaryCheckout }
      })
      // The branch, the index and the files move together or not at all; a fast-forward refuses before touching anything it cannot update.
      const moved = tryGit(primaryCheckout, ['merge', '--ff-only', publishSha])
      if (!moved.ok) {
        const left = git(primaryCheckout, ['status', '--porcelain', '--untracked-files=all'])
        this.journal.append({ operationId, operationType: 'publish', state: left ? 'recovery_required' : 'cancelled', details: { prePublishSha, targetBranch, error: moved.stderr } })
        throw new Error(`Publish could not update ${primaryCheckout}: ${moved.stderr || 'Git refused the update'}. ${left ? 'Its files were partly updated; check git status there.' : 'Nothing was changed.'}`)
      }
      return this.completePublish(primaryCheckout, operationId, prePublishSha, source, publishSha)
    }, signal, options.heldThreadLease)
  }

  /** Whether the reviewed revision names other files than the one published. A missing one never differs. */
  private differs(cwd: string, expected: string | undefined, actual: string | undefined): boolean {
    return Boolean(expected) && (!actual || !sameTree(cwd, expected!, actual))
  }

  /** The one commit in the primary, with the tree the merge produced and the person's own author and committer. */
  private commit(primaryCheckout: string, tree: string, parent: string, message = DEFAULT_MESSAGE): string {
    try {
      return git(primaryCheckout, ['commit-tree', tree, '-p', parent, '-m', message.trim() || DEFAULT_MESSAGE])
    } catch (error) {
      const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message)
      if (/ident|who you are|user\.(name|email)|empty name|empty email/i.test(detail)) throw new Error(`Git does not know who you are in ${primaryCheckout}. Set user.name and user.email, then publish again.`, { cause: error })
      throw error
    }
  }

  private completePublish(primaryCheckout: string, operationId: string, prePublishSha: string, sourceSha: string, publishSha: string): PublishResult {
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    // The next publish brings in only what the thread changed after these files.
    if (metadata) git(primaryCheckout, ['update-ref', publishedRef(metadata.threadId), sourceSha])
    const receipt = receipts.record(primaryCheckout, {
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

  async recoverPending(threadWorkspace: string, primaryCheckout: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    for (const entry of this.journal.latestByOperation().values()) {
      if (!['publish', 'change-publish'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
      const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
      const expected = intent?.expectedPreState as PublishIntent | undefined
      const paths = intent?.details as { threadWorkspace?: string; primaryCheckout?: string } | undefined
      if (!expected || paths?.threadWorkspace !== threadWorkspace || paths.primaryCheckout !== primaryCheckout) throw new Error('Publish recovery paths do not match their durable owner.')
      await this.publish(threadWorkspace, primaryCheckout, expected.targetBranch, undefined, { heldThreadLease, operationId: entry.operationId, expectedSourceSha: expected.sourceSha, expectedTargetSha: expected.prePublishSha })
    }
  }

  async abortConflict(primaryCheckout: string, operationId: string): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish-abort', async () => {
      const record = this.journal.latestByOperation().get(operationId)
      if (!record || record.operationType !== 'publish' || record.state !== 'recovery_required') {
        throw new Error('No matching publish conflict is active.')
      }
      // Only a publish made before snapshots left a merge in progress.
      const result = tryGit(primaryCheckout, ['merge', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort publish merge')
      this.journal.append({ operationId, operationType: 'publish', state: 'cancelled' })
    })
  }
}
