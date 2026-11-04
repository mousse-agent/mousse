import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { access, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExecutionContext, ExecutionWorkspaceRevision } from '../../shared/execution/types'
import { ThreadActionService } from '../actions/ThreadActionService'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { PublishService } from '../actions/PublishService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import { movedFilesNotice, moveFilesAsync, sameTreeAsync, takeSnapshotAsync } from '../actions/snapshots'
import { gitAsync } from '../actions/git'
import { cancelPendingIntegrations, cancelledIntegrationsNotice } from '../agents/ChildAgentIntegrationService'
import { buildSubagentResultReportAsync } from '../agents/subagentResultReport'
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
import { assertWorktreeFolderConnected, chosenFolderPlace, chosenWorktreeFolder, defaultThreadWorktreePath, defaultWorkflowAgentWorktreeBase, isThreadWorktreePlace, isWorkflowAgentWorktreePlace, placeWorkflowAgentWorktreeBase } from '../worktree/worktreeLayout'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
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
import { PROJECT_FOLDER_WORKFLOW_REASON, threadPlacement } from './threadPlacement'
import { repoProgramEnv, withoutRepoPrograms, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { isIdNamedMousseBranch, isMousseBranchName } from '../../shared/mousseBranches'

export interface WorkflowWorkspaceOwner {
  profileId: string
  threads: Pick<ThreadDataStore, 'getThread' | 'getThreadDir'>
  projects: Pick<ProjectManager, 'getProject'>
  /** Writes a line in a thread; used to tell it about work an older version left unfinished. */
  orchestrator?: { noteThreadNotice(threadId: string, text: string): void }
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
  /** Pinned initial revision for an isolated child without thread metadata. */
  expectedHeadSha?: string
}

export interface OwnedAgentWorkspace {
  cwd: string
  worktreePath: string
  kind: 'git-worktree' | 'thread-workspace' | 'scratch'
  branch?: string
  recordPath: string
  parent?: OwnedThreadWorkspace
  baseSha?: string
  /** The thread's files the worker started from (uncommitted work included): the base of the merge back. */
  baseSnapshot?: string
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
  /** A snapshot of the thread's files at spawn; the worktree was made at `baseSha` and these files written over it. */
  baseSnapshot?: string
  /** The worker's result: a snapshot of its files, or `baseSnapshot` when it changed nothing. */
  resultSha?: string
  receiptId?: string
  lifecycle: 'ready'
}

const occupancyTails = new Map<string, Promise<unknown>>()

/** Only for {@link isWorkflowRevisionCurrent}, which the workflow engine asks synchronously. */
function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', withoutRepoPrograms(cwd, args), { cwd, env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Git without blocking the daemon: the same check, command and answer as `execFileSync`. */
async function git(cwd: string, args: string[]): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv() })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trim()
}

/** The real path, read without blocking; `fs/promises`' `realpath` answers like `realpathSync.native`. */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

async function pathsEqual(left: string, right: string): Promise<boolean> {
  const a = await canonicalPath(left)
  const b = await canonicalPath(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function pathInside(root: string, candidate: string): Promise<boolean> {
  const rel = relative(await canonicalPath(root), await canonicalPath(candidate))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

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

async function listedWorktree(gitTopLevel: string, worktreePath: string): Promise<boolean> {
  const listed = await git(gitTopLevel, ['worktree', 'list', '--porcelain'])
  const wanted = await canonicalPath(worktreePath)
  for (const line of listed.split(/\r?\n/)) {
    if (line.startsWith('worktree ') && await pathsEqual(line.slice(9), wanted)) return true
  }
  return false
}

/**
 * Callers join a folder's queue in the order they called. The queue's key is the folder's real path, which is read without
 * blocking, so joining is itself queued, per folder as the caller names it: each caller joins only after every earlier
 * caller for that folder has, and a folder whose path is slow to read holds up only its own callers. Two spellings of one
 * folder (a link and its target) still share the queue; only the order in which they join it is not fixed.
 */
const joining = new Map<string, Promise<unknown>>()

const cancelled = (): Error => Object.assign(new Error('cancelled'), { code: 'cancelled' })

export async function withSerializedWorkspace<T>(cwd: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let result: T
  let started = false
  if (signal?.aborted) throw cancelled()
  const named = resolve(cwd)
  const joined = (joining.get(named) ?? Promise.resolve()).then(async () => {
    const key = await canonicalPath(cwd)
    const previous = occupancyTails.get(key) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      started = true
      if (signal?.aborted) throw cancelled()
      result = await work()
    })
    occupancyTails.set(key, queued)
    // Keep queue cleanup owned by the queued operation even when its caller is
    // released immediately by cancellation while another operation still holds cwd.
    void queued.finally(() => {
      if (occupancyTails.get(key) === queued) occupancyTails.delete(key)
    }).catch(() => undefined)
    // A caller that stopped waiting before it joined never reads this; its refusal is not an unhandled one.
    queued.catch(() => undefined)
    return { queued }
  })
  const tail = joined.catch(() => undefined)
  joining.set(named, tail)
  void tail.then(() => { if (joining.get(named) === tail) joining.delete(named) })
  // Waiting to join ends with the caller's signal; the queued step then sees it and never runs the work.
  const next = (signal ? await new Promise<Awaited<typeof joined>>((resolveJoin, reject) => {
    const abort = (): void => reject(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    joined.then(
      (value) => { signal.removeEventListener('abort', abort); resolveJoin(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error instanceof Error ? error : new Error(String(error))) }
    )
  }) : await joined).queued
  try {
    if (!signal) await next
    else await new Promise<void>((resolveWait, reject) => {
      // Once dispatch has started, cancellation belongs to the underlying
      // runner and this promise must retain ownership until raw settlement.
      const abort = () => { if (!started) reject(cancelled()) }
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
  const { project, thread } = liveBinding(owner, context)
  if (!project) throw new DomainRpcError('project_required', 'Thread workspace requires a project')
  // Workflows write through the thread's own worktree (its leases, receipts and step worktrees). A thread in its
  // project's folder never gets one, so a workflow there is refused before anything is made.
  const placement = threadPlacement(thread)
  if (placement === 'project-folder') throw new DomainRpcError('thread_in_project_folder', PROJECT_FOLDER_WORKFLOW_REASON)
  const projectPath = await canonicalPath(project.path)
  const threadDirectory = owner.threads.getThreadDir(context.threadId)
  const manager = new ThreadWorkspaceManager(threadDirectory)
  const repository = await manager.resolveRepositoryAsync(projectPath)
  if (!repository.capability.gitBacked) {
    throw new DomainRpcError(
      'executor_unavailable',
      repository.capability.unavailableReason ?? 'Thread workspace requires a Git repository'
    )
  }
  let existing = manager.load()
  if (existing) {
    await validateThreadWorkspaceMetadata(manager, existing, repository, context.threadId)
    // `recovery_required` is admitted too: a thread an older version left waiting recovers on its own instead of staying locked.
    const pending = [...manager.journal.latestByOperation().values()].some((entry) =>
      ['action-checkpoint', 'change-checkpoint', 'child-integration', 'change-integration', 'publish', 'change-publish', 'code-revert', 'change-revert'].includes(entry.operationType)
      && ['running', 'prepared', 'git_applied', 'recovery_required'].includes(entry.state))
    if (pending) {
      const lease = await waitAcquireExecutionLease(threadDirectory, { source: 'workflow-workspace-recovery', signal, maxAttempts: 36_000 })
      try {
        // A merge of a subagent's result an older version left unfinished is recorded as cancelled, never run again.
        const notice = cancelledIntegrationsNotice(await cancelPendingIntegrations(threadDirectory, existing.worktreePath))
        if (notice) owner.orchestrator?.noteThreadNotice(context.threadId, notice)
        await new PublishService(threadDirectory).recoverPending(existing.worktreePath, repository.primaryCheckoutPath, lease)
        await new ThreadActionService(threadDirectory).recoverPending(existing.worktreePath, lease)
        await new CodeRevertService(threadDirectory).recoverPending(existing.worktreePath, lease)
        existing = manager.load()!
      } finally { releaseExecutionLeaseHandle(lease) }
    }
    const verified = await manager.verify(existing)
    if (verified.lifecycle !== 'ready') {
      throw new DomainRpcError('thread_unavailable', `Thread workspace is stale (${verified.lifecycle})`)
    }
    if (verified.repositoryId !== repository.repositoryId) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace is bound to a different repository')
    }
    liveBinding(owner, context)
    const execution = await manager.executionContext(projectPath)
    if (!execution.workspacePath || await pathsEqual(execution.workspacePath, repository.primaryCheckoutPath)) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace must not be the primary checkout')
    }
    const cwd = await validateThreadWorkspacePaths(execution.workspacePath, execution.projectPath, repository)
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
  const execution = await new WorkspaceResolver(threadDirectory, context.threadId, projectPath, placement).resolve('agent', 'main', signal)
  liveBinding(owner, context)
  if (execution.lifecycle !== 'ready' || !execution.capability.gitBacked) {
    throw new DomainRpcError(
      'executor_unavailable',
      execution.capability.unavailableReason ?? 'Thread workspace is unavailable'
    )
  }
  if (!execution.workspacePath || await pathsEqual(execution.workspacePath, execution.primaryPath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace must not be the primary checkout')
  }
  const metadata = manager.load()
  if (!metadata || metadata.lifecycle !== 'ready') {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace provisioning did not become ready')
  }
  await validateThreadWorkspaceMetadata(manager, metadata, repository, context.threadId)
  const cwd = await validateThreadWorkspacePaths(execution.workspacePath, execution.projectPath, repository)
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

/**
 * Whether the branch a thread's workspace records is the thread's own: `mousse/<slug>`, named once when its worktree was
 * made, or for a thread made before that, `mousse/thread/<thread>/<conversation branch>`. Another thread's id-named branch,
 * and a branch outside `mousse/`, are never its own. With an active conversation branch (`activated`), any of the thread's
 * id-named branches counts, and so does the Git branch a fork made before snapshots recorded, which the checkout may still be on.
 */
export function isThreadOwnBranch(branch: string, threadId: string, conversationBranchId: string, activated?: { gitBranch?: string }): boolean {
  if (activated?.gitBranch && branch === activated.gitBranch) return true
  if (!isMousseBranchName(branch)) return false
  if (!isIdNamedMousseBranch(branch)) return true
  return activated ? branch.startsWith(`mousse/thread/${threadId}/`) : branch === `mousse/thread/${threadId}/${conversationBranchId}`
}

async function validateThreadWorkspaceMetadata(
  manager: ThreadWorkspaceManager,
  metadata: ReturnType<ThreadWorkspaceManager['load']> & {},
  repository: ReturnType<ThreadWorkspaceManager['resolveRepository']>,
  threadId: string
): Promise<void> {
  if (lstatSync(manager.workspacePath).isSymbolicLink() || statSync(manager.workspacePath).size > 64 * 1024) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace metadata is not a bounded regular file')
  }
  const branchId = metadata.conversationBranchId
  if (typeof branchId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(branchId)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace branch identity is invalid')
  }
  const expectedPath = defaultThreadWorktreePath(getMousseHomeDir(), repository.repositoryId, threadId, branchId)
  const activated = new ConversationBranchService(manager.threadDirectory).list()
    .find((branch) => branch.id === branchId && branch.lifecycle === 'active')
  // Activating a conversation branch no longer switches Git branches, so the checkout stays on the thread's own; forks made
  // before snapshots recorded a Git branch of their own, which the checkout may still be on.
  const ownBranch = isThreadOwnBranch(metadata.branch, threadId, branchId, activated)
  const expectedRef = activated?.retainedRef ?? `refs/mousse/threads/${threadId}/${branchId}`
  // A worktree made in a worktree folder the person chose is named after the thread's branch there (`worktreeLayout`).
  const inChosenFolder = Boolean(chosenFolderPlace(metadata.worktreePath)) && isThreadWorktreePlace(metadata.worktreePath, { home: getMousseHomeDir(), repositoryId: repository.repositoryId, threadId })
  const ownedPath = inChosenFolder || (activated
    ? await pathInside(dirname(expectedPath), metadata.worktreePath)
    : await pathsEqual(metadata.worktreePath, expectedPath))
  if (
    metadata.threadId !== threadId ||
    metadata.repositoryId !== repository.repositoryId ||
    metadata.projectRelativeSubdirectory !== repository.projectRelativeSubdirectory ||
    !ownedPath ||
    !ownBranch ||
    metadata.retainedRef !== expectedRef
  ) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace metadata does not match the live project binding')
  }
  if (!inChosenFolder && !await pathInside(repository.worktreeBase, metadata.worktreePath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace path is outside the repository workspace root')
  }
}

async function validateThreadWorkspacePaths(
  worktreePath: string,
  projectCwd: string,
  repository: ReturnType<ThreadWorkspaceManager['resolveRepository']>
): Promise<string> {
  if (!await listedWorktree(repository.gitTopLevel, worktreePath)) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace is not registered with the live repository')
  }
  if ((await resolveRepositoryIdentityAsync(worktreePath)).key !== repository.repositoryId) {
    throw new DomainRpcError('thread_unavailable', 'Thread workspace belongs to another repository')
  }
  const worktree = await canonicalPath(worktreePath)
  const cwd = await canonicalPath(projectCwd)
  if (!await pathInside(worktree, cwd) || await pathsEqual(worktree, repository.primaryCheckoutPath)) {
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
    await mkdir(input.stagingDir, { recursive: true })
    return { cwd: await canonicalPath(input.stagingDir) }
  }
  if (input.workingDirectory === 'profile-sandbox') {
    if (!input.sandboxRoot?.trim()) {
      throw new DomainRpcError('executor_unavailable', 'profile-sandbox is unavailable: no supported isolation backend')
    }
    return { cwd: await canonicalPath(input.sandboxRoot) }
  }
  const thread = await resolveOwnedThreadWorkspace(input.owner, input.context, input.signal)
  liveBinding(input.owner, input.context)
  return {
    cwd: thread.cwd,
    acquireMutationLease: (signal) => acquireWorkspaceMutationLease(input.owner, input.context, thread, signal)
  }
}

/** Recheck after waiting for the writer, before any intentional dirty snapshot. The caller holds the thread's writer lease. */
async function verifyWorkspaceWriterAdmission(
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  workspace: OwnedThreadWorkspace
): Promise<void> {
  const { project } = liveBinding(owner, context)
  const manager = new ThreadWorkspaceManager(workspace.threadDirectory)
  const metadata = manager.load()
  if (metadata) {
    if (!project) throw new DomainRpcError('thread_unavailable', 'Workspace project ownership changed')
    const repository = await manager.resolveRepositoryAsync(await canonicalPath(project.path))
    await validateThreadWorkspaceMetadata(manager, metadata, repository, context.threadId)
    if (metadata.lifecycle !== 'ready' || (await manager.verify(metadata)).lifecycle !== 'ready') {
      throw new DomainRpcError('thread_unavailable', 'Workspace needs recovery before it can be written')
    }
    // Bound by where the worktree is and which repository it belongs to. The branch is the agent's to switch or detach.
    if (!await pathsEqual(metadata.worktreePath, workspace.workspacePath) || (await resolveRepositoryIdentityAsync(workspace.workspacePath)).key !== metadata.repositoryId) {
      throw new DomainRpcError('thread_unavailable', 'Workspace binding changed while waiting; resolve its current revision again')
    }
    await validateThreadWorkspacePaths(workspace.workspacePath, workspace.cwd, repository)
  } else {
    // Isolated children have a separate journal but no task-binding metadata.
    // Their repository identity is the admission authority instead; HEAD and branch are the agent's to move.
    if (await pathsEqual(workspace.threadDirectory, owner.threads.getThreadDir(context.threadId)) ||
        !workspace.expectedHeadSha ||
        (await resolveRepositoryIdentityAsync(workspace.workspacePath)).key !== workspace.repositoryId) {
      throw new DomainRpcError('thread_unavailable', 'Workspace admission revision changed; recovery is required')
    }
  }
  new ChangeReceiptService(workspace.threadDirectory).assertNoPendingOperation()
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
    await verifyWorkspaceWriterAdmission(owner, context, workspace)
    // The thread lease covers the writer lifetime. Repository leases are taken
    // only by checkpoint/integration operations, never across model or process work.
    const conversationBranchId = new ThreadWorkspaceManager(workspace.threadDirectory).load()?.conversationBranchId ?? 'main'
    // Files changed outside Mousse since the last action are recorded first; the workflow starts from the snapshot.
    const startSha = (await new ThreadActionService(workspace.threadDirectory).recordOutsideChanges({
      threadId: context.threadId, conversationBranchId, workspacePath: workspace.workspacePath, heldThreadLease: threadLease,
      presentationMessageStart: 0, nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
    })).startSha
    const turnId = `${context.turnId ?? context.runId ?? 'workflow'}:${crypto.randomUUID()}`
    const actions = new ThreadActionService(workspace.threadDirectory)
    // Checked without blocking, right after the snapshot it checks; `beginTurn` then runs no Git.
    const startCheck = await actions.checkTurnStart(workspace.workspacePath, startSha)
    actions.beginTurn({
      threadId: context.threadId, turnId, conversationBranchId, workspacePath: workspace.workspacePath,
      presentationMessageStart: 0, presentationMessageEnd: 0,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' },
      actor: { kind: 'workflow', id: context.runId }, runId: context.runId, heldThreadLease: threadLease
    }, startSha, startCheck)
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

/**
 * Pins a finished workflow agent's result and reports it; nothing is merged into the parent thread. The result is a
 * snapshot of the worker's files, kept under its workflow ref, and its base (the thread's files at spawn) beside it
 * (`workflowBaseRef`). The parent agent brings the result in with Git if it wants it.
 */
export async function reportOwnedAgentWorkspace(input: {
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
  const spawnBase = record.baseSnapshot ?? workspace.baseSha
  // A worker that changed nothing has no result: its files are the ones it started from.
  const unchanged = await sameTreeAsync(workspace.worktreePath, resultSha, spawnBase)
  const report = await withGitMutationLocks(`${workspace.recordPath}.changes`, workspace.worktreePath, 'workflow-result-pin', async () => {
    // The result is a snapshot of the worker's files, which stays valid whatever the worker did to its own HEAD since.
    await gitAsync(workspace.worktreePath, ['cat-file', '-e', `${resultSha}^{commit}`])
    const frozen = await buildSubagentResultReportAsync({
      cwd: workspace.worktreePath, workedIn: workspace.worktreePath, shared: false,
      baseSha: spawnBase, resultSha: unchanged ? spawnBase : resultSha,
      pins: workspace.retainedRef ? { base: workflowBaseRef(workspace.retainedRef), result: workspace.retainedRef } : undefined
    })
    writeAgentRecord(workspace.recordPath, { ...record, resultSha: frozen.resultSha, receiptId: input.revision.receiptId })
    return frozen
  }, input.signal)
  // The parent's files are not touched: the revision names them as they are, and carries the report.
  const metadata = new ThreadWorkspaceManager(workspace.parent.threadDirectory).load()
  return { workspaceId: metadata?.workspaceId ?? context.threadId, readSha: workspace.baseSha,
    writeSha: metadata?.snapshotSha ?? await gitAsync(workspace.parent.workspacePath, ['rev-parse', 'HEAD']), generation: metadata?.generation, result: report }
}

/** Where a workflow agent's base is kept, beside its result ref (a ref cannot also be a folder of other refs). */
export function workflowBaseRef(retainedRef: string): string {
  return `${retainedRef}-base`
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
    // Snapshots have no ancestry, but receipts are linear: an observation made at or after the undone change saw it.
    if (undone.git) return observedGeneration !== undefined && undone.generation <= observedGeneration
    // A later verification can observe a descendant of the reversed change.
    if (undone.beforeSha !== undone.afterSha) {
      try {
        gitSync(metadata.worktreePath, ['merge-base', '--is-ancestor', undone.afterSha, revision.readSha])
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
  const repository = project ? await resolveRepositoryIdentityAsync(project.path) : undefined
  if (!project || (repository && !repository.capability.allowed && repository.capability.reason === 'not-a-repository')) {
    const scratch = join(input.scratchRoot, digest)
    assertOwnedPath(input.scratchRoot, scratch)
    await mkdir(scratch, { recursive: true })
    const cwd = await canonicalPath(scratch)
    if (!await pathInside(input.scratchRoot, cwd)) {
      throw new DomainRpcError('executor_unavailable', 'Workflow agent scratch path escapes its owned root')
    }
    if (existing && (existing.kind !== 'scratch' || !await pathsEqual(existing.worktreePath, scratch) || !await pathsEqual(existing.projectCwd, cwd))) {
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
    const reused = await reuseAgentWorktree(existing, thread, input.owner, input.context, input.idempotencyKey)
    if (reused) return { ...reused, recordPath, parent: thread, baseSha: existing.baseSha, baseSnapshot: existing.baseSnapshot, retainedRef: existing.retainedRef }
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

async function reuseAgentWorktree(
  record: AgentWorkspaceRecord,
  thread: OwnedThreadWorkspace,
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>,
  idempotencyKey: string
): Promise<Omit<OwnedAgentWorkspace, 'recordPath'> | undefined> {
  liveBinding(owner, context)
  const agentId = agentWorktreeId(context.profileId, context.threadId, idempotencyKey)
  const ownerDigest = digestIdentity(`${context.profileId}:${context.threadId}`).slice(0, 24)
  const identity = WorktreeIdentity.forAgent(defaultWorkflowAgentWorktreeBase(getMousseHomeDir(), thread.repositoryId, ownerDigest), agentId)
  const expectedRef = `refs/mousse/workflows/${context.profileId}/${context.threadId}/${agentId}`
  // Mousse's own `wf` folder, or the repository's agents folder in a worktree folder the person chose (`worktreeLayout`).
  await assertWorktreeFolderConnected(record.worktreePath)
  const placed = isWorkflowAgentWorktreePlace(record.worktreePath, { home: getMousseHomeDir(), repositoryId: thread.repositoryId, ownerDigest, agentId })
  const expectedCwd = await projectCwd(placed ? record.worktreePath : identity.path, thread.projectRelativeSubdirectory)
  if (
    record.repositoryId !== thread.repositoryId ||
    record.branch !== identity.branch ||
    record.retainedRef !== expectedRef ||
    !placed ||
    !await pathsEqual(record.projectCwd, expectedCwd)
  ) {
    throw new DomainRpcError('thread_unavailable', 'Workflow agent workspace is bound to a different repository')
  }
  if (!await exists(record.worktreePath) || !await listedWorktree(thread.gitTopLevel, record.worktreePath)) return undefined
  // Bound by its path, its top level and its repository; the agent may have switched or detached its branch.
  if (!await pathsEqual(await canonicalPath(await git(record.worktreePath, ['rev-parse', '--show-toplevel'])), await canonicalPath(record.worktreePath)) || (await resolveRepositoryIdentityAsync(record.worktreePath)).key !== thread.repositoryId) {
    throw new DomainRpcError('thread_unavailable', 'Workflow agent worktree changed')
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
  // In the worktree folder the person chose when it is connected, Mousse's own `wf` folder otherwise (`worktreeLayout`).
  const worktreesBase = await placeWorkflowAgentWorktreeBase({ home: getMousseHomeDir(), folder: chosenWorktreeFolder(input.thread.threadDirectory), repositoryId: input.thread.repositoryId, projectName: basename(input.thread.gitTopLevel), ownerDigest })
  const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
  const retainedRef = `refs/mousse/workflows/${input.context.profileId}/${input.context.threadId}/${agentId}`
  let threadLease: ThreadLeaseHandle | undefined
  let repositoryLease: RepositoryLeaseHandle | undefined
  try {
    threadLease = await waitAcquireExecutionLease(input.thread.threadDirectory, {
      source: 'workflow-agent-worktree',
      signal: input.signal
    })
    await verifyWorkspaceWriterAdmission(input.owner, input.context, input.thread)
    const baseSha = await git(input.thread.workspacePath, ['rev-parse', 'HEAD'])
    const repoIdentity = await resolveRepositoryIdentityAsync(input.thread.gitTopLevel, { requireMutationCapability: true })
    repositoryLease = await acquireRepositoryLease(repoIdentity, { signal: input.signal })
    liveBinding(input.owner, input.context)
    // The worker starts from the thread's files as they are, uncommitted work included, on top of the same commit.
    // That snapshot is also the base its result is merged back from.
    const threadFiles = await takeSnapshotAsync(input.thread.workspacePath, { reason: `workflow agent ${input.idempotencyKey}` })
    await mkdir(worktreesBase, { recursive: true })
    if (await exists(identity.path) && await listedWorktree(input.thread.gitTopLevel, identity.path)) {
      throw new DomainRpcError('unknown_effect', 'Unrecorded workflow worktree exists; preserve it for recovery')
    }
    let branchExists = false
    try {
      await git(input.thread.gitTopLevel, ['show-ref', '--verify', `refs/heads/${identity.branch}`])
      branchExists = true
    } catch {
      branchExists = false
    }
    if (await exists(identity.path)) {
      throw new DomainRpcError('executor_unavailable', `Refusing to reuse unmanaged agent worktree path: ${identity.path}`)
    }
    if (branchExists) {
      throw new DomainRpcError('unknown_effect', 'Workflow agent branch exists without its owned record')
    } else {
      await git(input.thread.workspacePath, ['worktree', 'add', '-b', identity.branch, identity.path, baseSha])
      // A fresh checkout holds Git's form of every file, so nothing is kept here unless something wrote into it meanwhile.
      const moved = await moveFilesAsync(identity.path, await git(identity.path, ['rev-parse', 'HEAD^{tree}']), threadFiles.tree, undefined, { owner: input.thread.threadDirectory, action: 'Starting the agent worktree' })
      const notice = movedFilesNotice(moved)
      if (notice) {
        if (input.owner.orchestrator) input.owner.orchestrator.noteThreadNotice(input.context.threadId, notice)
        else console.warn('agent worktree start kept files', { path: identity.path, notice })
      }
    }
    await git(input.thread.gitTopLevel, ['update-ref', '--no-deref', retainedRef, threadFiles.sha])
    const cwd = await projectCwd(identity.path, input.thread.projectRelativeSubdirectory)
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
      baseSnapshot: threadFiles.sha,
      lifecycle: 'ready'
    })
    return { cwd, worktreePath: identity.path, kind: 'git-worktree', branch: identity.branch, recordPath: input.recordPath,
      parent: input.thread, baseSha, baseSnapshot: threadFiles.sha, retainedRef }
  } finally {
    repositoryLease?.release()
    if (threadLease) releaseExecutionLeaseHandle(threadLease)
  }
}

async function projectCwd(worktreePath: string, subdirectory: string): Promise<string> {
  const worktree = await canonicalPath(worktreePath)
  const cwd = await canonicalPath(!subdirectory || subdirectory === '.' ? worktree : join(worktree, subdirectory))
  if (!await pathInside(worktree, cwd)) {
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
