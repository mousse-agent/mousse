import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
import { getThreadLifecycleGate } from '../queue/ThreadLifecycleAdmission'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
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
    signal?: AbortSignal,
    heldThreadLease?: ThreadLeaseHandle
  ): Promise<ThreadWorkspaceMetadata> {
    const existing = this.load()
    if (existing?.lifecycle === 'ready') return this.verify(existing)
    const repository = this.resolveRepository(projectPath)
    if (!repository.capability.gitBacked) throw new Error(repository.capability.unavailableReason)

    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    const operationId = crypto.randomUUID()
    try {
      if (heldThreadLease) assertHeldThreadLease(this.threadDirectory, heldThreadLease)
      threadLease = heldThreadLease ?? await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-provision', signal })
      const identity = resolveRepositoryIdentity(repository.gitTopLevel, { requireMutationCapability: true })
      repositoryLease = await acquireRepositoryLease(identity, { signal })
      // Another waiter may have provisioned while this call was acquiring ownership.
      const provisioned = this.load()
      if (provisioned?.lifecycle === 'ready') return this.verify(provisioned)
      if (provisioned) throw new Error(`Workspace provisioning requires recovery: ${provisioned.lifecycle}`)
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
        workspaceId: `${repository.repositoryId}:${threadId}`,
        generation: 0,
        provenance: { ownerThreadId: threadId },
        integrationTarget: { checkoutPath: repository.primaryCheckoutPath, baseSha: head },
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
        workspaceId: `${repository.repositoryId}:${threadId}`,
        generation: 0,
        provenance: { ownerThreadId: threadId },
        integrationTarget: { checkoutPath: repository.primaryCheckoutPath, baseSha: head },
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
      if (threadLease && !heldThreadLease) releaseExecutionLeaseHandle(threadLease)
    }
  }

  hasReconstructionManifest(metadata = this.load()): boolean {
    const gate = getThreadLifecycleGate(this.threadDirectory)
    return Boolean(metadata && gate instanceof ResourceLifecycleStore && existsSync(new WorktreeRetirementService(gate).pathFor(metadata.threadId, metadata.worktreePath)))
  }

  async restore(projectPath: string, signal?: AbortSignal, heldThreadLease?: ThreadLeaseHandle): Promise<ThreadWorkspaceMetadata> {
    const metadata = this.load()
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    const verified = this.verify(metadata)
    const unfinishedProvision = [...this.journal.latestByOperation().values()].some((entry) => entry.operationType === 'workspace-provision' && !['completed', 'cancelled'].includes(entry.state))
    if (verified.lifecycle === 'ready' && metadata.lifecycle === 'ready' && !unfinishedProvision) return verified
    if (verified.lifecycle !== 'missing' && verified.lifecycle !== 'ready') throw new Error(`Workspace recovery is blocked: ${verified.lifecycle}`)
    const repository = this.resolveRepository(projectPath)
    if (repository.repositoryId !== metadata.repositoryId) throw new Error('Workspace recovery repository identity changed.')
    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    try {
      if (heldThreadLease) assertHeldThreadLease(this.threadDirectory, heldThreadLease)
      threadLease = heldThreadLease ?? await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-restore', signal })
      repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repository.gitTopLevel, { requireMutationCapability: true }), { signal })
      if (verified.lifecycle === 'ready') {
        const ready = this.verify(metadata)
        if (ready.lifecycle !== 'ready') throw new Error('Workspace changed while acquiring recovery ownership.')
        git(ready.worktreePath, ['update-ref', ready.retainedRef, ready.headSha])
        atomicWriteJsonSync(this.workspacePath, ready)
        this.finishProvisionRecovery(ready)
        return ready
      }
      const gate = getThreadLifecycleGate(this.threadDirectory)
      if (gate instanceof ResourceLifecycleStore && this.hasReconstructionManifest(metadata)) {
        const retirement = new WorktreeRetirementService(gate, { taskLease: threadLease, repositoryLease })
        const manifestPath = retirement.pathFor(metadata.threadId, metadata.worktreePath)
        const manifest = retirement.load(manifestPath)
        if (manifest.branch !== metadata.branch || manifest.resultSha !== metadata.headSha || manifest.repositoryId !== metadata.repositoryId) throw new Error('Retired workspace manifest disagrees with authoritative task binding')
        retirement.reconstruct(manifestPath)
        const restored = this.verify(metadata)
        if (restored.lifecycle !== 'ready') throw new Error('Reconstructed task workspace failed verification')
        atomicWriteJsonSync(this.workspacePath, restored)
        return restored
      }
      const retained = git(repository.gitTopLevel, ['rev-parse', '--verify', metadata.retainedRef])
      const branchHead = git(repository.gitTopLevel, ['rev-parse', '--verify', metadata.branch])
      if (retained !== branchHead) throw new Error('Workspace branch and retained ref disagree; manual recovery is required.')
      mkdirSync(dirname(metadata.worktreePath), { recursive: true })
      git(repository.gitTopLevel, ['worktree', 'add', metadata.worktreePath, metadata.branch])
      const restored = this.verify(metadata)
      atomicWriteJsonSync(this.workspacePath, restored)
      this.finishProvisionRecovery(restored)
      return restored
    } finally {
      repositoryLease?.release()
      if (threadLease && !heldThreadLease) releaseExecutionLeaseHandle(threadLease)
    }
  }

  private finishProvisionRecovery(metadata: ThreadWorkspaceMetadata): void {
    for (const operation of this.journal.latestByOperation().values()) {
      if (operation.operationType !== 'workspace-provision' || ['completed', 'cancelled'].includes(operation.state)) continue
      const intent = this.journal.list().find((entry) => entry.operationId === operation.operationId && entry.expectedPreState)
      const expected = intent?.expectedPreState as { worktreePath?: string; branch?: string } | undefined
      if (expected?.worktreePath !== metadata.worktreePath || expected.branch !== metadata.branch) continue
      this.journal.append({ operationId: operation.operationId, operationType: 'workspace-provision', state: 'completed', details: { recovered: true, head: metadata.headSha, branch: metadata.branch, retainedRef: metadata.retainedRef } })
    }
  }

  verify(metadata = this.load()): ThreadWorkspaceMetadata {
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    if (!existsSync(metadata.worktreePath)) {
      const missing = { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
      return missing
    }
    try {
      const branch = git(metadata.worktreePath, ['branch', '--show-current'])
      const headSha = git(metadata.worktreePath, ['rev-parse', 'HEAD'])
      if (branch !== metadata.branch) throw new Error(`Expected ${metadata.branch}, found ${branch}`)
      if (headSha !== metadata.headSha) throw new Error('Workspace HEAD moved outside a recorded operation.')
      const verified = { ...metadata, lifecycle: 'ready' as const, headSha, lastVerifiedAt: new Date().toISOString() }
      return verified
    } catch {
      const recovery = { ...metadata, lifecycle: 'recovery_required' as const, lastVerifiedAt: new Date().toISOString() }
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

  executionContext(projectPath: string, metadata = this.load()): WorkspaceExecutionContext {
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
      workspaceId: metadata.workspaceId ?? `${metadata.repositoryId}:${metadata.threadId}`,
      generation: metadata.generation ?? 0,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      provenance: metadata.provenance ?? { ownerThreadId: metadata.threadId },
      lifecycle: metadata.lifecycle,
      capability: metadata.lifecycle === 'ready' ? capability() : capability(`Workspace is ${metadata.lifecycle}`)
    }
  }
}
