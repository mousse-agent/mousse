import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import { getMousseHomeDir } from '../data/paths'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import {
  releaseExecutionLeaseHandle,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import type {
  ConversationBranchId,
  RepositoryContextData,
  ThreadWorkspaceMetadata,
  WorkspaceCapability,
  WorkspaceExecutionContext
} from '../../shared/workspace'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function capability(unavailableReason?: string): WorkspaceCapability {
  const available = !unavailableReason
  return {
    gitBacked: available,
    checkpointable: available,
    publishable: available,
    undoable: available,
    unavailableReason
  }
}

export class ThreadWorkspaceManager {
  readonly workspacePath: string
  readonly journal: ThreadJournal

  constructor(readonly threadDirectory: string) {
    this.workspacePath = join(threadDirectory, 'workspace.json')
    this.journal = new ThreadJournal(threadDirectory)
  }

  load(): ThreadWorkspaceMetadata | undefined {
    if (!existsSync(this.workspacePath)) return undefined
    return JSON.parse(readFileSync(this.workspacePath, 'utf8')) as ThreadWorkspaceMetadata
  }

  resolveRepository(projectPath: string): RepositoryContextData {
    // macOS may expose the same temporary directory as /var and /private/var.
    // Compare Git's paths only after resolving symlinks, otherwise a valid
    // repository can appear to sit outside its own top-level checkout.
    const requested = canonicalPath(projectPath)
    const identity = resolveRepositoryIdentity(requested)
    if (!identity.capability.allowed) {
      return {
        repositoryId: identity.key,
        gitTopLevel: requested,
        gitCommonDirectory: identity.commonDir,
        primaryCheckoutPath: requested,
        projectRelativeSubdirectory: '.',
        worktreeBase: '',
        capability: capability(identity.capability.reason)
      }
    }
    const topLevel = canonicalPath(git(requested, ['rev-parse', '--show-toplevel']))
    const subdirectory = relative(topLevel, requested) || '.'
    if (subdirectory.startsWith('..') || isAbsolute(subdirectory)) {
      throw new Error(`Project path is outside its Git top-level: ${requested}`)
    }
    return {
      repositoryId: identity.key,
      gitTopLevel: topLevel,
      gitCommonDirectory: identity.commonDir,
      primaryCheckoutPath: topLevel,
      projectRelativeSubdirectory: subdirectory,
      worktreeBase: join(getMousseHomeDir(), 'repositories', identity.key, 'worktrees'),
      capability: capability()
    }
  }

  async provision(
    threadId: string,
    conversationBranchId: ConversationBranchId,
    projectPath: string,
    signal?: AbortSignal
  ): Promise<ThreadWorkspaceMetadata> {
    const existing = this.load()
    if (existing?.lifecycle === 'ready') return this.verify(existing)
    const repository = this.resolveRepository(projectPath)
    if (!repository.capability.gitBacked) throw new Error(repository.capability.unavailableReason)

    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    const operationId = crypto.randomUUID()
    try {
      threadLease = await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-provision', signal })
      const identity = resolveRepositoryIdentity(repository.gitTopLevel, { requireMutationCapability: true })
      repositoryLease = await acquireRepositoryLease(identity, { signal })
      const dirty = git(repository.primaryCheckoutPath, ['status', '--porcelain=v2', '--untracked-files=all'])
      if (dirty) throw new Error('Initial thread workspace provisioning requires a clean primary checkout.')
      const head = git(repository.primaryCheckoutPath, ['rev-parse', 'HEAD'])
      const branch = `mousse/thread/${threadId}/${conversationBranchId}`
      const retainedRef = `refs/mousse/threads/${threadId}/${conversationBranchId}`
      const worktreePath = join(repository.worktreeBase, 'threads', threadId, conversationBranchId)
      mkdirSync(join(repository.worktreeBase, 'threads', threadId), { recursive: true })
      const intent = this.journal.append({
        operationId,
        operationType: 'workspace-provision',
        state: 'planned',
        expectedPreState: { head, branch, retainedRef, worktreePath }
      })
      atomicWriteJsonSync(this.workspacePath, {
        schemaVersion: 1,
        threadId,
        repositoryId: repository.repositoryId,
        conversationBranchId,
        branch,
        retainedRef,
        worktreePath,
        projectRelativeSubdirectory: repository.projectRelativeSubdirectory,
        baseSha: head,
        headSha: head,
        lifecycle: 'provisioning',
        lastVerifiedAt: new Date().toISOString()
      } satisfies ThreadWorkspaceMetadata)
      git(repository.primaryCheckoutPath, ['worktree', 'add', '-b', branch, worktreePath, head])
      git(repository.primaryCheckoutPath, ['update-ref', retainedRef, head])
      const metadata: ThreadWorkspaceMetadata = {
        schemaVersion: 1,
        threadId,
        repositoryId: repository.repositoryId,
        conversationBranchId,
        branch,
        retainedRef,
        worktreePath,
        projectRelativeSubdirectory: repository.projectRelativeSubdirectory,
        baseSha: head,
        headSha: head,
        lifecycle: 'ready',
        lastVerifiedAt: new Date().toISOString()
      }
      atomicWriteJsonSync(this.workspacePath, metadata)
      this.journal.append({
        operationId,
        operationType: 'workspace-provision',
        state: 'completed',
        details: { intentSequence: intent.sequence, head, branch, retainedRef }
      })
      return metadata
    } catch (error) {
      this.journal.append({
        operationId,
        operationType: 'workspace-provision',
        state: 'failed',
        details: { error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    } finally {
      repositoryLease?.release()
      if (threadLease) releaseExecutionLeaseHandle(threadLease)
    }
  }

  async restore(projectPath: string, signal?: AbortSignal): Promise<ThreadWorkspaceMetadata> {
    const metadata = this.load()
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    const verified = this.verify(metadata)
    if (verified.lifecycle === 'ready') return verified
    if (verified.lifecycle !== 'missing') throw new Error(`Workspace recovery is blocked: ${verified.lifecycle}`)
    const repository = this.resolveRepository(projectPath)
    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    try {
      threadLease = await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-restore', signal })
      repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repository.gitTopLevel, { requireMutationCapability: true }), { signal })
      const retained = git(repository.gitTopLevel, ['rev-parse', '--verify', metadata.retainedRef])
      const branchHead = git(repository.gitTopLevel, ['rev-parse', '--verify', metadata.branch])
      if (retained !== branchHead) throw new Error('Workspace branch and retained ref disagree; manual recovery is required.')
      mkdirSync(dirname(metadata.worktreePath), { recursive: true })
      git(repository.gitTopLevel, ['worktree', 'add', metadata.worktreePath, metadata.branch])
      return this.verify(metadata)
    } finally {
      repositoryLease?.release()
      if (threadLease) releaseExecutionLeaseHandle(threadLease)
    }
  }

  verify(metadata = this.load()): ThreadWorkspaceMetadata {
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    if (!existsSync(metadata.worktreePath)) {
      const missing = { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
      atomicWriteJsonSync(this.workspacePath, missing)
      return missing
    }
    try {
      const branch = git(metadata.worktreePath, ['branch', '--show-current'])
      const headSha = git(metadata.worktreePath, ['rev-parse', 'HEAD'])
      if (branch !== metadata.branch) throw new Error(`Expected ${metadata.branch}, found ${branch}`)
      const verified = { ...metadata, lifecycle: 'ready' as const, headSha, lastVerifiedAt: new Date().toISOString() }
      atomicWriteJsonSync(this.workspacePath, verified)
      return verified
    } catch {
      const recovery = { ...metadata, lifecycle: 'recovery_required' as const, lastVerifiedAt: new Date().toISOString() }
      atomicWriteJsonSync(this.workspacePath, recovery)
      return recovery
    }
  }

  unboundExecutionContext(threadId: string): WorkspaceExecutionContext {
    return {
      threadId,
      workspacePath: '',
      projectPath: '',
      primaryPath: '',
      lifecycle: 'unprovisioned',
      capability: capability('Thread has no project workspace')
    }
  }

  executionContext(projectPath: string): WorkspaceExecutionContext {
    const metadata = this.load()
    if (!metadata) {
      return {
        threadId: '',
        workspacePath: projectPath,
        projectPath,
        primaryPath: projectPath,
        lifecycle: 'unprovisioned',
        capability: capability('Thread workspace has not been provisioned')
      }
    }
    const relativeProject = metadata.projectRelativeSubdirectory === '.'
      ? metadata.worktreePath
      : join(metadata.worktreePath, metadata.projectRelativeSubdirectory)
    return {
      threadId: metadata.threadId,
      workspacePath: metadata.worktreePath,
      projectPath: relativeProject,
      primaryPath: projectPath,
      branch: metadata.branch,
      lifecycle: metadata.lifecycle,
      capability: metadata.lifecycle === 'ready' ? capability() : capability(`Workspace is ${metadata.lifecycle}`)
    }
  }
}
