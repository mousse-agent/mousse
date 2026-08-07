import { randomUUID } from 'node:crypto'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { git, requireClean, tryGit } from './git'

export interface PublishResult {
  operationId: string
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
    signal?: AbortSignal
  ): Promise<PublishResult> {
    return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish', async () => {
      requireClean(threadWorkspace, 'Thread workspace')
      requireClean(primaryCheckout, 'Primary checkout')
      const currentTarget = git(primaryCheckout, ['branch', '--show-current'])
      if (currentTarget !== targetBranch) throw new Error(`Primary checkout must be on ${targetBranch}, found ${currentTarget}`)
      const sourceBranch = git(threadWorkspace, ['branch', '--show-current'])
      const prePublishSha = git(primaryCheckout, ['rev-parse', 'HEAD'])
      const operationId = randomUUID()
      this.journal.append({
        operationId,
        operationType: 'publish',
        state: 'running',
        expectedPreState: { prePublishSha, targetBranch, sourceBranch }
      })
      const merged = tryGit(primaryCheckout, ['merge', '--no-ff', '--no-edit', sourceBranch])
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
      this.journal.append({
        operationId,
        operationType: 'publish',
        state: 'completed',
        details: { prePublishSha, publishSha, targetBranch, sourceBranch }
      })
      return { operationId, state: 'completed', prePublishSha, publishSha }
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
