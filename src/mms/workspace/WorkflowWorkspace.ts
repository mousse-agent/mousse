import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ExecutionContext } from '../../shared/execution/types'
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
  kind: 'git-worktree' | 'scratch'
  branch?: string
  recordPath: string
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

export async function withSerializedWorkspace<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const key = canonicalPath(cwd)
  const previous = occupancyTails.get(key) ?? Promise.resolve()
  let result: T
  const next = previous.catch(() => undefined).then(async () => {
    result = await work()
  })
  occupancyTails.set(key, next)
  try {
    await next
    return result!
  } finally {
    if (occupancyTails.get(key) === next) occupancyTails.delete(key)
  }
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
  const existing = manager.load()
  if (existing) {
    const verified = manager.verify(existing)
    if (verified.lifecycle !== 'ready') {
      throw new DomainRpcError('thread_unavailable', `Thread workspace is stale (${verified.lifecycle})`)
    }
    if (verified.repositoryId !== repository.repositoryId) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace is bound to a different repository')
    }
    liveBinding(owner, context)
    const execution = manager.executionContext(projectPath)
    if (!execution.workspacePath || pathsEqual(execution.workspacePath, execution.primaryPath)) {
      throw new DomainRpcError('thread_unavailable', 'Thread workspace must not be the primary checkout')
    }
    return {
      cwd: execution.projectPath,
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
  return {
    cwd: execution.projectPath,
    workspacePath: execution.workspacePath,
    primaryPath: execution.primaryPath,
    gitTopLevel: repository.gitTopLevel,
    repositoryId: repository.repositoryId,
    threadDirectory,
    projectRelativeSubdirectory: metadata.projectRelativeSubdirectory,
    branch: execution.branch
  }
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
  return { cwd: thread.cwd }
}

export async function provisionOwnedAgentWorkspace(input: {
  owner: WorkflowWorkspaceOwner
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>
  idempotencyKey: string
  registrationRoot: string
  scratchRoot: string
  signal?: AbortSignal
}): Promise<OwnedAgentWorkspace> {
  if (input.signal?.aborted) throw new DomainRpcError('cancelled', 'Workflow agent workspace cancelled')
  const { project } = liveBinding(input.owner, input.context)
  const digest = /^[a-f0-9]{64}$/i.test(input.idempotencyKey)
    ? input.idempotencyKey.toLowerCase()
    : digestIdentity(input.idempotencyKey)
  const recordPath = join(input.registrationRoot, `${digest}.json`)
  assertOwnedPath(input.registrationRoot, recordPath)
  if (!project) {
    const scratch = join(input.scratchRoot, digest)
    assertOwnedPath(input.scratchRoot, scratch)
    mkdirSync(scratch, { recursive: true })
    const cwd = canonicalPath(scratch)
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
  const existing = readAgentRecord(recordPath, input.context, input.idempotencyKey)
  const thread = await resolveOwnedThreadWorkspace(input.owner, input.context, input.signal)
  if (existing?.kind === 'git-worktree') {
    const reused = reuseAgentWorktree(existing, thread, input.owner, input.context)
    if (reused) return { ...reused, recordPath }
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
  const record = JSON.parse(readFileSync(path, 'utf8')) as AgentWorkspaceRecord
  if (
    record.version !== 1 ||
    record.profileId !== context.profileId ||
    record.threadId !== context.threadId ||
    (record.projectId ?? undefined) !== context.projectId ||
    record.idempotencyKey !== idempotencyKey
  ) {
    throw new DomainRpcError('profile_mismatch', 'Workflow agent workspace identity does not match this invocation')
  }
  return record
}

function reuseAgentWorktree(
  record: AgentWorkspaceRecord,
  thread: OwnedThreadWorkspace,
  owner: WorkflowWorkspaceOwner,
  context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>
): Omit<OwnedAgentWorkspace, 'recordPath'> | undefined {
  liveBinding(owner, context)
  if (record.repositoryId && record.repositoryId !== thread.repositoryId) {
    throw new DomainRpcError('thread_unavailable', 'Workflow agent workspace is bound to a different repository')
  }
  if (!existsSync(record.worktreePath) || !listedWorktree(thread.gitTopLevel, record.worktreePath)) return undefined
  const branch = git(record.worktreePath, ['branch', '--show-current'])
  if (record.branch && branch !== record.branch) {
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
    const repoIdentity = resolveRepositoryIdentity(input.thread.gitTopLevel, { requireMutationCapability: true })
    repositoryLease = await acquireRepositoryLease(repoIdentity, { signal: input.signal })
    liveBinding(input.owner, input.context)
    mkdirSync(worktreesBase, { recursive: true })
    if (existsSync(identity.path) && listedWorktree(input.thread.gitTopLevel, identity.path)) {
      const cwd = projectCwd(identity.path, input.thread.projectRelativeSubdirectory)
      const branch = git(identity.path, ['branch', '--show-current'])
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
        branch,
        retainedRef,
        lifecycle: 'ready'
      })
      return { cwd, worktreePath: identity.path, kind: 'git-worktree', branch, recordPath: input.recordPath }
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
      git(input.thread.workspacePath, ['worktree', 'add', identity.path, identity.branch])
    } else {
      git(input.thread.workspacePath, ['worktree', 'add', '-b', identity.branch, identity.path, 'HEAD'])
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
      lifecycle: 'ready'
    })
    return { cwd, worktreePath: identity.path, kind: 'git-worktree', branch: identity.branch, recordPath: input.recordPath }
  } finally {
    repositoryLease?.release()
    if (threadLease) releaseExecutionLeaseHandle(threadLease)
  }
}

function projectCwd(worktreePath: string, subdirectory: string): string {
  const cwd = !subdirectory || subdirectory === '.' ? worktreePath : join(worktreePath, subdirectory)
  const relativePath = relative(worktreePath, cwd)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
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
