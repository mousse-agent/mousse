import { randomUUID } from 'node:crypto'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

import { ChangeReceiptService } from './ChangeReceiptService'
import { ThreadActionService } from './ThreadActionService'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'

export interface PublishOptions {
  operationId?: string
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
      const previous = options.operationId && this.journal.latestByOperation().get(options.operationId)
      if (previous?.state === 'completed') {
        const result = previous.details as PublishResult
        if (result.sourceSha !== expectedSourceSha || result.prePublishSha !== expectedTargetSha) throw new Error('Publish operation identity was reused for different revisions.')
        return result
      }
      const receipts = new ChangeReceiptService(this.threadDirectory)
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
        expectedPreState: { prePublishSha, targetBranch, sourceBranch, sourceSha: expectedSourceSha }
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
      const publishedReceiptIds = receipts.list().filter((item) => item.kind !== 'publish' && tryGit(threadWorkspace, ['merge-base', '--is-ancestor', item.afterSha, expectedSourceSha]).ok).map((item) => item.id)
      const receipt = receipts.record(primaryCheckout, { operationId, kind: 'publish', actor: { kind: 'user' }, beforeSha: prePublishSha, afterSha: publishSha, introducedCommits: prePublishSha === publishSha ? [] : [publishSha], contributions: [{ baseSha: expectedTargetSha, resultSha: expectedSourceSha }], externalEffects: [], publishedReceiptIds })
      const result: PublishResult = { operationId, state: 'completed', prePublishSha, publishSha, sourceSha: expectedSourceSha, receiptId: receipt.id }
      this.journal.append({ operationId, operationType: 'publish', state: 'completed', details: result })
      return result
    }, signal)
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
