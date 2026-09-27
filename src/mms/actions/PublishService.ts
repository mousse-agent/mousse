import { randomUUID } from 'node:crypto'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { commitParents, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

import { ChangeReceiptService } from './ChangeReceiptService'
import { ThreadActionService } from './ThreadActionService'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'

export interface PublishOptions {
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  expectedSourceSha?: string
  expectedTargetSha?: string
  expectedJournalRevision?: number
}

export interface PublishResult {
  operationId: string
  sourceSha?: string
  receiptId?: string
  state: 'completed' | 'conflict'
  prePublishSha: string
  publishSha?: string
  conflictFiles?: string[]
}

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
    const expectedSourceSha = options.expectedSourceSha ?? git(threadWorkspace, ['rev-parse', 'HEAD'])
    const expectedTargetSha = options.expectedTargetSha ?? git(primaryCheckout, ['rev-parse', 'HEAD'])
    return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish', async () => {
      const previous = options.operationId ? this.journal.latestByOperation().get(options.operationId) : undefined
      if (previous?.state === 'completed') {
        const result = previous.details as PublishResult
        if (result.sourceSha !== expectedSourceSha || result.prePublishSha !== expectedTargetSha) throw new Error('Publish operation identity was reused for different revisions.')
        return result
      }
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (previous && ['prepared', 'git_applied'].includes(previous.state)) {
        const intent = this.journal.list().find((entry) => entry.operationId === options.operationId && entry.state === 'prepared')
        const expected = intent?.expectedPreState as { prePublishSha: string; sourceSha: string; targetBranch: string } | undefined
        if (!expected || expected.sourceSha !== expectedSourceSha || expected.prePublishSha !== expectedTargetSha || expected.targetBranch !== targetBranch) throw new Error('Publish recovery requires the original reviewed revisions.')
        requireClean(primaryCheckout, 'Primary checkout')
        if (git(primaryCheckout, ['branch', '--show-current']) !== targetBranch) throw new Error('Publish recovery destination branch changed.')
        const head = git(primaryCheckout, ['rev-parse', 'HEAD'])
        const parents = commitParents(primaryCheckout, head)
        const receipt = receipts.list().find((item) => item.operationId === options.operationId)
        if (receipt?.afterSha === head || (parents[0] === expected.prePublishSha && parents[1] === expected.sourceSha) || (head === expected.prePublishSha && tryGit(primaryCheckout, ['merge-base', '--is-ancestor', expected.sourceSha, head]).ok)) {
          return this.completePublish(threadWorkspace, primaryCheckout, options.operationId!, expected.prePublishSha, expected.sourceSha, head)
        }
        if (head !== expected.prePublishSha) throw new Error('Publish recovery HEAD does not match the original operation.')
        this.journal.append({ operationId: options.operationId!, operationType: 'publish', state: 'cancelled', details: { recoveredBeforeGit: true } })
      }
      receipts.assertNoPendingOperation()
      new ThreadActionService(this.threadDirectory).assertExpectedRevision(options.expectedJournalRevision)
      if (resolveRepositoryIdentity(threadWorkspace).key !== resolveRepositoryIdentity(primaryCheckout).key) throw new Error('Publish destination belongs to a different repository.')
      if (git(threadWorkspace, ['rev-parse', 'HEAD']) !== expectedSourceSha) throw new Error('Publish source revision changed; refresh review.')
      if (git(primaryCheckout, ['rev-parse', 'HEAD']) !== expectedTargetSha) throw new Error('Publish destination revision changed; refresh review.')
      requireClean(threadWorkspace, 'Thread workspace')
      requireClean(primaryCheckout, 'Primary checkout')
      const currentTarget = git(primaryCheckout, ['branch', '--show-current'])
      if (currentTarget !== targetBranch) throw new Error(`Primary checkout must be on ${targetBranch}, found ${currentTarget}`)
      const sourceBranch = git(threadWorkspace, ['branch', '--show-current'])
      const prePublishSha = git(primaryCheckout, ['rev-parse', 'HEAD'])
      const operationId = options.operationId ?? randomUUID()
      this.journal.append({
        operationId,
        operationType: 'publish',
        state: 'prepared',
        expectedPreState: { prePublishSha, targetBranch, sourceBranch, sourceSha: expectedSourceSha },
        details: { threadWorkspace, primaryCheckout }
      })
      const merged = tryGit(primaryCheckout, ['merge', '--no-ff', '--no-edit', expectedSourceSha], MOUSSE_COMMIT_ENV)
      if (!merged.ok) {
        const conflictFiles = git(primaryCheckout, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
        this.journal.append({
          operationId,
          operationType: 'publish',
          state: 'recovery_required',
          details: { prePublishSha, targetBranch, sourceBranch, conflictFiles, error: merged.stderr }
        })
        return { operationId, state: 'conflict', prePublishSha, conflictFiles }
      }
      const publishSha = git(primaryCheckout, ['rev-parse', 'HEAD'])
      return this.completePublish(threadWorkspace, primaryCheckout, operationId, prePublishSha, expectedSourceSha, publishSha)
    }, signal, options.heldThreadLease)
  }

  private completePublish(threadWorkspace: string, primaryCheckout: string, operationId: string, prePublishSha: string, expectedSourceSha: string, publishSha: string): PublishResult {
      const receipts = new ChangeReceiptService(this.threadDirectory)
      const publishedReceiptIds = receipts.list().filter((item) => item.kind !== 'publish' && tryGit(threadWorkspace, ['merge-base', '--is-ancestor', item.afterSha, expectedSourceSha]).ok).map((item) => item.id)
      const receipt = receipts.record(primaryCheckout, { operationId, kind: 'publish', actor: { kind: 'user' }, beforeSha: prePublishSha, afterSha: publishSha, introducedCommits: prePublishSha === publishSha ? [] : [publishSha], contributions: [{ baseSha: prePublishSha, resultSha: expectedSourceSha }], externalEffects: [], publishedReceiptIds })
      const result: PublishResult = { operationId, state: 'completed', prePublishSha, publishSha, sourceSha: expectedSourceSha, receiptId: receipt.id }
      this.journal.append({ operationId, operationType: 'publish', state: 'completed', details: result })
      return result
  }

  async recoverPending(threadWorkspace: string, primaryCheckout: string, heldThreadLease?: ThreadLeaseHandle): Promise<void> {
    for (const entry of this.journal.latestByOperation().values()) {
      if (!['publish', 'change-publish'].includes(entry.operationType) || !['prepared', 'git_applied'].includes(entry.state)) continue
      const intent = this.journal.list().find((item) => item.operationId === entry.operationId && item.state === 'prepared')
      const expected = intent?.expectedPreState as { prePublishSha: string; sourceSha: string; targetBranch: string } | undefined
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
      const result = tryGit(primaryCheckout, ['merge', '--abort'])
      if (!result.ok) throw new Error(result.stderr || 'Unable to abort publish merge')
      this.journal.append({ operationId, operationType: 'publish', state: 'cancelled' })
    })
  }
}
