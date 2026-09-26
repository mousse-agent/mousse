import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ExecutionContext, ExecutionWorkspaceRevision } from '../../shared/execution/types'
import { ThreadActionService } from '../actions/ThreadActionService'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { PublishService } from '../actions/PublishService'
import { ChildAgentIntegrationService } from '../agents/ChildAgentIntegrationService'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import {
  isWorkflowWorkingDirectory,
  type WorkflowWorkingDirectory,
  type WorkspaceExecutionRoot
} from '../../shared/workflows'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { getMousseHomeDir } from '../data/paths'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { DomainRpcError } from '../protocol/domainRegistry'
import { assertOwnedPath } from '../profiles/pathSafety'
import {
  heartbeatExecutionLease,
  releaseExecutionLeaseHandle,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import { WorktreeIdentity } from '../worktree/WorktreeIdentity'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'
import { WorkspaceResolver } from './WorkspaceResolver'

export interface WorkflowWorkspaceOwner {
  profileId: string
  threads: Pick<ThreadDataStore, 'getThread' | 'getThreadDir'>
  projects: Pick<ProjectManager, 'getProject'>
}

export interface OwnedThreadWorkspace {
  cwd: string
  workspacePath: string
  primaryPath: string
  gitTopLevel: string
  repositoryId: string
  threadDirectory: string
  projectRelativeSubdirectory: string
  branch?: string
}

export interface OwnedAgentWorkspace {
  cwd: string
  worktreePath: string
  kind: 'git-worktree' | 'thread-workspace' | 'scratch'
  branch?: string
  recordPath: string
  parent?: OwnedThreadWorkspace
  baseSha?: string
  retainedRef?: string
}

interface AgentWorkspaceRecord {
  version: 1
  kind: 'git-worktree' | 'scratch'
  profileId: string
  threadId: string
  projectId?: string
  idempotencyKey: string
  repositoryId?: string
  worktreePath: string
  projectCwd: string
  branch?: string
  retainedRef?: string
  baseSha?: string
  resultSha?: string
  receiptId?: string
  lifecycle: 'ready'
}

const occupancyTails = new Map<string, Promise<unknown>>()

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

function pathsEqual(left: string, right: string): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(candidate))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function agentWorktreeId(profileId: string, threadId: string, idempotencyKey: string): string {
  return `wf-${digestIdentity(`${profileId}:${threadId}:${idempotencyKey}`).slice(0, 40)}`
}

function liveBinding(
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>
) {
  if (context.profileId !== owner.profileId) {
    throw new DomainRpcError('profile_mismatch', 'Workflow workspace belongs to another profile')
  }
  const thread = owner.threads.getThread(context.threadId)
  if (!thread || thread.id !== context.threadId || thread.settledAt || thread.projectId !== context.projectId) {
    throw new DomainRpcError('thread_unavailable', 'Workflow thread ownership changed')
  }
  const project = context.projectId ? owner.projects.getProject(context.projectId) : undefined
  if (context.projectId && !project) {
    throw new DomainRpcError('project_unavailable', 'Workflow project was removed')
  }
  return { thread, project }
}

function listedWorktree(gitTopLevel: string, worktreePath: string): boolean {
  const listed = git(gitTopLevel, ['worktree', 'list', '--porcelain'])
  const wanted = canonicalPath(worktreePath)
  return listed.split(/\r?\n/).some((line) => {
    if (!line.startsWith('worktree ')) return false
    return pathsEqual(line.slice(9), wanted)
  })
}

export async function withSerializedWorkspace<T>(cwd: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const key = canonicalPath(cwd)
  const previous = occupancyTails.get(key) ?? Promise.resolve()
  let result: T
  let started = false
  const next = previous.catch(() => undefined).then(async () => {
    started = true
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    result = await work()
  })
  occupancyTails.set(key, next)
  // Keep queue cleanup owned by the queued operation even when its caller is
  // released immediately by cancellation while another operation still holds cwd.
  void next.finally(() => {
    if (occupancyTails.get(key) === next) occupancyTails.delete(key)
  }).catch(() => undefined)
  try {
    if (!signal) await next
    else await new Promise<void>((resolveWait, reject) => {
      // Once dispatch has started, cancellation belongs to the underlying
      // runner and this promise must retain ownership until raw settlement.
      const abort = () => { if (!started) reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      void next.then(
        () => { signal.removeEventListener('abort', abort); resolveWait() },
        (error) => { signal.removeEventListener('abort', abort); reject(error) }
      )
    })
    return result!
  } finally { /* queue cleanup remains attached to next */ }
}

export async function resolveOwnedThreadWorkspace(
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  signal?: AbortSignal
): Promise<OwnedThreadWorkspace> {
  if (signal?.aborted) throw new DomainRpcError('cancelled', 'Workflow workspace resolution cancelled')
  const { project } = liveBinding(owner, context)
  if (!project) throw new DomainRpcError('project_required', 'Thread workspace requires a project')
  const projectPath = canonicalPath(project.path)
  const threadDirectory = owner.threads.getThreadDir(context.threadId)
  const manager = new ThreadWorkspaceManager(threadDirectory)
  const repository = manager.resolveRepository(projectPath)
  if (!repository.capability.gitBacked) {
    throw new DomainRpcError(
      'executor_unavailable',
      repository.capability.unavailableReason ?? 'Thread workspace requires a Git repository'
    )
  }
  let existing = manager.load()
  if (existing) {
    validateThreadWorkspaceMetadata(manager, existing, repository, context.threadId)
    const pending = [...manager.journal.latestByOperation().values()].some((entry) =>
      ['action-checkpoint', 'change-checkpoint', 'child-integration', 'change-integration', 'publish', 'change-publish', 'code-revert', 'change-revert'].includes(entry.operationType)
      && ['running', 'prepared', 'git_applied'].includes(entry.state))
    if (pending) {
      const lease = await waitAcquireExecutionLease(threadDirectory, { source: 'workflow-workspace-recovery', signal, maxAttempts: 36_000 })
      try {
        await new ChildAgentIntegrationService(threadDirectory).recoverPending(existing.worktreePath, lease)
        await new PublishService(threadDirectory).recoverPending(existing.worktreePath, repository.primaryCheckoutPath, lease)
        await new ThreadActionService(threadDirectory).recoverPending(existing.worktreePath, lease)
        await new CodeRevertService(threadDirectory).recoverPending(existing.worktreePath, lease)
        existing = manager.load()!
      } finally { releaseExecutionLeaseHandle(lease) }
    }
    const verified = manager.verify(existing)
    if (verified.lifecycle !== 'ready') {
      throw new DomainRpcError('thread_unavailable', `Thread workspace is stale (${verified.lifecycle})`)
    }
    if (verified.repositoryId !== repository.repositoryId) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace is bound to a different repository')
    }
    liveBinding(owner, context)
    const execution = manager.executionContext(projectPath)
    if (!execution.workspacePath || pathsEqual(execution.workspacePath, repository.primaryCheckoutPath)) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace must not be the primary checkout')
    }
    const cwd = validateThreadWorkspacePaths(execution.workspacePath, execution.projectPath, repository)
    return {
      cwd,
      workspacePath: execution.workspacePath,
      primaryPath: execution.primaryPath,
      gitTopLevel: repository.gitTopLevel,
      repositoryId: repository.repositoryId,
      threadDirectory,
      projectRelativeSubdirectory: verified.projectRelativeSubdirectory,
      branch: execution.branch
    }
  }
  const execution = await new WorkspaceResolver(threadDirectory, context.threadId, projectPath).resolve('agent', 'main', signal)
  liveBinding(owner, context)
  if (execution.lifecycle !== 'ready' || !execution.capability.gitBacked) {
    throw new DomainRpcError(
      'executor_unavailable',
      execution.capability.unavailableReason ?? 'Thread workspace is unavailable'
    )
  }
  if (!execution.workspacePath || pathsEqual(execution.workspacePath, execution.primaryPath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace must not be the primary checkout')
  }
  const metadata = manager.load()
  if (!metadata || metadata.lifecycle !== 'ready') {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace provisioning did not become ready')
  }
  validateThreadWorkspaceMetadata(manager, metadata, repository, context.threadId)
  const cwd = validateThreadWorkspacePaths(execution.workspacePath, execution.projectPath, repository)
  return {
    cwd,
    workspacePath: execution.workspacePath,
    primaryPath: execution.primaryPath,
    gitTopLevel: repository.gitTopLevel,
    repositoryId: repository.repositoryId,
    threadDirectory,
    projectRelativeSubdirectory: metadata.projectRelativeSubdirectory,
    branch: execution.branch
  }
}

function validateThreadWorkspaceMetadata(
  manager: ThreadWorkspaceManager,
  metadata: ReturnType<ThreadWorkspaceManager['load']> & {},
  repository: ReturnType<ThreadWorkspaceManager['resolveRepository']>,
  threadId: string
): void {
  if (lstatSync(manager.workspacePath).isSymbolicLink() || statSync(manager.workspacePath).size > 64 * 1024) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace metadata is not a bounded regular file')
  }
  const branchId = metadata.conversationBranchId
  if (typeof branchId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(branchId)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace branch identity is invalid')
  }
  const expectedPath = join(repository.worktreeBase, 'threads', threadId, branchId)
  const expectedBranch = `mousse/thread/${threadId}/${branchId}`
  const expectedRef = `refs/mousse/threads/${threadId}/${branchId}`
  if (
    metadata.threadId !== threadId ||
    metadata.repositoryId !== repository.repositoryId ||
    metadata.projectRelativeSubdirectory !== repository.projectRelativeSubdirectory ||
    !pathsEqual(metadata.worktreePath, expectedPath) ||
    metadata.branch !== expectedBranch ||
    metadata.retainedRef !== expectedRef
  ) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace metadata does not match the live project binding')
  }
  if (!pathInside(repository.worktreeBase, metadata.worktreePath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace path is outside the repository workspace root')
  }
}

function validateThreadWorkspacePaths(
  worktreePath: string,
  projectCwd: string,
  repository: ReturnType<ThreadWorkspaceManager['resolveRepository']>
): string {
  if (!listedWorktree(repository.gitTopLevel, worktreePath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace is not registered with the live repository')
  }
  if (resolveRepositoryIdentity(worktreePath).key !== repository.repositoryId) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace belongs to another repository')
  }
  const worktree = canonicalPath(worktreePath)
  const cwd = canonicalPath(projectCwd)
  if (!pathInside(worktree, cwd) || pathsEqual(worktree, repository.primaryCheckoutPath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace project path escapes its registered worktree')
  }
  return cwd
}

export async function resolveScriptWorkingDirectory(input: {
  owner: WorkflowWorkspaceOwner
  workingDirectory: WorkflowWorkingDirectory
  context: ExecutionContext
  stagingDir: string
  sandboxRoot?: string
  signal: AbortSignal
}): Promise<WorkspaceExecutionRoot> {
  if (input.signal.aborted) throw new DomainRpcError('cancelled', 'Workflow script cancelled')
  liveBinding(input.owner, input.context)
  if (input.workingDirectory === 'run-staging') {
    mkdirSync(input.stagingDir, { recursive: true })
    return { cwd: canonicalPath(input.stagingDir) }
  }
  if (input.workingDirectory === 'profile-sandbox') {
    if (!input.sandboxRoot?.trim()) {
      throw new DomainRpcError('executor_unavailable', 'profile-sandbox is unavailable: no supported isolation backend')
    }
    return { cwd: canonicalPath(input.sandboxRoot) }
  }
  const thread = await resolveOwnedThreadWorkspace(input.owner, input.context, input.signal)
  liveBinding(input.owner, input.context)
  return {
    cwd: thread.cwd,
    acquireMutationLease: (signal) => acquireWorkspaceMutationLease(input.owner, input.context, thread, signal)
  }
}

export async function acquireWorkspaceMutationLease(
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'> & Partial<Pick<ExecutionContext, 'runId' | 'turnId'>>,
  workspace: OwnedThreadWorkspace,
  signal: AbortSignal
): Promise<{ complete(state: 'completed' | 'failed' | 'stopped'): Promise<ExecutionWorkspaceRevision>; release(): boolean }> {
  let threadLease: ThreadLeaseHandle | undefined
  try {
    threadLease = await waitAcquireExecutionLease(workspace.threadDirectory, {
      source: 'workflow-script-workspace', signal, maxAttempts: 36_000
    })
    liveBinding(owner, context)
    // The thread lease covers the writer lifetime. Repository leases are taken
    // only by checkpoint/integration operations, never across model or process work.
    let startSha = git(workspace.workspacePath, ['rev-parse', 'HEAD'])
    if (git(workspace.workspacePath, ['status', '--porcelain', '--untracked-files=all'])) {
      const before = await new ThreadActionService(workspace.threadDirectory).checkpointExistingTurn({
        threadId: context.threadId, turnId: `workflow-input:${crypto.randomUUID()}`,
        conversationBranchId: new ThreadWorkspaceManager(workspace.threadDirectory).load()?.conversationBranchId ?? 'main', workspacePath: workspace.workspacePath,
        presentationMessageStart: 0, presentationMessageEnd: 0,
        nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
        actor: { kind: 'workflow', id: context.runId }, runId: context.runId, heldThreadLease: threadLease
      }, startSha, 'completed')
      startSha = before.endSha
    }
    const turnId = `${context.turnId ?? context.runId ?? 'workflow'}:${crypto.randomUUID()}`
    const conversationBranchId = new ThreadWorkspaceManager(workspace.threadDirectory).load()?.conversationBranchId ?? 'main'
    new ThreadActionService(workspace.threadDirectory).beginTurn({
      threadId: context.threadId, turnId, conversationBranchId, workspacePath: workspace.workspacePath,
      presentationMessageStart: 0, presentationMessageEnd: 0,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
      actor: { kind: 'workflow', id: context.runId }, runId: context.runId, heldThreadLease: threadLease
    }, startSha)
    let revision: ExecutionWorkspaceRevision | undefined
    let healthy = true
    let released = false
    const heartbeat = setInterval(() => {
      healthy = heartbeatExecutionLease(threadLease!) && healthy
    }, 10_000)
    heartbeat.unref()
    return {
      complete: async (state) => {
        if (released) throw new Error('Workspace writer lease was released before checkpoint')
        if (revision) return revision
        const action = await new ThreadActionService(workspace.threadDirectory).checkpointExistingTurn({
          threadId: context.threadId, turnId, conversationBranchId,
          workspacePath: workspace.workspacePath,
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
          actor: { kind: 'workflow', id: context.runId }, runId: context.runId,
          heldThreadLease: threadLease,
          externalEffects: [{ kind: 'unknown', description: 'Workflow execution may include process or external effects; code undo does not reverse them.', reversible: false }]
        }, startSha, state)
        const metadata = new ThreadWorkspaceManager(workspace.threadDirectory).load()
        revision = { workspaceId: metadata?.workspaceId ?? context.threadId, readSha: startSha,
          writeSha: action.endSha, receiptId: action.receiptId, generation: metadata?.generation }
        return revision
      },
      release: () => {
        if (released) return healthy
        released = true
        clearInterval(heartbeat)
        const threadReleased = releaseExecutionLeaseHandle(threadLease!)
        return healthy && threadReleased
      }
    }
  } catch (error) {
    if (threadLease) releaseExecutionLeaseHandle(threadLease)
    throw error
  }
}

/** Complete isolated output through the same attributed integration as chat. */
export async function integrateOwnedAgentWorkspace(input: {
  owner: WorkflowWorkspaceOwner
  context: ExecutionContext
  workspace: OwnedAgentWorkspace
  revision: ExecutionWorkspaceRevision
  idempotencyKey: string
  signal?: AbortSignal
}): Promise<ExecutionWorkspaceRevision> {
  const { workspace, context } = input
  if (workspace.kind !== 'git-worktree' || !workspace.parent || !workspace.baseSha || !workspace.branch) return input.revision
  const record = readAgentRecord(workspace.recordPath, context, input.idempotencyKey)
  if (!record) throw new DomainRpcError('unknown_effect', 'Workflow child result has no durable workspace record')
  const resultSha = input.revision.writeSha
  await withGitMutationLocks(`${workspace.recordPath}.changes`, workspace.worktreePath, 'workflow-result-pin', () => {
    if (git(workspace.worktreePath, ['rev-parse', 'HEAD']) !== resultSha) throw new Error('Worker result revision changed')
    if (workspace.retainedRef) git(workspace.worktreePath, ['update-ref', workspace.retainedRef, resultSha])
    writeAgentRecord(workspace.recordPath, { ...record, resultSha, receiptId: input.revision.receiptId })
  }, input.signal)
  const parent = workspace.parent
  const lease = await waitAcquireExecutionLease(parent.threadDirectory, { source: 'workflow-integration', signal: input.signal })
  try {
    liveBinding(input.owner, context)
    const metadata = new ThreadWorkspaceManager(parent.threadDirectory).load()
    const expected = git(parent.workspacePath, ['rev-parse', 'HEAD'])
    if (resultSha === workspace.baseSha) return { workspaceId: metadata?.workspaceId ?? context.threadId,
      readSha: workspace.baseSha, writeSha: expected, generation: metadata?.generation }
    const integration = await new ChildAgentIntegrationService(parent.threadDirectory).integrate({
      agentId: agentWorktreeId(context.profileId, context.threadId, input.idempotencyKey),
      operationId: `workflow-integration:${input.idempotencyKey}`,
      workerWorktree: workspace.worktreePath, workerBranch: workspace.branch,
      spawnBaseSha: workspace.baseSha, expectedWorkerHead: resultSha,
      threadWorkspace: parent.workspacePath, expectedDestinationHead: expected,
      externalEffects: new ChangeReceiptService(`${workspace.recordPath}.changes`).list()
        .find((receipt) => receipt.id === input.revision.receiptId)?.externalEffects ?? [],
      actor: { kind: 'workflow', id: context.runId }, runId: context.runId,
      turnId: context.turnId, heldThreadLease: lease, signal: input.signal
    })
    return { workspaceId: metadata?.workspaceId ?? context.threadId, readSha: workspace.baseSha,
      writeSha: integration.integrationSha, receiptId: integration.receiptId,
      generation: new ThreadWorkspaceManager(parent.threadDirectory).load()?.generation }
  } finally { releaseExecutionLeaseHandle(lease) }
}

export function isWorkflowRevisionCurrent(
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  revision: ExecutionWorkspaceRevision
): boolean {
  liveBinding(owner, context)
  const directory = owner.threads.getThreadDir(context.threadId)
  const metadata = new ThreadWorkspaceManager(directory).load()
  if (!metadata || (metadata.workspaceId ?? context.threadId) !== revision.workspaceId) return false
  const receipts = new ChangeReceiptService(directory).list()
  const observedGeneration = revision.generation ?? receipts.find((receipt) => receipt.id === revision.receiptId)?.generation
  // Undo does not erase objects: ancestry alone cannot identify stale output.
  // A compensation invalidates prior observations even if a later redo restores code.
  return !receipts.some((receipt) => {
    if (receipt.kind !== 'undo' && receipt.kind !== 'revert') return false
    if (observedGeneration !== undefined && receipt.generation <= observedGeneration) return false
    const undone = receipts.find((candidate) => candidate.id === receipt.reversesReceiptId)
    if (!undone) return false
    const covered = new Set<string>()
    const pending = [undone]
    while (pending.length) {
      const current = pending.pop()!
      if (covered.has(current.id)) continue
      covered.add(current.id)
      if (current.id === revision.receiptId || current.afterSha === revision.readSha || current.afterSha === revision.writeSha) return true
      for (const contribution of current.contributions) {
        const dependency = receipts.find((item) => item.id === contribution.receiptId)
        if (dependency) pending.push(dependency)
        if (contribution.resultSha === revision.readSha || contribution.resultSha === revision.writeSha) return true
      }
    }
    // A later verification can observe a descendant of the reversed change.
    if (undone.beforeSha !== undone.afterSha) {
      try {
        git(metadata.worktreePath, ['merge-base', '--is-ancestor', undone.afterSha, revision.readSha])
        return true
      } catch { /* not a dependent revision */ }
    }
    return false
  })
}

export async function provisionOwnedAgentWorkspace(input: {
  owner: WorkflowWorkspaceOwner
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>
  idempotencyKey: string
  registrationRoot: string
  scratchRoot: string
  signal?: AbortSignal
  isolated?: boolean
}): Promise<OwnedAgentWorkspace> {
  if (input.signal?.aborted) throw new DomainRpcError('cancelled', 'Workflow agent workspace cancelled')
  const { project } = liveBinding(input.owner, input.context)
  const digest = /^[a-f0-9]{64}$/i.test(input.idempotencyKey)
    ? input.idempotencyKey.toLowerCase()
    : digestIdentity(input.idempotencyKey)
  const recordPath = join(input.registrationRoot, `${digest}.json`)
  assertOwnedPath(input.registrationRoot, recordPath)
  const existing = readAgentRecord(recordPath, input.context, input.idempotencyKey)
  const repository = project ? resolveRepositoryIdentity(project.path) : undefined
  if (!project || (repository && !repository.capability.allowed && repository.capability.reason === 'not-a-repository')) {
    const scratch = join(input.scratchRoot, digest)
    assertOwnedPath(input.scratchRoot, scratch)
    mkdirSync(scratch, { recursive: true })
    const cwd = canonicalPath(scratch)
    if (!pathInside(input.scratchRoot, cwd)) {
      throw new DomainRpcError('executor_unavailable', 'Workflow agent scratch path escapes its owned root')
    }
    if (existing && (existing.kind !== 'scratch' || !pathsEqual(existing.worktreePath, scratch) || !pathsEqual(existing.projectCwd, cwd))) {
      throw new DomainRpcError('profile_mismatch', 'Workflow agent scratch record does not match its owned path')
    }
    atomicWriteJsonSync(recordPath, {
      version: 1,
      kind: 'scratch',
      profileId: input.context.profileId,
      threadId: input.context.threadId,
      projectId: input.context.projectId,
      idempotencyKey: input.idempotencyKey,
      worktreePath: cwd,
      projectCwd: cwd,
      lifecycle: 'ready'
    } satisfies AgentWorkspaceRecord)
    return { cwd, worktreePath: cwd, kind: 'scratch', recordPath }
  }
  const thread = await resolveOwnedThreadWorkspace(input.owner, input.context, input.signal)
  if (input.isolated === false) {
    return { cwd: thread.cwd, worktreePath: thread.workspacePath, kind: 'thread-workspace',
      branch: thread.branch, recordPath, parent: thread }
  }
  if (existing?.kind === 'git-worktree') {
    const reused = reuseAgentWorktree(existing, thread, input.owner, input.context, input.idempotencyKey)
    if (reused) return { ...reused, recordPath, parent: thread, baseSha: existing.baseSha, retainedRef: existing.retainedRef }
  } else if (existing) {
    throw new DomainRpcError('profile_mismatch', 'Workflow agent workspace kind changed for this invocation')
  }
  return createAgentWorktree({
    owner: input.owner,
    context: input.context,
    idempotencyKey: input.idempotencyKey,
    recordPath,
    thread,
    signal: input.signal
  })
}

function readAgentRecord(
  path: string,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  idempotencyKey: string
): AgentWorkspaceRecord | undefined {
  if (!existsSync(path)) return undefined
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) {
    throw new DomainRpcError('profile_mismatch', 'Workflow agent workspace record is not a bounded regular file')
  }
  const record = JSON.parse(readFileSync(path, 'utf8')) as AgentWorkspaceRecord
  if (
    record.version !== 1 ||
    record.profileId !== context.profileId ||
    record.threadId !== context.threadId ||
    (record.projectId ?? undefined) !== context.projectId ||
    record.idempotencyKey !== idempotencyKey ||
    record.lifecycle !== 'ready'
  ) {
    throw new DomainRpcError('profile_mismatch', 'Workflow agent workspace identity does not match this invocation')
  }
  return record
}

function reuseAgentWorktree(
  record: AgentWorkspaceRecord,
  thread: OwnedThreadWorkspace,
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  idempotencyKey: string
): Omit<OwnedAgentWorkspace, 'recordPath'> | undefined {
  liveBinding(owner, context)
  const agentId = agentWorktreeId(context.profileId, context.threadId, idempotencyKey)
  const ownerDigest = digestIdentity(`${context.profileId}:${context.threadId}`).slice(0, 24)
  const worktreesBase = join(getMousseHomeDir(), 'wf', thread.repositoryId.slice(0, 16), ownerDigest)
  const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
  const expectedRef = `refs/mousse/workflows/${context.profileId}/${context.threadId}/${agentId}`
  const expectedCwd = projectCwd(identity.path, thread.projectRelativeSubdirectory)
  if (
    record.repositoryId !== thread.repositoryId ||
    record.branch !== identity.branch ||
    record.retainedRef !== expectedRef ||
    !pathsEqual(record.worktreePath, identity.path) ||
    !pathsEqual(record.projectCwd, expectedCwd)
  ) {
    throw new DomainRpcError('thread_unavailable', 'Workflow agent workspace is bound to a different repository')
  }
  if (!existsSync(record.worktreePath) || !listedWorktree(thread.gitTopLevel, record.worktreePath)) return undefined
  const branch = git(record.worktreePath, ['branch', '--show-current'])
  if (branch !== identity.branch || resolveRepositoryIdentity(record.worktreePath).key !== thread.repositoryId) {
    throw new DomainRpcError('thread_unavailable', 'Workflow agent worktree branch changed')
  }
  return {
    cwd: record.projectCwd,
    worktreePath: record.worktreePath,
    kind: 'git-worktree',
    branch: record.branch
  }
}

async function createAgentWorktree(input: {
  owner: WorkflowWorkspaceOwner
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>
  idempotencyKey: string
  recordPath: string
  thread: OwnedThreadWorkspace
  signal?: AbortSignal
}): Promise<OwnedAgentWorkspace> {
  const agentId = agentWorktreeId(input.context.profileId, input.context.threadId, input.idempotencyKey)
  // Keep the registered worktree path short enough for Windows while retaining
  // stable ownership identity in the profile/thread keyed directory and record.
  const ownerDigest = digestIdentity(`${input.context.profileId}:${input.context.threadId}`).slice(0, 24)
  const worktreesBase = join(getMousseHomeDir(), 'wf', input.thread.repositoryId.slice(0, 16), ownerDigest)
  const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
  const retainedRef = `refs/mousse/workflows/${input.context.profileId}/${input.context.threadId}/${agentId}`
  let threadLease: ThreadLeaseHandle | undefined
  let repositoryLease: RepositoryLeaseHandle | undefined
  try {
    threadLease = await waitAcquireExecutionLease(input.thread.threadDirectory, {
      source: 'workflow-agent-worktree',
      signal: input.signal
    })
    if (git(input.thread.workspacePath, ['status', '--porcelain', '--untracked-files=all'])) {
      const head = git(input.thread.workspacePath, ['rev-parse', 'HEAD'])
      await new ThreadActionService(input.thread.threadDirectory).checkpointExistingTurn({
        threadId: input.context.threadId, turnId: `workflow-base:${input.idempotencyKey}`,
        conversationBranchId: new ThreadWorkspaceManager(input.thread.threadDirectory).load()?.conversationBranchId ?? 'main', workspacePath: input.thread.workspacePath,
        presentationMessageStart: 0, presentationMessageEnd: 0,
        nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
        actor: { kind: 'workflow', id: input.idempotencyKey }, heldThreadLease: threadLease
      }, head, 'completed')
    }
    const baseSha = git(input.thread.workspacePath, ['rev-parse', 'HEAD'])
    const repoIdentity = resolveRepositoryIdentity(input.thread.gitTopLevel, { requireMutationCapability: true })
    repositoryLease = await acquireRepositoryLease(repoIdentity, { signal: input.signal })
    liveBinding(input.owner, input.context)
    mkdirSync(worktreesBase, { recursive: true })
    if (existsSync(identity.path) && listedWorktree(input.thread.gitTopLevel, identity.path)) {
      throw new DomainRpcError('unknown_effect', 'Unrecorded workflow worktree exists; preserve it for recovery')
    }
    let branchExists = false
    try {
      git(input.thread.gitTopLevel, ['show-ref', '--verify', `refs/heads/${identity.branch}`])
      branchExists = true
    } catch {
      branchExists = false
    }
    if (existsSync(identity.path)) {
      throw new DomainRpcError('executor_unavailable', `Refusing to reuse unmanaged agent worktree path: ${identity.path}`)
    }
    if (branchExists) {
      throw new DomainRpcError('unknown_effect', 'Workflow agent branch exists without its owned record')
    } else {
      git(input.thread.workspacePath, ['worktree', 'add', '-b', identity.branch, identity.path, baseSha])
    }
    git(input.thread.gitTopLevel, ['update-ref', retainedRef, git(identity.path, ['rev-parse', 'HEAD'])])
    const cwd = projectCwd(identity.path, input.thread.projectRelativeSubdirectory)
    writeAgentRecord(input.recordPath, {
      version: 1,
      kind: 'git-worktree',
      profileId: input.context.profileId,
      threadId: input.context.threadId,
      projectId: input.context.projectId,
      idempotencyKey: input.idempotencyKey,
      repositoryId: input.thread.repositoryId,
      worktreePath: identity.path,
      projectCwd: cwd,
      branch: identity.branch,
      retainedRef,
      baseSha,
      lifecycle: 'ready'
    })
    return { cwd, worktreePath: identity.path, kind: 'git-worktree', branch: identity.branch, recordPath: input.recordPath,
      parent: input.thread, baseSha, retainedRef }
  } finally {
    repositoryLease?.release()
    if (threadLease) releaseExecutionLeaseHandle(threadLease)
  }
}

function projectCwd(worktreePath: string, subdirectory: string): string {
  const worktree = canonicalPath(worktreePath)
  const cwd = canonicalPath(!subdirectory || subdirectory === '.' ? worktree : join(worktree, subdirectory))
  if (!pathInside(worktree, cwd)) {
    throw new DomainRpcError('executor_unavailable', 'Workflow agent project path is outside its worktree')
  }
  return cwd
}

function writeAgentRecord(path: string, record: AgentWorkspaceRecord): void {
  atomicWriteJsonSync(path, record)
}

export function assertWorkflowWorkingDirectory(value: unknown): WorkflowWorkingDirectory {
  if (!isWorkflowWorkingDirectory(value)) {
    throw new DomainRpcError('invalid_input', 'script.workingDirectory must be thread-workspace, run-staging, or profile-sandbox')
  }
  return value
}
