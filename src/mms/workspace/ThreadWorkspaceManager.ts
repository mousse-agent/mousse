import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { walkOwnedContent, WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
import { getThreadLifecycleGate } from '../queue/ThreadLifecycleAdmission'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { nonInteractiveGitEnv } from '../git/gitEnv'
import { assertGitAllowed, rethrowGitPolicyError, type UserAction } from '../git/gitPolicy'
import { safeWorktreeGit } from '../worktree/WorktreeManager'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { moveFiles, snapshotOrigin } from '../actions/snapshots'
import { loadSnapshotWorkspaceMetadata } from './SnapshotWorkspace'
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
import { repoProgramEnv, withoutRepoPrograms } from '../git/repoPrograms'
import { threadBranchName } from '../../shared/mousseBranches'

function git(cwd: string, args: string[], userRequested?: UserAction): string {
  return execFileSync('git', withoutRepoPrograms(cwd, args, { userRequested }), { cwd, env: repoProgramEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: git(cwd, args) }
  } catch (error) {
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '' }
  }
}

/**
 * The `-c` overrides for Git commands that touch someone else's commits: the repository's existing safe-checkout set
 * (no hooks, no file system monitor, every configured filter driver cleared) plus no submodule recursion.
 */
async function untrustedSafety(repositoryRoot: string): Promise<string[]> {
  const { safety } = await safeWorktreeGit(repositoryRoot)
  return [...safety, '-c', 'submodule.recurse=false']
}

const CORE_WORKTREE_REFUSAL = 'This repository sets core.worktree, so a worktree cannot hold its own safety configuration.'

/** Whether the repository already keeps Git configuration per worktree (`extensions.worktreeConfig`). */
export function perWorktreeConfigEnabled(checkoutPath: string): boolean {
  return tryGit(checkoutPath, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig']).stdout === 'true'
}

/**
 * Turns on `extensions.worktreeConfig` in the repository's own configuration, which a worktree of someone else's
 * commits needs to hold its safety settings. It changes the person's repository, so it runs only as part of the
 * action that asked for such a worktree (Start from pull request), and that action says so. It is written at most
 * once and never turned off again. True when this call turned it on. `userRequested` is that action, which the
 * central Git check needs for a change to the repository's own config.
 */
export function enablePerWorktreeConfig(primaryCheckoutPath: string, userRequested?: UserAction): boolean {
  if (perWorktreeConfigEnabled(primaryCheckoutPath)) return false
  if (tryGit(primaryCheckoutPath, ['config', '--get', 'core.worktree']).stdout) throw new Error(CORE_WORKTREE_REFUSAL)
  git(primaryCheckoutPath, ['config', '--local', 'extensions.worktreeConfig', 'true'], userRequested)
  return true
}

/** Refuses unless the repository keeps configuration per worktree, so a worktree of someone else's commits can be protected. */
function assertPerWorktreeConfig(primaryCheckoutPath: string): void {
  if (tryGit(primaryCheckoutPath, ['config', '--get', 'core.worktree']).stdout) throw new Error(CORE_WORKTREE_REFUSAL)
  if (!perWorktreeConfigEnabled(primaryCheckoutPath)) {
    throw new Error("This repository's per-worktree Git settings are off (extensions.worktreeConfig), so a worktree of a pull request cannot be made safely. Start from the pull request again, or turn them on with `git config extensions.worktreeConfig true`.")
  }
}

/**
 * Makes the overrides part of the worktree's own configuration, so every Git command run there (a checkpoint
 * commit, the side card's Commit and Push, an agent's shell) is bound by them. A relative `core.hooksPath` or
 * a `.gitattributes` filter would otherwise act on the checkout's own files. Refuses when Git cannot keep
 * configuration per worktree, rather than leaving the worktree unprotected. It never changes the repository's own
 * configuration: `enablePerWorktreeConfig` does that, once, as part of the action the person asked for.
 */
function pinUntrustedWorktree(primaryCheckoutPath: string, worktreePath: string, safety: readonly string[]): void {
  assertPerWorktreeConfig(primaryCheckoutPath)
  for (let index = 0; index < safety.length; index++) {
    if (safety[index] !== '-c') continue
    const setting = safety[index + 1]
    const equals = setting.indexOf('=')
    git(worktreePath, ['config', '--worktree', setting.slice(0, equals), setting.slice(equals + 1)])
  }
  const scope = tryGit(worktreePath, ['config', '--show-scope', '--get', 'core.hooksPath'])
  if (!scope.ok || !scope.stdout.startsWith('worktree')) {
    throw new Error('This Git does not keep configuration per worktree; a worktree of a pull request cannot be made safely.')
  }
}

/**
 * `git worktree add` for commits from someone else: nothing they carry runs, no LFS content is fetched, and the safety
 * stays pinned. `enableWorktreeConfig` (see `provision`) turns the setting on once the safety checks have passed;
 * `userRequested` is the user's Start thread from pull request, which that change to the repository's config needs.
 */
async function addUntrustedWorktree(primaryCheckoutPath: string, addArguments: string[], worktreePath: string, enableWorktreeConfig?: () => void, userRequested?: UserAction): Promise<void> {
  // A repository whose filters cannot be switched off is refused here, before its configuration is changed.
  const safety = await untrustedSafety(primaryCheckoutPath)
  if (enableWorktreeConfig && enablePerWorktreeConfig(primaryCheckoutPath, userRequested)) enableWorktreeConfig()
  // Refused before anything is checked out, not after: the worktree must never exist without its safety settings.
  assertPerWorktreeConfig(primaryCheckoutPath)
  assertGitAllowed({ cwd: primaryCheckoutPath, args: [...safety, 'worktree', 'add', ...addArguments] })
  execFileSync('git', [...safety, 'worktree', 'add', ...addArguments], {
    cwd: primaryCheckoutPath,
    env: repoProgramEnv({ ...process.env, ...nonInteractiveGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  pinUntrustedWorktree(primaryCheckoutPath, worktreePath, safety)
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function capability(unavailableReason?: string, publishable = true): WorkspaceCapability {
  const available = !unavailableReason
  return {
    gitBacked: available,
    checkpointable: available,
    publishable: available && publishable,
    undoable: available,
    unavailableReason
  }
}

/** The record of a thread that works in its project's own folder; see `ThreadWorkspaceMetadata.kind`. */
const PROJECT_FOLDER_RECORD = 'project-folder.json'

/** Whether a workspace record is a project folder (the person's own), not a worktree Mousse made. */
export function isProjectFolderWorkspace(metadata: Pick<ThreadWorkspaceMetadata, 'kind'> | null | undefined): boolean {
  return metadata?.kind === 'project-folder'
}

export class ThreadWorkspaceManager {
  readonly journal: ThreadJournal

  constructor(readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
  }

  /**
   * The file holding the thread's workspace record: `workspace.json` for its own worktree, `project-folder.json` for a
   * thread in its project's folder. The project folder's record is kept apart on purpose: everything that retires,
   * trashes, cleans up or purges worktrees reads `workspace.json`, so none of it can ever act on a person's folder.
   */
  get workspacePath(): string {
    const folder = join(this.threadDirectory, PROJECT_FOLDER_RECORD)
    return existsSync(folder) ? folder : join(this.threadDirectory, 'workspace.json')
  }

  load(): ThreadWorkspaceMetadata | undefined {
    const path = this.workspacePath
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as ThreadWorkspaceMetadata
  }

  /**
   * The record of a thread that works in its project's own folder, made the first time it is needed. Nothing is made
   * in the repository but the thread's pin under `refs/mousse/threads/`: no worktree, no branch, and HEAD, the index and
   * the branches are never touched. Turns are snapshotted with the private index in the Git directory's `mousse/`
   * folder and undone by restoring files, as in a worktree. Several threads may share one folder: each records what
   * changed in it during its own turns. Undefined when the folder is not in a Git repository.
   */
  ensureProjectFolder(threadId: string, conversationBranchId: ConversationBranchId, projectPath: string): ThreadWorkspaceMetadata | undefined {
    const existing = this.load()
    if (existing) return this.verify(existing)
    const repository = this.resolveRepository(projectPath)
    if (!repository.capability.gitBacked) return undefined
    const head = tryGit(repository.gitTopLevel, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).stdout
    const retainedRef = `refs/mousse/threads/${threadId}/${conversationBranchId}`
    if (head) git(repository.gitTopLevel, ['update-ref', '--no-deref', retainedRef, head])
    const metadata: ThreadWorkspaceMetadata = {
      schemaVersion: 1,
      kind: 'project-folder',
      threadId,
      workspaceId: `${repository.repositoryId}:${threadId}`,
      generation: 0,
      provenance: { ownerThreadId: threadId },
      repositoryId: repository.repositoryId,
      conversationBranchId,
      branch: '',
      retainedRef,
      worktreePath: repository.gitTopLevel,
      projectRelativeSubdirectory: repository.projectRelativeSubdirectory,
      baseSha: head,
      headSha: head,
      lifecycle: 'ready',
      lastVerifiedAt: new Date().toISOString()
    }
    atomicWriteJsonSync(join(this.threadDirectory, PROJECT_FOLDER_RECORD), metadata)
    return metadata
  }

  /**
   * The thread's worktree record, or, for a thread whose folder has no Git of its own, the snapshot workspace's as the
   * same shape (`snapshotOnly`). For the code that Undoes, reviews and releases snapshots; every rule about worktrees
   * (retirement, cleanup, rebuilding, Publish) reads `load()` and never sees a folder that is the person's.
   */
  loadOrSnapshot(): ThreadWorkspaceMetadata | undefined {
    return this.load() ?? loadSnapshotWorkspaceMetadata(this.threadDirectory)
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
    heldThreadLease?: ThreadLeaseHandle,
    /**
     * Commit the new worktree starts at instead of the primary checkout's HEAD (a thread fork seeded
     * from its source's checkpoint, SPEC §16.2). Integration still targets the primary HEAD.
     */
    startSha?: string,
    /**
     * `untrusted`: `startSha` is a commit from someone else (a pull request's head). Nothing it carries may run,
     * on the checkout or in any Git command run in the worktree afterwards: hooks (a relative `core.hooksPath`
     * is looked up in the checkout), filter, smudge and process drivers its `.gitattributes` selects, Git LFS
     * (no smudge, so its `.lfsconfig` is never read) and the file system monitor are switched off in the
     * worktree's own configuration, and the workspace is marked so a restore does the same.
     *
     * `enableWorktreeConfig`: the person agreed to turn on `extensions.worktreeConfig`, which that safety needs. It is
     * turned on here, under the repository's lease and after every check that can refuse, so a refused start leaves
     * the setting as it was; the callback runs when this call turned it on. Without it, a repository with the
     * setting off is refused. `userRequested` is that agreement as the central Git check sees it.
     *
     * `snapshot`: a workspace snapshot (a fork's source checkpoint) whose files are written into the new worktree
     * after it is made at `startSha`, which is the commit the snapshot was taken on; the snapshot becomes the
     * thread's latest one, so the first turn starts from it instead of recording it as outside changes.
     *
     * `nameFrom`: the thread's first message. The worktree's branch is named from it once, here, as `mousse/<slug>`
     * (see `threadBranchName`), and never renamed; the name is checked against the repository under its lease.
     */
    options: { untrusted?: boolean; enableWorktreeConfig?: () => void; userRequested?: UserAction; snapshot?: string; nameFrom?: string } = {}
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
      const primaryHead = git(repository.primaryCheckoutPath, ['rev-parse', 'HEAD'])
      const head = startSha ? git(repository.primaryCheckoutPath, ['rev-parse', '--verify', `${startSha}^{commit}`]) : primaryHead
      // Named once, under the repository's lease, so two threads cannot take the same name.
      const branch = threadBranchName(options.nameFrom, threadId, (name) => tryGit(repository.primaryCheckoutPath, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/heads/${name}`]).stdout !== '')
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
        integrationTarget: { checkoutPath: repository.primaryCheckoutPath, baseSha: primaryHead },
        repositoryId: repository.repositoryId,
        conversationBranchId,
        branch,
        retainedRef,
        worktreePath,
        projectRelativeSubdirectory: repository.projectRelativeSubdirectory,
        baseSha: head,
        headSha: head,
        lifecycle: 'provisioning',
        lastVerifiedAt: new Date().toISOString(),
        ...(options.untrusted ? { untrusted: true as const } : {})
      } satisfies ThreadWorkspaceMetadata)
      if (options.untrusted) await addUntrustedWorktree(repository.primaryCheckoutPath, ['-b', branch, worktreePath, head], worktreePath, options.enableWorktreeConfig, options.userRequested)
      else git(repository.primaryCheckoutPath, ['worktree', 'add', '-b', branch, worktreePath, head])
      if (options.snapshot) moveFiles(worktreePath, git(worktreePath, ['rev-parse', 'HEAD^{tree}']), git(worktreePath, ['rev-parse', `${options.snapshot}^{tree}`]))
      git(repository.primaryCheckoutPath, ['update-ref', '--no-deref', retainedRef, options.snapshot ?? head])
      const metadata: ThreadWorkspaceMetadata = {
        schemaVersion: 1,
        threadId,
        workspaceId: `${repository.repositoryId}:${threadId}`,
        generation: 0,
        provenance: { ownerThreadId: threadId },
        integrationTarget: { checkoutPath: repository.primaryCheckoutPath, baseSha: primaryHead },
        repositoryId: repository.repositoryId,
        conversationBranchId,
        branch,
        retainedRef,
        worktreePath,
        projectRelativeSubdirectory: repository.projectRelativeSubdirectory,
        baseSha: head,
        headSha: head,
        ...(options.snapshot ? { snapshotSha: options.snapshot } : {}),
        lifecycle: 'ready',
        lastVerifiedAt: new Date().toISOString(),
        ...(options.untrusted ? { untrusted: true as const } : {})
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
    // The project folder is the person's own: there is no worktree to bring back.
    const current = this.load()
    if (isProjectFolderWorkspace(current)) return this.verify(current)
    const metadata = this.load()
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    const verified = this.verify(metadata)
    const unfinishedProvision = [...this.journal.latestByOperation().values()].some((entry) => entry.operationType === 'workspace-provision' && !['completed', 'cancelled'].includes(entry.state))
    if (verified.lifecycle === 'ready' && metadata.lifecycle === 'ready' && !unfinishedProvision) return verified
    const leftover = verified.lifecycle === 'recovery_required' && this.partlyRemoved(metadata)
    if (verified.lifecycle !== 'missing' && verified.lifecycle !== 'ready' && !leftover) throw new Error(`Workspace recovery is blocked: ${verified.lifecycle}`)
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
        git(ready.worktreePath, ['update-ref', '--no-deref', ready.retainedRef, ready.snapshotSha ?? ready.headSha])
        atomicWriteJsonSync(this.workspacePath, ready)
        this.finishProvisionRecovery(ready)
        return ready
      }
      if (leftover && this.partlyRemoved(metadata)) this.setAsidePartlyRemoved(metadata)
      const gate = getThreadLifecycleGate(this.threadDirectory)
      if (gate instanceof ResourceLifecycleStore && this.hasReconstructionManifest(metadata)) {
        const retirement = new WorktreeRetirementService(gate, { taskLease: threadLease, repositoryLease })
        const manifestPath = retirement.pathFor(metadata.threadId, metadata.worktreePath)
        const manifest = retirement.load(manifestPath)
        // HEAD is the agent's to move, so the one the worktree had when retired is not compared with the last one Mousse saw.
        if (manifest.branch !== metadata.branch || manifest.repositoryId !== metadata.repositoryId) throw new Error('Retired workspace manifest disagrees with authoritative task binding')
        // Refused before the rebuild registers anything: a worktree made and then refused would be left empty, without its safety.
        if (metadata.untrusted) assertPerWorktreeConfig(repository.gitTopLevel)
        // The worktree's own configuration went with the worktree: for someone else's commits it is put back before anything is checked out.
        const safety = metadata.untrusted ? await untrustedSafety(repository.gitTopLevel) : undefined
        retirement.reconstruct(manifestPath, safety ? { prepare: (path) => pinUntrustedWorktree(repository.gitTopLevel, path, safety), env: { ...nonInteractiveGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' } } : undefined)
        const restored = this.verify(metadata)
        if (restored.lifecycle !== 'ready') throw new Error('Reconstructed task workspace failed verification')
        atomicWriteJsonSync(this.workspacePath, restored)
        return restored
      }
      // The files come from the retained snapshot, and the worktree starts at the HEAD the snapshot was taken on: on the
      // branch it was on, or on the thread's own, when that branch still is at that commit; detached there otherwise.
      const retained = git(repository.gitTopLevel, ['rev-parse', '--verify', `${metadata.retainedRef}^{commit}`])
      const origin = snapshotOrigin(repository.gitTopLevel, retained)
      const head = origin.head ?? git(repository.gitTopLevel, ['rev-parse', '--verify', `${metadata.branch}^{commit}`])
      const tip = (branch: string): string | undefined => tryGit(repository.gitTopLevel, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).stdout || undefined
      const branch = [origin.branch, metadata.branch].find((name) => name && tip(name) === head)
      mkdirSync(dirname(metadata.worktreePath), { recursive: true })
      const add = async (target: string[]): Promise<void> => {
        if (metadata.untrusted) await addUntrustedWorktree(repository.gitTopLevel, target, metadata.worktreePath)
        else git(repository.gitTopLevel, ['worktree', 'add', ...target])
      }
      // A branch that another worktree has checked out cannot be added again; the commit can.
      if (branch) { try { await add([metadata.worktreePath, branch]) } catch { await add(['--detach', metadata.worktreePath, head]) } }
      else await add(['--detach', metadata.worktreePath, head])
      moveFiles(metadata.worktreePath, git(metadata.worktreePath, ['rev-parse', 'HEAD^{tree}']), git(metadata.worktreePath, ['rev-parse', `${retained}^{tree}`]))
      const restored = this.verify(metadata)
      atomicWriteJsonSync(this.workspacePath, restored)
      this.finishProvisionRecovery(restored)
      return restored
    } finally {
      repositoryLease?.release()
      if (threadLease && !heldThreadLease) releaseExecutionLeaseHandle(threadLease)
    }
  }

  /**
   * A folder that a failed retirement left behind: it has no `.git` file, and the reconstruction manifest
   * is still `prepared` because the removal never finished. Only that case is repaired; a checkout
   * whose `.git` file went missing for another reason is never moved.
   */
  private partlyRemoved(metadata: ThreadWorkspaceMetadata): boolean {
    if (existsSync(join(metadata.worktreePath, '.git')) || !existsSync(metadata.worktreePath) || !this.hasReconstructionManifest(metadata)) return false
    const gate = getThreadLifecycleGate(this.threadDirectory)
    if (!(gate instanceof ResourceLifecycleStore)) return false
    try {
      const retirement = new WorktreeRetirementService(gate)
      return retirement.load(retirement.pathFor(metadata.threadId, metadata.worktreePath)).state === 'prepared'
    } catch { return false }
  }

  /**
   * Moves the leftover folder aside so the worktree can be rebuilt from the pinned refs, and deletes
   * the moved folder when everything in it is exactly what the manifest retained. Anything else stays
   * next to the checkout for the person to look at. The caller holds the thread and repository leases.
   */
  private setAsidePartlyRemoved(metadata: ThreadWorkspaceMetadata): void {
    const gate = getThreadLifecycleGate(this.threadDirectory) as ResourceLifecycleStore
    const retirement = new WorktreeRetirementService(gate)
    const manifest = retirement.load(retirement.pathFor(metadata.threadId, metadata.worktreePath))
    const aside = `${metadata.worktreePath}.partial-${Date.now()}`
    try { renameSync(metadata.worktreePath, aside) }
    catch { throw new Error('The worktree was partly removed and programs are still using files in it; close them and try again.') }
    try {
      const retained = new Map(manifest.content.map((entry) => [entry.path, entry]))
      const verified = walkOwnedContent(aside, true).every((entry) => entry.kind === 'directory' || (retained.get(entry.path)?.kind === entry.kind && retained.get(entry.path)?.digest === entry.digest))
      if (verified) rmSync(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* The moved folder stays; the worktree is rebuilt beside it. */ }
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

  /** An operation that started and did not finish, so a person or recovery has to settle it before the next one. */
  hasPendingOperation(): boolean {
    // A publish waiting to be settled concerns the primary checkout only, so it does not hold up the thread.
    return [...this.journal.latestByOperation().values()].some((entry) => ['prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state) && !['publish', 'change-publish'].includes(entry.operationType))
  }

  verify(metadata = this.load()): ThreadWorkspaceMetadata {
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    if (!existsSync(metadata.worktreePath)) {
      const missing = { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
      return missing
    }
    try {
      // The branch and HEAD are the agent's to move: ready means the checkout is there and no Mousse operation waits.
      git(metadata.worktreePath, ['rev-parse', '--show-toplevel'])
      if (this.hasPendingOperation()) throw new Error('A Mousse operation is waiting for recovery.')
      const headSha = tryGit(metadata.worktreePath, ['rev-parse', 'HEAD']).stdout || metadata.headSha
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

  /**
   * The branch HEAD is on now: the agent may have switched from the thread's own. None when HEAD is detached. The
   * recorded branch stands in only while the worktree cannot be read (retired, or not there yet).
   */
  private currentBranch(metadata: ThreadWorkspaceMetadata): string | undefined {
    if (!existsSync(metadata.worktreePath)) return metadata.branch
    // A plain read: a branch name when HEAD is on one; detached HEAD answers nothing.
    if (!tryGit(metadata.worktreePath, ['rev-parse', '--git-dir']).ok) return metadata.branch
    const current = tryGit(metadata.worktreePath, ['symbolic-ref', '-q', '--short', 'HEAD'])
    return current.ok ? current.stdout.replace(/^heads\//, '') || undefined : undefined
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
      branch: this.currentBranch(metadata),
      workspaceId: metadata.workspaceId ?? `${metadata.repositoryId}:${metadata.threadId}`,
      generation: metadata.generation ?? 0,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      provenance: metadata.provenance ?? { ownerThreadId: metadata.threadId },
      lifecycle: metadata.lifecycle,
      // The project folder's work is already in the primary checkout: there is nothing to publish.
      ...(isProjectFolderWorkspace(metadata) ? { placement: 'project-folder' as const } : {}),
      capability: metadata.lifecycle === 'ready' ? capability(undefined, !isProjectFolderWorkspace(metadata)) : capability(`Workspace is ${metadata.lifecycle}`)
    }
  }
}
