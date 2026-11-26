import { execFileGitSync } from '../git/gitSpawn'
import { createHash, randomUUID } from 'node:crypto'
import { createLoggedBranchAsync, deleteVerifiedBranchAsync, verifiedRefTransactionAsync } from '../lifecycle/lifecycleGit'
import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
import { readDirectLifecycleRefAsync } from '../lifecycle/lifecycleGit'
import { findCleanupRecord, resumeCleanupAsync, verifiedCleanupAsync } from '../worktree/verifiedCleanup'
import { findListedWorktreeAsync, WorktreeListPass } from '../lifecycle/worktreeRegistry'
import { assertFolderUnchanged, folderSignatureAsync, samePath, walkOwnedContentAsync } from '../lifecycle/verifiedDelete'
import { getThreadLifecycleGate } from '../queue/ThreadLifecycleAdmission'
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { nonInteractiveGitEnv } from '../git/gitEnv'
import { assertGitAllowedAsync, rethrowGitPolicyError, withOwnedBranches, type UserAction } from '../git/gitPolicy'
import { safeWorktreeGit } from '../worktree/WorktreeManager'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { movedFilesNotice, moveFilesToSnapshotAsync, snapshotOriginAsync, takeSnapshotAsync, type Snapshot } from '../actions/snapshots'
import { waitForFolderAccess } from '../files/folderAccess'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { runIsolatedCheckout } from './isolatedCheckout'
import { addWorktree, checkoutInputsKey, checkoutLayoutKey, populateWorktree, registerWorktree, worktreeCheckoutPlan, worktreeGit, type WorktreeCheckoutPlan, type WorktreeGit } from '../worktree/worktreeCheckout'
import { loadSnapshotWorkspaceMetadataAsync } from './SnapshotWorkspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { readRecordedCheckoutHead, recordCheckoutIdentity } from './checkoutIdentity'
import { ThreadJournal, type ThreadJournalRecord } from '../data/ThreadJournal'
import { getMousseHomeDir } from '../data/paths'
import { assertWorktreeFolderConnected, chosenFolderHolding, chosenWorktreeFolder, defaultWorktreeBase, folderConnected, notConnectedPlacementNote, placeThreadWorktree, worktreeRegistrationOf, worktreeRegistrationOfSync } from '../worktree/worktreeLayout'
import { acquireRepositoryLease, describeLeaseHolder, olderBuildText, RepositoryLeaseBusyError, stoppedGitText, type RepositoryLeaseHandle } from '../git/RepositoryLease'
import { resolveRepositoryIdentity, resolveRepositoryIdentityAsync, type RepositoryIdentity } from '../git/RepositoryIdentity'
import { requireForkCheckpoint, readForkCheckpointPin } from './forkCheckpointPin'
import { requireLiveUndoRef } from '../actions/undoRefClaims'
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
import { repoProgramEnv, withoutRepoPrograms, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { branchReflogIdentity } from '../git/branchReflogIdentity'
import { DEFAULT_BRANCH_PREFIX, isAcceptableThreadBranchName } from '../../shared/mousseBranches'
import { branchNamingFor, requestBranchName, temporaryBranchName } from './branchNaming'
import type { NamingOrigin } from '../harness/driver'
import { BRANCH_CREATE_OPERATION, BRANCH_RECORD_OPERATIONS, BRANCH_RELEASE_OPERATION, BRANCH_RENAME_OPERATION, threadBranchRecord, type PendingBranchRename, type ThreadBranchRecord } from './threadBranchRecords'
import { noteThreadBranchChanged } from './threadHeads'
import { threadFolderIsLocalOnly } from '../data/localOnlyThreads'
import { settlesItself } from '../../shared/resourceLifecycle'
import { timeGitSync } from '../diagnostics/turnBoundary'
import { branchOfHeadRef, forgetRepositoryFacts, repositoryFacts } from '../git/repositoryFacts'
import { gitEnvFor, gitFile } from '../git/gitExecutable'
import { readRepoTrustAtAsync, repoTrustPathAsync } from '../git/repoTrust'
import { checkoutProcessRecordAbsent, checkoutRegistrationIdentity, checkoutWriterGone, clearUnindexedCheckoutFiles, readCheckoutProcess, recoverCheckoutIndex, saveCheckoutProcess, trackCheckoutGit, type CheckoutProcessRecord } from './checkoutProcess'

/** A worktree prepared for a new thread and never claimed was removed (`ThreadWorkspaceManager.releasePrepared`). */
export const PREPARED_RELEASE_OPERATION = 'workspace-prepared-release'

/** Identifies the trusted Git filter settings used for a prepared checkout. */
async function checkoutTrustKey(commonDir: string): Promise<string> {
  const trust = await readRepoTrustAtAsync(await repoTrustPathAsync(commonDir))
  return createHash('sha256').update(JSON.stringify(trust)).digest('hex')
}

/** True for a pending journal record that a live writer is still finishing (`liveCheckpointTest`), so it waits on nothing yet. */
export type InFlightTest = (entry: Pick<ThreadJournalRecord, 'operationType' | 'state'>) => boolean

/** Only for {@link ThreadWorkspaceManager.resolveRepository}, which callers that cannot wait yet still use. */
function gitSync(cwd: string, args: string[]): string {
  return timeGitSync(() => execFileGitSync(gitFile(), withoutRepoPrograms(cwd, args), { cwd, env: gitEnvFor(repoProgramEnv()), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
}

/** Git for the workspace's own commands, without blocking the daemon: the same check, command and answer as `execFileSync`. */
async function git(cwd: string, args: string[], userRequested?: UserAction): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args, { userRequested })
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv() })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trim()
}

/**
 * For this one command only, on Windows: Git may check out files past the 260-character path limit. The person's own Git
 * settings are never changed.
 */
const LONG_PATHS: readonly string[] = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []

/** `Thread.worktreeStartSha` from the thread folder's meta.json, when it holds a full commit id. */
function threadFolderWorktreeStart(location: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(location, 'meta.json'), 'utf8')) as { worktreeStartSha?: unknown }
    return typeof meta.worktreeStartSha === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(meta.worktreeStartSha) ? meta.worktreeStartSha : undefined
  } catch {
    return undefined
  }
}

async function tryGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    return { ok: true, stdout: await git(cwd, args) }
  } catch (error) {
    rethrowGitPolicyError(error)
    return { ok: false, stdout: '' }
  }
}

/** `existsSync` without blocking, once the path's volume answers. */
async function pathExists(path: string): Promise<boolean> {
  await waitForFolderAccess([path])
  return access(path).then(() => true, () => false)
}

/**
 * The `-c` overrides for Git commands that touch someone else's commits: the repository's existing safe-checkout set
 * (no hooks, no file system monitor, every configured filter driver cleared) plus no submodule recursion.
 */
async function untrustedSafety(repositoryRoot: string, allowPinnedFilters = false): Promise<string[]> {
  const { safety } = await safeWorktreeGit(repositoryRoot, { allowPinnedFilters })
  return [...safety, '-c', 'submodule.recurse=false']
}

/**
 * How long a thread's worktree is waited for while another Mousse operation uses its repository. A thread whose start
 * waits longer fails with {@link REPOSITORY_BUSY_TEXT} instead of looking busy for good.
 */
export const WORKSPACE_REPOSITORY_WAIT_MS = 2 * 60_000
export const REPOSITORY_BUSY_TEXT = 'Another Mousse operation is still using this repository, so this thread could not start. Try again in a moment.'

/** The repository's lease for a thread's worktree, waited for at most {@link WORKSPACE_REPOSITORY_WAIT_MS}. */
async function acquireWorkspaceRepositoryLease(identity: RepositoryIdentity, signal: AbortSignal | undefined): Promise<RepositoryLeaseHandle> {
  try {
    return await acquireRepositoryLease(identity, { signal, maxWaitMs: WORKSPACE_REPOSITORY_WAIT_MS })
  } catch (error) {
    if (!(error instanceof RepositoryLeaseBusyError)) throw error
    // Who holds it, so a stuck holder can be found; a stopped Git command still running is said as what to do.
    const stopped = stoppedGitText(error.holder)
    const older = olderBuildText(error.holder, error.leasePath)
    const message = stopped ?? `${REPOSITORY_BUSY_TEXT}${error.holder ? ` It is ${describeLeaseHolder(error.holder)}.` : ''}${older ? ` ${older}` : ''}`
    throw new RepositoryLeaseBusyError(message, { ...(error.holder ? { holder: error.holder } : {}), cause: error, ...(error.leasePath ? { leasePath: error.leasePath } : {}) })
  }
}

const CORE_WORKTREE_REFUSAL = 'This repository sets core.worktree, so a worktree cannot hold its own safety configuration.'

/** Whether the repository already keeps Git configuration per worktree (`extensions.worktreeConfig`). */
export async function perWorktreeConfigEnabled(checkoutPath: string): Promise<boolean> {
  return (await tryGit(checkoutPath, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'])).stdout === 'true'
}

/**
 * Turns on `extensions.worktreeConfig` in the repository's own configuration, which a worktree of someone else's
 * commits needs to hold its safety settings. It changes the person's repository, so it runs only as part of the
 * action that asked for such a worktree (Start from pull request), and that action says so. It is written at most
 * once and never turned off again. True when this call turned it on. `userRequested` is that action, which the
 * central Git check needs for a change to the repository's own config.
 */
export async function enablePerWorktreeConfig(primaryCheckoutPath: string, userRequested?: UserAction): Promise<boolean> {
  if (await perWorktreeConfigEnabled(primaryCheckoutPath)) return false
  if ((await tryGit(primaryCheckoutPath, ['config', '--get', 'core.worktree'])).stdout) throw new Error(CORE_WORKTREE_REFUSAL)
  await git(primaryCheckoutPath, ['config', '--local', 'extensions.worktreeConfig', 'true'], userRequested)
  return true
}

/** Refuses unless the repository keeps configuration per worktree, so a worktree of someone else's commits can be protected. */
async function assertPerWorktreeConfig(primaryCheckoutPath: string): Promise<void> {
  if ((await tryGit(primaryCheckoutPath, ['config', '--get', 'core.worktree'])).stdout) throw new Error(CORE_WORKTREE_REFUSAL)
  if (!await perWorktreeConfigEnabled(primaryCheckoutPath)) {
    throw new Error("This repository's per-worktree Git settings are off (extensions.worktreeConfig), so a worktree of a pull request cannot be made safely. Start from the pull request again, or turn them on with `git config extensions.worktreeConfig true`.")
  }
}

function gitConfigKey(key: string): string {
  const section = key.indexOf('.')
  const variable = key.lastIndexOf('.')
  return key.slice(0, section).toLowerCase() + key.slice(section, variable) + key.slice(variable).toLowerCase()
}

async function untrustedConfig(worktreePath: string): Promise<Map<string, { scope: string; value: string }>> {
  const config = String(await worktreeGit(worktreePath, ['config', '--null', '--show-scope', '--list'])).split('\0')
  const effective = new Map<string, { scope: string; value: string }>()
  for (let index = 0; index + 1 < config.length - 1; index += 2) {
    const entry = config[index + 1]!
    const end = entry.indexOf('\n')
    if (end !== -1) effective.set(entry.slice(0, end), { scope: config[index]!, value: entry.slice(end + 1) })
  }
  return effective
}

/**
 * Makes the overrides part of the worktree's own configuration, so every Git command run there (a checkpoint
 * commit, the side card's Commit and Push, an agent's shell) is bound by them. A relative `core.hooksPath` or
 * a `.gitattributes` filter would otherwise act on the checkout's own files. Refuses when Git cannot keep
 * configuration per worktree, rather than leaving the worktree unprotected. It never changes the repository's own
 * configuration: `enablePerWorktreeConfig` does that, once, as part of the action the person asked for.
 */
async function pinUntrustedWorktree(worktreePath: string, safety: readonly string[], verifyOnly = false): Promise<void> {
  const settings = safety.filter((_, index) => index % 2 === 1).map((setting) => {
    const equals = setting.indexOf('=')
    return { key: gitConfigKey(setting.slice(0, equals)), value: setting.slice(equals + 1) }
  })
  const missing = async () => {
    const config = await untrustedConfig(worktreePath)
    return settings.filter(({ key, value }) => config.get(key)?.scope !== 'worktree' || config.get(key)?.value !== value)
  }
  const absent = await missing()
  if (!absent.length) return
  if (!verifyOnly) {
    await assertPerWorktreeConfig(worktreePath)
    for (const { key, value } of absent) await git(worktreePath, ['config', '--worktree', key, value])
    if (!(await missing()).length) return
  }
  throw new Error('The linked worktree does not keep its Git safety settings.')
}

/**
 * `git worktree add` for commits from someone else: nothing they carry runs, no LFS content is fetched, and the safety
 * stays pinned. `enableWorktreeConfig` (see `provision`) turns the setting on once the safety checks have passed;
 * `userRequested` is the user's Start thread from pull request, which that change to the repository's config needs.
 */
async function addUntrustedWorktree(primaryCheckoutPath: string, addArguments: string[], worktreePath: string, plan: WorktreeCheckoutPlan, enableWorktreeConfig?: () => void, userRequested?: UserAction, beforeAdd?: () => Promise<void>): Promise<void> {
  const untrusted = await untrustedWorktreeGit(primaryCheckoutPath, worktreePath, enableWorktreeConfig, userRequested)
  await beforeAdd?.()
  await registerWorktree({ cwd: primaryCheckoutPath, add: addArguments, ...untrusted })
  await populateWorktree({ worktreePath, plan, ...untrusted })
  await untrusted.verifyPinned()
}

/**
 * How Git runs for a worktree of someone else's commits ({@link addUntrustedWorktree}): the safety settings before every
 * command, nothing interactive, no LFS content, and the safety pinned in the worktree's own configuration once it is
 * registered, before any file is written.
 */
async function untrustedWorktreeGit(primaryCheckoutPath: string, worktreePath: string, enableWorktreeConfig?: () => void, userRequested?: UserAction): Promise<{ run: WorktreeGit; verifyPinned: () => Promise<void> }> {
  // A repository whose filters cannot be switched off is refused here, before its configuration is changed.
  const safety = await untrustedSafety(primaryCheckoutPath)
  if (enableWorktreeConfig && await enablePerWorktreeConfig(primaryCheckoutPath, userRequested)) enableWorktreeConfig()
  // Refused before anything is checked out, not after: the worktree must never exist without its safety settings.
  await assertPerWorktreeConfig(primaryCheckoutPath)
  const runUntrustedCheckoutGit: WorktreeGit = async (cwd, args, input, observer) => {
    const linked = samePath(cwd, worktreePath)
    await waitForFolderAccess([resolve(cwd)])
    const current = linked ? await untrustedSafety(cwd, true) : safety
    if (linked) await pinUntrustedWorktree(cwd, current)
    const argv = [...current, ...LONG_PATHS, ...args]
    await assertGitAllowedAsync({ cwd, args: argv, ...(input === undefined ? {} : { stdin: input }) })
    const env = repoProgramEnv({ ...process.env, ...nonInteractiveGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' })
    if (linked) {
      await runIsolatedCheckout(cwd, args, input, env, { observer })
    } else {
      const ran = await runGitProcess(argv, { cwd, env, observer, ...(input === undefined ? {} : { input }) })
      if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
    }
  }
  return { run: runUntrustedCheckoutGit, verifyPinned: async () => pinUntrustedWorktree(worktreePath, await untrustedSafety(worktreePath, true)) }
}

/** Only for {@link ThreadWorkspaceManager.resolveRepository}. */
function canonicalPathSync(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/** The folder's real path, once its volume answers; `fs/promises`' `realpath` answers like `realpathSync.native`. */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  await waitForFolderAccess([resolved])
  try {
    return await realpath(resolved)
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

function unavailableRepository(requested: string, identity: RepositoryIdentity): RepositoryContextData {
  return {
    repositoryId: identity.key,
    gitTopLevel: requested,
    gitCommonDirectory: identity.commonDir,
    primaryCheckoutPath: requested,
    projectRelativeSubdirectory: '.',
    worktreeBase: '',
    capability: capability(identity.capability.allowed ? undefined : identity.capability.reason)
  }
}

function repositoryContext(requested: string, topLevel: string, identity: RepositoryIdentity): RepositoryContextData {
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
    worktreeBase: defaultWorktreeBase(getMousseHomeDir(), identity.key),
    capability: capability()
  }
}

/** The record of a thread that works in its project's own folder; see `ThreadWorkspaceMetadata.kind`. */
const PROJECT_FOLDER_RECORD = 'project-folder.json'

/** Whether a workspace record is a project folder (the person's own), not a worktree Mousse made. */
export function isProjectFolderWorkspace(metadata: Pick<ThreadWorkspaceMetadata, 'kind'> | null | undefined): boolean {
  return metadata?.kind === 'project-folder'
}

/** A thread's workspace record (see `ThreadWorkspaceManager.workspacePath`), read without anything else; undefined when absent or unreadable. */
export function readThreadWorkspaceRecord(threadDirectory: string): ThreadWorkspaceMetadata | undefined {
  try {
    const folder = join(threadDirectory, PROJECT_FOLDER_RECORD)
    const path = existsSync(folder) ? folder : join(threadDirectory, 'workspace.json')
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as ThreadWorkspaceMetadata
    return value && typeof value.worktreePath === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export class ThreadWorkspaceManager {
  readonly journal: ThreadJournal
  /**
   * Set by the last {@link provision} that made a worktree: what the thread is told about where it went, when the
   * worktree folder the person chose was not connected and it went to Mousse's own folder instead.
   */
  placementNote?: string

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
  async ensureProjectFolder(threadId: string, conversationBranchId: ConversationBranchId, projectPath: string): Promise<ThreadWorkspaceMetadata | undefined> {
    const existing = this.load()
    if (existing && !existing.prepared) return this.verify(existing)
    const repository = await this.resolveRepositoryAsync(projectPath)
    if (!repository.capability.gitBacked) return undefined
    const head = (await tryGit(repository.gitTopLevel, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout
    const retainedRef = `refs/mousse/threads/${threadId}/${conversationBranchId}`
    if (head) await git(repository.gitTopLevel, ['update-ref', '--no-deref', retainedRef, head])
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
    // The first binding stands. An unclaimed checkout can stay on disk with its own
    // workspace record for storage cleanup while this thread works in the project folder.
    const made = this.load()
    if (made && !made.prepared) return this.verify(made)
    atomicWriteJsonSync(join(this.threadDirectory, PROJECT_FOLDER_RECORD), metadata)
    return metadata
  }

  /**
   * Removes the project-folder record {@link ensureProjectFolder} made for a thread that never ran there (a terminal,
   * branch switch or file write on an empty chat makes one), and its pin, so the thread can take a worktree instead.
   * Only the caller knows that nothing ran: it holds the thread's lease and has checked the thread has no messages
   * and no recorded actions. Nothing in the person's folder is touched. False when the pin cannot be removed; the
   * record then stays.
   */
  async dropUnusedProjectFolder(threadId: string, heldThreadLease: ThreadLeaseHandle): Promise<boolean> {
    assertHeldThreadLease(this.threadDirectory, heldThreadLease)
    const path = join(this.threadDirectory, PROJECT_FOLDER_RECORD)
    const metadata = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ThreadWorkspaceMetadata : undefined
    if (!metadata || !isProjectFolderWorkspace(metadata) || metadata.prepared || metadata.threadId !== threadId) return false
    const ref = metadata.retainedRef
    // A repository without a commit got no pin.
    if (ref && metadata.baseSha && ref.startsWith(`refs/mousse/threads/${threadId}/`)) {
      // Only the pin as it was made; a pin that moved since is kept, and so is the record.
      const removed = await tryGit(metadata.worktreePath, ['update-ref', '--no-deref', '-d', ref, metadata.baseSha])
      if (!removed.ok) return false
    }
    await rm(path, { force: true })
    return true
  }

  /**
   * The thread's worktree record, or, for a thread whose folder has no Git of its own, the snapshot workspace's as the
   * same shape (`snapshotOnly`). For the code that Undoes, reviews and releases snapshots; every rule about worktrees
   * (retirement, cleanup, rebuilding, Publish) reads `load()` and never sees a folder that is the person's.
   */
  async loadOrSnapshotAsync(): Promise<ThreadWorkspaceMetadata | undefined> {
    return this.load() ?? await loadSnapshotWorkspaceMetadataAsync(this.threadDirectory)
  }

  /** {@link resolveRepositoryAsync}, blocking: only for callers that cannot wait yet (scheduled-job validation). */
  resolveRepository(projectPath: string): RepositoryContextData {
    const requested = canonicalPathSync(projectPath)
    const identity = resolveRepositoryIdentity(requested)
    if (!identity.capability.allowed) return unavailableRepository(requested, identity)
    return repositoryContext(requested, canonicalPathSync(gitSync(requested, ['rev-parse', '--show-toplevel'])), identity)
  }

  async resolveRepositoryAsync(projectPath: string): Promise<RepositoryContextData> {
    // macOS may expose the same temporary directory as /var and /private/var.
    // Compare Git's paths only after resolving symlinks, otherwise a valid
    // repository can appear to sit outside its own top-level checkout.
    const requested = await canonicalPath(projectPath)
    const identity = await resolveRepositoryIdentityAsync(requested)
    if (!identity.capability.allowed) return unavailableRepository(requested, identity)
    return repositoryContext(requested, await canonicalPath(await git(requested, ['rev-parse', '--show-toplevel'])), identity)
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
     * after it is made at `startSha`, which is the commit the snapshot was taken on. The bytes after seeding become the
     * thread's first baseline, just as for a fresh checkout. `onNotice` gets
     * what that write kept or left as it is, as a line for the thread.
     *
     * `nameFrom`: the thread's first message. The worktree is made at once on a temporary branch `<prefix>/<random id>`
     * (Settings → Storage → Branches), checked against the repository under its lease. Once it is ready, the title model
     * is asked in the background for a name from `nameFrom`, and the branch is renamed to it (`nameBranchLater`); nothing
     * waits on that. A private thread's (`Thread.localOnly`) first message is never sent: its branch keeps the random name.
     *
     * `onWorktreeMade`: runs once the worktree is made and its files written, before anything else can fail: what Mousse
     * wrote there, as a caller that may have to remove it again reads it.
     *
     * `prepared`: the worktree is made for a new thread before its first message is sent (`workspacePreparation.ts`).
     * The record says so (`ThreadWorkspaceMetadata.prepared`) until that message claims it (`claimPrepared`), with the
     * notes its first turn would otherwise have been given.
     *
     * Only registering the branch and the worktree (`git worktree add --no-checkout`) holds the repository's lease. The
     * files are written after it is let go (`populateWorktree`, one checkout at a time per disk), so two new threads of
     * one repository never wait for each other's checkout. The record stays `provisioning` until the files are written,
     * and a checkout a stop interrupted is finished by the next turn (`resumeInterruptedProvision`).
     */
    options: { untrusted?: boolean; enableWorktreeConfig?: () => void; userRequested?: UserAction; snapshot?: string; snapshotReceiptId?: string; forkCheckpoint?: true; nameFrom?: string; onNotice?: (notice: { id: string; text: string }) => unknown; onWorktreeMade?: (worktreePath: string) => void | Promise<void>; prepared?: { startNote?: () => string | undefined } } = {}
  ): Promise<ThreadWorkspaceMetadata> {
    const existing = this.load()
    if (existing?.lifecycle === 'ready') return this.verify(existing)
    const repository = await this.resolveRepositoryAsync(projectPath)
    if (!repository.capability.gitBacked) throw new Error(repository.capability.unavailableReason)

    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    const operationId = crypto.randomUUID()
    const preparedAt = new Date().toISOString()
    let registered = false
    try {
      if (heldThreadLease) assertHeldThreadLease(this.threadDirectory, heldThreadLease)
      threadLease = heldThreadLease ?? await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-provision', signal })
      const identity = await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true })
      // Another waiter may have provisioned while this call was acquiring ownership.
      const provisioned = this.load()
      if (provisioned?.lifecycle === 'ready') return this.verify(provisioned)
      if (provisioned) throw new Error(`Workspace provisioning requires recovery: ${provisioned.lifecycle}`)
      // How the files are written (`worktreeCheckout.ts`), read with HEAD: a missing sparse-checkout pattern file refuses
      // the worktree here, before anything is made.
      const [primaryHead, checkoutPlan, trust] = await Promise.all([
        git(repository.primaryCheckoutPath, ['rev-parse', 'HEAD']),
        worktreeCheckoutPlan(repository.gitTopLevel, undefined, { matchPreparation: Boolean(options.prepared) }),
        options.prepared ? checkoutTrustKey(repository.gitCommonDirectory) : undefined
      ])
      // Without a start from the caller, the branch picked for the thread when it was created (`Thread.worktreeStartSha`).
      const requestedStart = startSha
      startSha ??= threadFolderWorktreeStart(this.threadDirectory)
      const head = startSha ? await git(repository.primaryCheckoutPath, ['rev-parse', '--verify', `${startSha}^{commit}`]) : primaryHead
      // A temporary name, picked under the repository's lease so two threads cannot take the same one. A private thread's
      // first message is never sent for naming: Git reads from the user's other computers list branch names.
      const nameFrom = threadFolderIsLocalOnly(this.threadDirectory) ? undefined : options.nameFrom?.trim() || undefined
      const retainedRef = `refs/mousse/threads/${threadId}/${conversationBranchId}`
      // In the worktree folder the person chose (Settings → Storage), or Mousse's own; see `worktreeLayout`.
      const registrations = new WorktreeListPass()
      const placement = await placeThreadWorktree({
        home: getMousseHomeDir(),
        folder: chosenWorktreeFolder(this.threadDirectory),
        repositoryId: repository.repositoryId,
        projectName: basename(repository.primaryCheckoutPath),
        threadId,
        conversationBranchId,
        // Not the branch: its temporary name says nothing, and a rename later never moves the folder.
        // A name Git or a reconstruction manifest still names is never given to another worktree.
        taken: (path) => this.pathNamed(repository.gitCommonDirectory, path, registrations)
      })
      const worktreePath = placement.path
      repositoryLease = await acquireWorkspaceRepositoryLease(identity, signal)
      // A fork's checkpoint and its Undo ref are checked under the repository's lease, which a release of either takes.
      if (options.forkCheckpoint) {
        const pin = readForkCheckpointPin(this.threadDirectory)
        if (!pin || pin.sha !== options.snapshot || pin.head !== requestedStart) throw new Error('The accepted fork checkpoint changed.')
        await requireForkCheckpoint(threadId, repository.primaryCheckoutPath, identity.key, pin)
      }
      if (options.snapshot && options.snapshotReceiptId) await requireLiveUndoRef(identity, repository.primaryCheckoutPath, options.snapshotReceiptId, 'after', options.snapshot)
      const occupied = await pathExists(worktreePath)
      const occupiedError = 'The folder for the new worktree already exists.'
      // A background draft or abandoned PR start must never claim an existing folder.
      if (occupied && (options.prepared || options.untrusted)) throw new Error(occupiedError)
      const branch = await this.freeTemporaryBranch(repository.primaryCheckoutPath)
      this.placementNote = placement.notConnected ? notConnectedPlacementNote(placement.notConnected) : undefined
      const intent = this.journal.append({
        operationId,
        operationType: 'workspace-provision',
        state: 'planned',
        // `snapshot`: a fork's files go in after the checkout, so a stopped checkout is not finished without them.
        expectedPreState: { head, branch, retainedRef, worktreePath, checkoutPlan, ...(options.snapshot ? { snapshot: true } : {}), requiresCompletion: true, requiresBranchIdentity: true }
      })
      const provisioning: ThreadWorkspaceMetadata = {
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
        ...(options.untrusted ? { untrusted: true as const } : {}),
        ...(options.prepared ? { prepared: {
          at: preparedAt,
          sourceCheckout: repository.gitTopLevel,
          layout: checkoutLayoutKey(checkoutPlan),
          trust: trust!,
          ...(placement.folder ? { folder: placement.folder } : {}),
          ...(placement.notConnected ? { disconnectedFolder: placement.notConnected } : {})
        } } : {})
      }
      atomicWriteJsonSync(this.workspacePath, provisioning)
      // The thread's card names the branch this worktree gets from now on, not its project's.
      noteThreadBranchChanged(threadId)
      // Mousse makes this branch, with a reflog entry that identifies it as Mousse's, whatever prefix the person chose.
      // Only the branch and Git's record of the worktree are made under the lease; the files are written after it is let go.
      const processRecord: CheckoutProcessRecord = { operationId }
      saveCheckoutProcess(this.threadDirectory, processRecord)
      // Record a failed Send for Retry while leaving the occupied path untouched.
      if (occupied) throw new Error(occupiedError)
      const untrusted = options.untrusted
        ? await untrustedWorktreeGit(repository.primaryCheckoutPath, worktreePath, options.enableWorktreeConfig, options.userRequested)
        : undefined
      const writer = { prefix: untrusted ? undefined : LONG_PATHS, run: trackCheckoutGit(this.threadDirectory, processRecord, untrusted?.run ?? worktreeGit, signal) }
      const createBranch = async (): Promise<void> => {
        const ref = `refs/heads/${branch}`
        const message = `mousse: provision ${operationId}`
        await createLoggedBranchAsync(repository.primaryCheckoutPath, ref, head, message)
        const reflogId = branchReflogIdentity(repository.gitCommonDirectory, ref, { message, creation: true })?.id
        if (reflogId) this.journal.append({ operationId: randomUUID(), operationType: BRANCH_CREATE_OPERATION, state: 'completed', details: { provisionId: operationId, reflogId } })
      }
      await withOwnedBranches([branch], async () => {
        await createBranch()
        await registerWorktree({ cwd: repository.primaryCheckoutPath, add: [worktreePath, branch], ...writer })
      })
      const adminDir = await this.assertRegisteredAt(provisioning)
      const registration = { adminDir, identity: await checkoutRegistrationIdentity(adminDir) }
      processRecord.registration = registration
      saveCheckoutProcess(this.threadDirectory, processRecord)
      registered = true
      repositoryLease.release()
      repositoryLease = undefined
      let effectiveCheckout: string | undefined
      await populateWorktree({
        worktreePath, plan: checkoutPlan, ...writer, signal,
        beforeCheckout: async () => {
          if (registration.identity !== await checkoutRegistrationIdentity(await this.assertRegisteredAt(provisioning))) {
            throw new Error('The worktree registration changed before checkout.')
          }
        },
        beforeWorktreeFiles: options.prepared ? async () => { effectiveCheckout = await checkoutInputsKey(worktreePath) } : undefined
      })
      if (registration.identity !== await checkoutRegistrationIdentity(await this.assertRegisteredAt(provisioning))) {
        throw new Error('The worktree registration changed during checkout.')
      }
      await untrusted?.verifyPinned()
      if (effectiveCheckout !== undefined && effectiveCheckout !== await checkoutInputsKey(worktreePath)) {
        throw new Error('The worktree checkout settings changed while its files were written.')
      }
      if (options.snapshot) {
        // A fresh checkout holds Git's form of every file, so nothing is kept here unless something wrote into it meanwhile.
        const moved = await moveFilesToSnapshotAsync(worktreePath, await git(worktreePath, ['rev-parse', 'HEAD^{tree}']), options.snapshot, { owner: this.threadDirectory, action: 'Starting the worktree' })
        const notice = movedFilesNotice(moved)
        if (notice) {
          try { await options.onNotice?.({ id: `worktree-start-${randomUUID()}`, text: notice }) } catch (error) { console.warn('worktree start notice could not be delivered', { threadId, error: error instanceof Error ? error.message : String(error) }) }
          if (!options.onNotice) console.warn('worktree start kept files', { threadId, notice })
        }
      }
      await options.onWorktreeMade?.(worktreePath)
      // Capture the bytes Git and seeding wrote while this checkout is still being provisioned. Undo of the first turn
      // must be independent of any later change to checkout settings.
      let baseline: Snapshot | undefined
      // Untrusted worktrees use config.worktree, which already requires normal start capture.
      if (!options.untrusted) {
        try {
          const snapshot = await takeSnapshotAsync(worktreePath, { reason: 'worktree created', threadId })
          if (snapshot.exactTree && !snapshot.coverageGaps?.length) baseline = snapshot
        } catch { /* The first turn reads the files if the baseline could not be captured. */ }
      }
      // A fork's record names the accepted checkpoint, which its seeding verifies (`forkCheckpoint`). Its baseline only
      // confirms the checkout holds exactly that checkpoint's files; otherwise its first turn reads them.
      if (options.forkCheckpoint && options.snapshot && baseline
        && await git(worktreePath, ['rev-parse', `${baseline.sha}^{tree}`]) !== await git(worktreePath, ['rev-parse', `${options.snapshot}^{tree}`])) baseline = undefined
      const snapshotSha = options.forkCheckpoint && options.snapshot ? options.snapshot : baseline?.sha ?? options.snapshot
      // The thread's own pin in Mousse's namespace: no lease, as for a project folder's (`ensureProjectFolder`).
      await git(repository.primaryCheckoutPath, ['update-ref', '--no-deref', retainedRef, snapshotSha ?? head])
      const startNote = provisioning.prepared ? [options.prepared?.startNote?.(), this.placementNote].filter(Boolean).join(' ') : undefined
      const readyAt = new Date().toISOString()
      const metadata: ThreadWorkspaceMetadata = {
        ...provisioning,
        ...(snapshotSha ? { snapshotSha } : {}),
        lifecycle: 'ready',
        lastVerifiedAt: readyAt,
        ...(provisioning.prepared ? { prepared: { ...provisioning.prepared, ...(startNote ? { startNote } : {}), effectiveCheckout, readyAt } } : {})
      }
      this.journal.append({
        operationId,
        operationType: 'workspace-provision',
        state: 'completed',
        details: { intentSequence: intent.sequence, head, branch, retainedRef, effectiveCheckout }
      })
      atomicWriteJsonSync(this.workspacePath, metadata)
      if (baseline) await recordCheckoutIdentity(this.threadDirectory, worktreePath, snapshotSha!)
      noteThreadBranchChanged(threadId)
      if (nameFrom) this.nameBranchLater(threadId, branch, nameFrom, signal)
      return metadata
    } catch (error) {
      // A registered checkout still belongs to this thread. Leave its intent for recovery and never force-remove it.
      if (!registered) this.journal.append({
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

  /**
   * A provision whose `git worktree add` failed (a path too long, a full disk) leaves its record `provisioning` and no
   * worktree. Only when that is verified (the last provision is `failed` for this very path and branch, nothing is at
   * the path, and Git registers no worktree there) the record is cleared, so the thread's next message makes the
   * worktree again instead of waiting for recovery. A failed add cannot prove who made the branch, even if it has the
   * expected name and commit. Keep the ref and let the retry pick a free name. Returns whether the record was cleared;
   * anything else stays for recovery. Called with the thread's lease held (`WorkspaceResolver.resolve`).
   */
  async reconcileFailedProvision(projectPath: string, signal?: AbortSignal): Promise<boolean> {
    const metadata = this.load()
    if (!metadata || metadata.lifecycle !== 'provisioning' || isProjectFolderWorkspace(metadata)) return false
    const last = [...this.journal.latestByOperation().values()]
      .filter((entry) => entry.operationType === 'workspace-provision')
      .sort((a, b) => b.sequence - a.sequence)[0]
    if (last?.state !== 'failed') return false
    const intent = this.journal.history(last.operationId).find((entry) => entry.expectedPreState)
    const expected = intent?.expectedPreState as { worktreePath?: string; branch?: string; head?: string } | undefined
    if (!expected?.worktreePath || !samePath(expected.worktreePath, metadata.worktreePath) || expected.branch !== metadata.branch) return false
    const processRecord = await readCheckoutProcess(this.threadDirectory, last.operationId)
    if (processRecord ? !await checkoutWriterGone(processRecord) : !await checkoutProcessRecordAbsent(this.threadDirectory)) return false
    if (await pathExists(metadata.worktreePath)) return false
    const repository = await this.resolveRepositoryAsync(projectPath)
    if (repository.repositoryId !== metadata.repositoryId) return false
    const repositoryLease = await acquireWorkspaceRepositoryLease(await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true }), signal)
    try {
      if (await pathExists(metadata.worktreePath)) return false
      const listed = await tryGit(repository.primaryCheckoutPath, ['worktree', 'list', '--porcelain', '-z'])
      if (!listed.ok || listed.stdout.split('\0').some((line) => line.startsWith('worktree ') && samePath(line.slice('worktree '.length), metadata.worktreePath))) return false
      // With no verified registration, the branch's ownership is ambiguous. A new attempt chooses a fresh name.
      await rm(this.workspacePath, { force: true })
      this.journal.append({ operationId: last.operationId, operationType: 'workspace-provision', state: 'cancelled', details: { reconciled: 'worktree add failed; no worktree exists' } })
      return true
    } finally {
      repositoryLease.release()
    }
  }

  /** Checks the linked worktree's registration and that its HEAD still points to the branch and commit we reserved. */
  private async assertRegisteredAt(metadata: ThreadWorkspaceMetadata): Promise<string> {
    const registration = await worktreeRegistrationOf(metadata.worktreePath)
    if ('problem' in registration || registration.repositoryId !== metadata.repositoryId) {
      throw new Error('The worktree is no longer registered with its original repository.')
    }
    const [sha, ref] = (await git(metadata.worktreePath, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'])).split(/\r?\n/)
    if (sha !== metadata.baseSha || ref !== `refs/heads/${metadata.branch}`) throw new Error('The worktree is no longer on its original branch and commit.')
    return registration.adminDir
  }

  /**
   * Finishes an interrupted registration or checkout when the journal identifies the exact branch, commit and layout.
   * The thread's lease excludes other Mousse writers. Git preserves local edits when retrying the checkout. Files a
   * stopped checkout wrote before Git recorded its index are cleared first when they hold the commit's content.
   */
  async resumeInterruptedProvision(projectPath: string, heldThreadLease: ThreadLeaseHandle, signal?: AbortSignal): Promise<boolean> {
    assertHeldThreadLease(this.threadDirectory, heldThreadLease)
    const metadata = this.load()
    if (!metadata || metadata.lifecycle !== 'provisioning' || isProjectFolderWorkspace(metadata)) return false
    const last = [...this.journal.latestByOperation().values()]
      .filter((entry) => entry.operationType === 'workspace-provision')
      .sort((a, b) => b.sequence - a.sequence)[0]
    if (!last || !['planned', 'failed', 'completed'].includes(last.state)) return false
    const expected = this.journal.history(last.operationId).find((entry) => entry.expectedPreState)?.expectedPreState as {
      worktreePath?: string; branch?: string; head?: string; snapshot?: boolean; checkoutPlan?: WorktreeCheckoutPlan
    } | undefined
    if (!expected?.checkoutPlan || expected.worktreePath !== metadata.worktreePath || expected.head !== metadata.baseSha || expected.branch !== metadata.branch) return false
    const processRecord = await readCheckoutProcess(this.threadDirectory, last.operationId)
    if (!processRecord || !await checkoutWriterGone(processRecord)) return false
    if (!await pathExists(metadata.worktreePath)) {
      this.journal.append({ operationId: last.operationId, operationType: 'workspace-provision', state: 'failed', details: { error: 'stopped before the worktree was registered' } })
      return await this.reconcileFailedProvision(projectPath, signal)
    }
    // Pull requests and seeded forks may need work beyond checking out the commit.
    if (!processRecord.registration || metadata.untrusted || expected.snapshot) return false
    const repository = await this.resolveRepositoryAsync(projectPath)
    if (repository.repositoryId !== metadata.repositoryId) return false
    const validate = async (): Promise<string | undefined> => {
      const adminDir = await this.assertRegisteredAt(metadata)
      const registration = processRecord.registration
      return registration && samePath(registration.adminDir, adminDir) &&
        registration.identity === await checkoutRegistrationIdentity(adminDir) ? adminDir : undefined
    }
    let effectiveCheckout = (last.details as { effectiveCheckout?: string } | undefined)?.effectiveCheckout
    if (last.state !== 'completed') {
      const adminDir = await validate()
      if (!adminDir || !await recoverCheckoutIndex(adminDir, processRecord)) return false
      await populateWorktree({
        worktreePath: metadata.worktreePath, plan: expected.checkoutPlan, prefix: LONG_PATHS, signal,
        run: trackCheckoutGit(this.threadDirectory, processRecord, worktreeGit, signal),
        beforeCheckout: async () => {
          const checked = await validate()
          if (!checked) throw new Error('The worktree registration changed before checkout recovery.')
          await clearUnindexedCheckoutFiles(metadata.worktreePath, checked, async (args, input) => String(await worktreeGit(metadata.worktreePath, [...LONG_PATHS, ...args], input)))
        },
        beforeWorktreeFiles: metadata.prepared ? async () => { effectiveCheckout = await checkoutInputsKey(metadata.worktreePath) } : undefined
      })
      if (!await validate() || effectiveCheckout !== undefined && effectiveCheckout !== await checkoutInputsKey(metadata.worktreePath)) return false
      await git(repository.primaryCheckoutPath, ['update-ref', '--no-deref', metadata.retainedRef, metadata.baseSha])
      this.journal.append({ operationId: last.operationId, operationType: 'workspace-provision', state: 'completed', details: { head: metadata.baseSha, branch: metadata.branch, retainedRef: metadata.retainedRef, effectiveCheckout, resumed: true } })
    } else if (!await validate()) return false
    const now = new Date().toISOString()
    atomicWriteJsonSync(this.workspacePath, { ...metadata, lifecycle: 'ready', lastVerifiedAt: now, ...(metadata.prepared ? { prepared: { ...metadata.prepared, effectiveCheckout, readyAt: now } } : {}) } satisfies ThreadWorkspaceMetadata)
    return true
  }

  /** Claims the draft's own checkout, or releases a clean checkout whose base, layout or location has changed. */
  async claimPrepared(projectPath: string, branchId: ConversationBranchId, heldThreadLease: ThreadLeaseHandle, nameFrom?: string): Promise<ThreadWorkspaceMetadata | undefined> {
    assertHeldThreadLease(this.threadDirectory, heldThreadLease)
    const metadata = this.load()
    if (!metadata?.prepared || metadata.lifecycle !== 'ready' || isProjectFolderWorkspace(metadata)) return metadata
    if (this.preparedReleasePending(metadata)) {
      if (await this.releasePrepared(heldThreadLease) === 'released') return undefined
      throw new Error('The prepared worktree is being removed. Its files were kept.')
    }
    const repository = await this.resolveRepositoryAsync(projectPath)
    const start = threadFolderWorktreeStart(this.threadDirectory)
    const present = await pathExists(metadata.worktreePath)
    const [base, layout, trust, effectiveCheckout] = await Promise.all([
      start ?? git(repository.primaryCheckoutPath, ['rev-parse', 'HEAD']),
      worktreeCheckoutPlan(repository.gitTopLevel, undefined, { matchPreparation: true }).then(checkoutLayoutKey),
      checkoutTrustKey(repository.gitCommonDirectory),
      present && metadata.prepared.effectiveCheckout ? checkoutInputsKey(metadata.worktreePath) : undefined
    ])
    const folder = chosenWorktreeFolder(this.threadDirectory)
    if (!present || metadata.untrusted || repository.repositoryId !== metadata.repositoryId ||
        !metadata.prepared.sourceCheckout || !samePath(repository.gitTopLevel, metadata.prepared.sourceCheckout) ||
        repository.projectRelativeSubdirectory !== metadata.projectRelativeSubdirectory ||
        !effectiveCheckout || effectiveCheckout !== metadata.prepared.effectiveCheckout ||
        base !== metadata.baseSha || layout !== metadata.prepared.layout || trust !== metadata.prepared.trust || folder !== (metadata.prepared.folder ?? metadata.prepared.disconnectedFolder) ||
        (metadata.prepared.disconnectedFolder && await folderConnected(metadata.prepared.disconnectedFolder)) ||
        metadata.conversationBranchId !== branchId) {
      if (await this.releasePrepared(heldThreadLease) === 'released') return undefined
      throw new Error('The prepared worktree no longer matches the selected checkout. Its files were kept.')
    }
    await this.assertRegisteredAt(metadata)
    const { prepared: _prepared, ...claimed } = metadata
    atomicWriteJsonSync(this.workspacePath, claimed)
    const nameSource = threadFolderIsLocalOnly(this.threadDirectory) ? undefined : nameFrom?.trim() || undefined
    if (nameSource) this.nameBranchLater(metadata.threadId, metadata.branch, nameSource)
    return claimed
  }

  private preparedReleasePending(metadata: ThreadWorkspaceMetadata): ThreadJournalRecord | undefined {
    return [...this.journal.latestByOperation().values()].find((entry) => entry.operationType === PREPARED_RELEASE_OPERATION &&
      entry.state === 'planned' && (entry.details as { branch?: string } | undefined)?.branch === metadata.branch)
  }

  /**
   * Once the original path is gone, the cleanup record owns any renamed files and the old Git
   * registration. Storage cleanup can finish independently, even if only the registration is left.
   */
  async separateRenamedPreparation(heldThreadLease: ThreadLeaseHandle): Promise<boolean> {
    assertHeldThreadLease(this.threadDirectory, heldThreadLease)
    const metadata = this.load()
    const pending = metadata?.prepared && this.preparedReleasePending(metadata)
    if (!metadata || !pending) return false
    const record = await findCleanupRecord(getMousseHomeDir(), metadata.worktreePath)
    if ((record && (!samePath(record.owner, this.threadDirectory) || record.branch !== metadata.branch)) ||
        await pathExists(metadata.worktreePath)) return false
    await rm(this.workspacePath, { force: true })
    this.journal.append({ operationId: pending.operationId, operationType: PREPARED_RELEASE_OPERATION, state: 'cancelled', details: { branch: metadata.branch, cleanupId: record?.id } })
    return true
  }

  /**
   * Releases an unclaimed worktree under the thread's lease. Git removes clean worktrees without force.
   * The durable release intent also lets a restart finish dropping the branch and pin after Git removed the files.
   */
  async releasePrepared(heldThreadLease: ThreadLeaseHandle, eligible: () => boolean = () => true, signal?: AbortSignal): Promise<'released' | 'kept' | 'none'> {
    assertHeldThreadLease(this.threadDirectory, heldThreadLease)
    let metadata = this.load()
    if (!metadata?.prepared || isProjectFolderWorkspace(metadata) || metadata.untrusted) return 'none'
    const checkoutPath = metadata.integrationTarget?.checkoutPath
    if (!checkoutPath || !eligible()) return 'kept'
    if (metadata.lifecycle === 'provisioning') {
      if (!await this.reconcileFailedProvision(checkoutPath, signal) && !await this.resumeInterruptedProvision(checkoutPath, heldThreadLease, signal)) return 'kept'
      metadata = this.load()
      if (!metadata) return 'released'
    }
    if (metadata.lifecycle !== 'ready') return 'kept'
    const repository = await this.resolveRepositoryAsync(checkoutPath)
    if (!repository.capability.gitBacked || repository.repositoryId !== metadata.repositoryId) return 'kept'
    if (!eligible()) return 'kept'
    const previousRelease = this.preparedReleasePending(metadata)
    const home = getMousseHomeDir()
    const unfinished = previousRelease ? await findCleanupRecord(home, metadata.worktreePath) : undefined
    await assertWorktreeFolderConnected(metadata.worktreePath)
    const pathPresent = await pathExists(metadata.worktreePath)
    if (pathPresent && !unfinished) {
      try { await this.assertRegisteredAt(metadata) } catch { return 'kept' }
      const status = await tryGit(metadata.worktreePath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])
      if (!status.ok || status.stdout !== '') return 'kept'
    }

    const operationId = previousRelease?.operationId ?? randomUUID()
    if (!previousRelease) this.journal.append({ operationId, operationType: PREPARED_RELEASE_OPERATION, state: 'planned', details: { branch: metadata.branch } })
    const stillEligible = (): void => { if (!eligible()) throw new Error('The draft is in use.') }
    // Renaming the folder commits this cleanup. Complete it under the same thread lease even if the
    // selection changes, so the next selection can provision at a fresh path.
    const cleanup = unfinished
      ? await resumeCleanupAsync({ home, id: unfinished.id, owner: this.threadDirectory, heldThreadLease })
      : pathPresent
        ? await verifiedCleanupAsync({
          home, worktreePath: metadata.worktreePath, branch: metadata.branch, repositoryRoot: repository.primaryCheckoutPath,
          keep: {
            owner: this.threadDirectory,
            record: (step) => { if (step.phase === 'deleting') stillEligible() }
          },
          git: (args) => git(metadata!.worktreePath, args), ignored: [], filters: true, heldThreadLease
        })
        : 'gone'
    if (typeof cleanup !== 'string' && 'kept' in cleanup && await pathExists(metadata.worktreePath) && !await findCleanupRecord(home, metadata.worktreePath)) {
      this.journal.append({ operationId, operationType: PREPARED_RELEASE_OPERATION, state: 'cancelled' })
      return 'kept'
    }
    if (cleanup === 'restart' || typeof cleanup !== 'string' && 'kept' in cleanup || await pathExists(metadata.worktreePath)) return 'kept'
    const lease = await acquireWorkspaceRepositoryLease(await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true }), undefined)
    try {
      const listed = (await git(repository.primaryCheckoutPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
      const ref = `refs/heads/${metadata.branch}`
      if (listed.includes(`branch ${ref}`) ||
          listed.some((line) => line.startsWith('worktree ') && samePath(line.slice('worktree '.length), metadata!.worktreePath))) return 'kept'
      const tip = await readDirectLifecycleRefAsync(repository.primaryCheckoutPath, ref)
      if (tip && this.branchRecord(metadata).owned.has(metadata.branch)) {
        this.journal.append({ operationId: randomUUID(), operationType: BRANCH_RELEASE_OPERATION, state: 'completed', details: { branch: metadata.branch, sha: tip, worktreePath: metadata.worktreePath } })
        if (tip === metadata.baseSha && (pathPresent || previousRelease)) {
          await withOwnedBranches([metadata.branch], () => git(repository.primaryCheckoutPath, ['update-ref', '--no-deref', '-d', ref, tip]))
        }
      }
      // The pin names the checkout's first baseline when one was captured (`provision`), else its commit.
      const pinned = metadata.snapshotSha ?? metadata.baseSha
      const pin = await tryGit(repository.primaryCheckoutPath, ['rev-parse', '--verify', '-q', metadata.retainedRef])
      if (pin.ok && pin.stdout !== pinned) return 'kept'
      if (pin.ok) await git(repository.primaryCheckoutPath, ['update-ref', '--no-deref', '-d', metadata.retainedRef, pinned])
      await rm(this.workspacePath, { force: true })
      this.journal.append({ operationId, operationType: PREPARED_RELEASE_OPERATION, state: 'completed', details: { branch: metadata.branch } })
      return 'released'
    } finally {
      lease.release()
    }
  }

  /**
   * A temporary branch name for a new worktree (`<prefix>/<random id>`): no branch has it, none is under it, and no branch
   * is named after one of its folders. With the person's prefix taken as a branch itself, Mousse's default prefix.
   */
  private async freeTemporaryBranch(checkoutPath: string): Promise<string> {
    const { prefix } = branchNamingFor(this.threadDirectory)
    for (const candidate of prefix === DEFAULT_BRANCH_PREFIX ? [prefix] : [prefix, DEFAULT_BRANCH_PREFIX]) {
      if (await this.folderOfNameTaken(checkoutPath, candidate)) continue
      for (let attempt = 0; attempt < 8; attempt++) {
        const name = temporaryBranchName(candidate)
        if (!await this.branchNameTaken(checkoutPath, name)) return name
      }
    }
    throw new Error('Mousse could not find a free branch name for the worktree.')
  }

  /** Every local branch ref in the repository (`refs/heads/... -> commit sha`), exact case as Git stores it. */
  private async headRefs(checkoutPath: string): Promise<Map<string, string>> {
    const out = (await tryGit(checkoutPath, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).stdout
    const refs = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const space = line.lastIndexOf(' ')
      if (space > 0) refs.set(line.slice(0, space), line.slice(space + 1))
    }
    return refs
  }

  /** Whether a branch of this name is there, or branches under it (case-insensitively on Windows and macOS). */
  private async branchNameTaken(checkoutPath: string, name: string): Promise<boolean> {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const target = `refs/heads/${name}`.toLowerCase()
      const prefix = `${target}/`
      for (const ref of (await this.headRefs(checkoutPath)).keys()) {
        const lower = ref.toLowerCase()
        if (lower === target || lower.startsWith(prefix)) return true
      }
      return false
    }
    return (await tryGit(checkoutPath, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/heads/${name}`])).stdout !== ''
  }

  /** Whether `prefix` or one of its parent folders is a branch, so no branch can be made under it. */
  private async folderOfNameTaken(checkoutPath: string, prefix: string): Promise<boolean> {
    const parts = prefix ? prefix.split('/') : []
    if (!parts.length) return false
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const refs = new Set([...(await this.headRefs(checkoutPath)).keys()].map((ref) => ref.toLowerCase()))
      for (let index = 1; index <= parts.length; index++) {
        if (refs.has(`refs/heads/${parts.slice(0, index).join('/')}`.toLowerCase())) return true
      }
      return false
    }
    for (let index = 1; index <= parts.length; index++) {
      if ((await tryGit(checkoutPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${parts.slice(0, index).join('/')}`])).ok) return true
    }
    return false
  }

  /** Whether a rename of the worktree's branch has no outcome recorded; reads only the journal's index of latest records. */
  branchRenamePending(): boolean {
    for (const entry of this.journal.latestByOperation().values()) if (entry.operationType === BRANCH_RENAME_OPERATION && (entry.state === 'planned' || entry.state === 'git_applied')) return true
    return false
  }

  /** The branches Mousse's records show it made for this thread's worktree, by their current names (`threadBranchRecord`). */
  branchRecord(metadata = this.load()): ThreadBranchRecord {
    return threadBranchRecord(this.journal.ofTypes(...BRANCH_RECORD_OPERATIONS), metadata && !isProjectFolderWorkspace(metadata) ? { worktreePath: metadata.worktreePath } : {})
  }

  /** Names an original temporary branch when the first message has been accepted, including after a cancelled setup. */
  nameTemporaryBranch(threadId: string, branch: string, text: string, signal: AbortSignal): void {
    this.nameBranchLater(threadId, branch, text, signal, 'send')
  }

  /** The background naming of the branch, settled once it has its new name or keeps its name. */
  branchNaming?: Promise<void>

  /** Asks the title model for a name for the new worktree's branch and renames it, in the background; never throws. */
  private nameBranchLater(threadId: string, branch: string, text: string, signal?: AbortSignal, namingOrigin?: NamingOrigin): void {
    this.branchNaming = Promise.resolve().then(async () => {
      if (signal?.aborted) return
      if (namingOrigin === 'send' && (threadFolderIsLocalOnly(this.threadDirectory) || !this.branchRecord().temporary.has(branch))) return
      const name = await requestBranchName(this.threadDirectory, threadId, text, undefined, signal, namingOrigin)
      if (!name || name === branch || signal?.aborted) return
      const outcome = await this.renameOwnBranch(branch, name, signal)
      if (outcome !== 'renamed') console.info('[branches] the worktree branch keeps its temporary name', { threadId, reason: outcome })
    }).catch((error) => {
      if (!signal?.aborted) console.warn('[branches] the worktree branch could not be renamed', { threadId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Why the thread's branch `from` may not be renamed now, or undefined when it may. Reads only Mousse's records. */
  private renameRefusal(from: string): string | undefined {
    const metadata = this.load()
    if (!metadata || isProjectFolderWorkspace(metadata) || metadata.lifecycle !== 'ready') return 'the worktree is not ready'
    if (metadata.branch !== from) return 'the workspace records another branch'
    // A worktree being retired or rebuilt keeps the name its reconstruction record has.
    if (this.hasReconstructionManifest(metadata) || this.rebuildUnfinished(metadata)) return 'the worktree is being retired or rebuilt'
    const record = this.branchRecord(metadata)
    if (record.pending) return 'another rename is not settled'
    if (!record.owned.has(from)) return 'Mousse did not make this branch'
    if (!record.reflogIds.has(from)) return 'Mousse has no recorded branch identity'
    return undefined
  }

  /**
   * Renames the verified branch under its Git ref lock. Git cannot delete a branch through the same transaction that
   * changes its worktree's symbolic HEAD. Keep the original branch locked while Git creates the destination and changes
   * HEAD together, then delete the original. If interrupted in between, both tips remain reachable.
   *
   * The journal moves ownership only after Git's result is verified. See `settleBranchRename` for interrupted renames.
   */
  async renameOwnBranch(from: string, to: string, signal?: AbortSignal): Promise<string> {
    if (!isAcceptableThreadBranchName(to) || to === from) return 'the name is not usable'
    const early = this.renameRefusal(from)
    if (early) return early
    const checkoutPath = this.load()?.integrationTarget?.checkoutPath
    if (!checkoutPath) return 'the workspace records no project checkout'
    const metadata = this.load()!
    const repository = await this.resolveRepositoryAsync(checkoutPath)
    if (!repository.capability.gitBacked || repository.repositoryId !== metadata.repositoryId) return 'the repository changed'
    let lease: RepositoryLeaseHandle
    try {
      lease = await acquireRepositoryLease(await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true }), { signal, maxWaitMs: 30_000 })
    } catch (error) {
      if (error instanceof RepositoryLeaseBusyError) return 'the repository is busy'
      throw error
    }
    try {
      const primary = repository.primaryCheckoutPath
      const refusal = this.renameRefusal(from)
      if (refusal) return refusal
      const current = this.load()!
      if (!await pathExists(current.worktreePath)) return 'the worktree is not there'
      const fromRef = `refs/heads/${from}`
      if ((await tryGit(current.worktreePath, ['symbolic-ref', '-q', 'HEAD'])).stdout !== fromRef) return 'the worktree is on another branch'
      const tip = (await this.headRefs(primary)).get(fromRef)
      if (!tip) return 'the branch is gone'
      // Pushed already (an upstream is set): the remote branch keeps the old name, and pushing or opening a pull request
      // from the renamed one would fail, so it keeps its name.
      if ((await tryGit(primary, ['config', '--get', `branch.${from}.remote`])).stdout) return 'the branch has an upstream'
      if (await this.branchNameTaken(primary, to)) return 'the name is taken'
      if (signal?.aborted) return 'naming was cancelled'
      const commonDir = repository.gitCommonDirectory
      const original = branchReflogIdentity(commonDir, fromRef)
      if (!original || original.id !== this.branchRecord(current).reflogIds.get(from)) return 'the branch no longer matches its recorded identity'
      const operationId = randomUUID()
      const plan = { from, to, worktreePath: current.worktreePath, fromReflogId: original.id }
      const intent = this.journal.append({ operationId, operationType: BRANCH_RENAME_OPERATION, state: 'planned', expectedPreState: plan })
      const pending = { ...plan, operationId, sequence: intent.sequence }
      const toRef = `refs/heads/${to}`
      const message = `mousse: rename ${operationId}`
      const sourceConfig = `branch.${from}`
      const destinationConfig = `branch.${to}`
      let toReflogId: string | undefined
      let reason = 'the branch or its worktree changed'
      try {
        await withOwnedBranches([from, to], () => deleteVerifiedBranchAsync(primary, fromRef, tip, async () => {
          signal?.throwIfAborted()
          if (branchReflogIdentity(commonDir, fromRef)?.version !== original.version) return false
          const listing = await git(primary, ['worktree', 'list', '--porcelain', '-z'])
          if (listing.split('\0').filter((field) => field === `branch ${fromRef}`).length !== 1) return false
          const keys = (await git(primary, ['config', '--local', '--list', '--name-only'])).split(/\r?\n/)
          const sections = new Set(keys.map((key) => key.slice(0, key.lastIndexOf('.'))))
          if (sections.has(destinationConfig)) {
            reason = 'the destination has branch configuration'
            return false
          }
          if (keys.includes(`${sourceConfig}.remote`)) {
            reason = 'the branch has an upstream'
            return false
          }
          const moved = await verifiedRefTransactionAsync(current.worktreePath,
            `create ${toRef} ${tip}\nsymref-update HEAD ${toRef} ref ${fromRef}\n`, async () => {
              signal?.throwIfAborted()
              if (branchReflogIdentity(commonDir, fromRef)?.version !== original.version) return false
              // Git's create/delete transaction does not transfer a reflog. Keep its history while both refs are locked.
              const toLog = join(commonDir, 'logs', toRef)
              await mkdir(dirname(toLog), { recursive: true })
              await copyFile(join(commonDir, 'logs', fromRef), toLog, constants.COPYFILE_EXCL)
              return true
            }, message)
          if (!moved) return false
          toReflogId = branchReflogIdentity(commonDir, toRef, { message })?.id
          if (!toReflogId) return false
          if (sections.has(sourceConfig)) {
            return verifiedRefTransactionAsync(primary, `verify ${toRef} ${tip}\n`, async () => {
              if (branchReflogIdentity(commonDir, toRef)?.id !== toReflogId) return false
              await git(primary, ['config', '--local', '--rename-section', sourceConfig, destinationConfig])
              return true
            })
          }
          return true
        }))
      } catch (error) {
        reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      }
      if (!toReflogId) {
        await this.settlePendingRename(primary, commonDir, pending)
        return `Git did not rename it: ${reason}`
      }
      this.journal.append({ operationId, operationType: BRANCH_RENAME_OPERATION, state: 'git_applied', details: { reflogId: original.id, toReflogId } })
      this.recordBranchName(from, to)
      this.journal.append({ operationId, operationType: BRANCH_RENAME_OPERATION, state: 'completed', details: { intentSequence: intent.sequence, from, to } })
      return 'renamed'
    } finally {
      lease.release()
    }
  }

  /**
   * Settles a rename a stop left without an outcome. The destination must match the reflog identity the rename
   * verified and recorded. When the outcome is uncertain, both names
   * are given up. Takes the repository's lease unless the caller holds it.
   */
  async settleBranchRename(options: { holdingRepositoryLease?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const metadata = this.load()
    if (!metadata || isProjectFolderWorkspace(metadata)) return
    const pending = this.branchRecord(metadata).pending
    // A retired worktree's reconstruction record names the branch as it was; it is settled once nothing is retired.
    if (!pending || this.hasReconstructionManifest(metadata)) return
    if (!metadata.integrationTarget?.checkoutPath) return
    const repository = await this.resolveRepositoryAsync(metadata.integrationTarget.checkoutPath)
    if (!repository.capability.gitBacked || repository.repositoryId !== metadata.repositoryId) return
    const lease = options.holdingRepositoryLease ? undefined : await acquireWorkspaceRepositoryLease(await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true }), options.signal)
    try {
      const again = this.branchRecord(this.load()).pending
      if (again?.operationId === pending.operationId) await this.settlePendingRename(repository.primaryCheckoutPath, repository.gitCommonDirectory, again)
    } finally {
      lease?.release()
    }
  }

  private async settlePendingRename(primary: string, commonDir: string, pending: PendingBranchRename): Promise<void> {
    const { from, to, worktreePath, operationId, fromReflogId, gitApplied, toReflogId } = pending
    // Exact-case ref lookup so a case-only sibling on Windows/macOS is never mistaken for `to` or `from`.
    const refs = await this.headRefs(primary)
    const fromRef = `refs/heads/${from}`
    const toRef = `refs/heads/${to}`
    const fromTip = refs.get(fromRef)
    const toTip = refs.get(toRef)
    const recordedId = this.branchRecord().reflogIds.get(from)
    const proven = recordedId !== undefined && recordedId === fromReflogId
    const renamed = proven && gitApplied && (toReflogId || !fromTip) && toTip &&
      branchReflogIdentity(commonDir, toRef)?.id === (toReflogId ?? recordedId)
    const unchanged = proven && !gitApplied && fromTip && !toTip && branchReflogIdentity(commonDir, fromRef)?.id === recordedId
    const outcome = renamed ? 'renamed' : unchanged ? 'not-renamed' : 'unknown'
    const head = outcome === 'renamed' && await pathExists(worktreePath)
      ? (await tryGit(worktreePath, ['symbolic-ref', '-q', 'HEAD'])).stdout : ''
    if (outcome === 'renamed' && toTip && !fromTip && head === fromRef) {
      try {
        // Legacy renames could record success before fixing a stale HEAD. Compare its target before replacing it.
        const repaired = await withOwnedBranches([from, to], () => verifiedRefTransactionAsync(worktreePath,
          `verify ${toRef} ${toTip}\nsymref-update HEAD ${toRef} ref ${fromRef}\n`,
          () => branchReflogIdentity(commonDir, toRef)?.id === (toReflogId ?? recordedId)))
        if (!repaired) return
      } catch (error) {
        rethrowGitPolicyError(error)
        // HEAD could not be moved: nothing is recorded, and the next turn settles it again.
        return
      }
    }
    if (outcome === 'renamed') {
      this.recordBranchName(from, to)
      this.journal.append({ operationId, operationType: BRANCH_RENAME_OPERATION, state: 'completed', details: { from, to, settled: true } })
    } else {
      if (outcome === 'not-renamed') this.recordBranchName(to, from)
      this.journal.append({ operationId, operationType: BRANCH_RENAME_OPERATION, state: outcome === 'unknown' ? 'cancelled' : 'failed', details: { from, to, settled: true, ...(outcome === 'unknown' ? { disowned: true } : {}) } })
    }
  }

  /** Points workspace.json at `to` when it names `from`; every other field stays as written. */
  private recordBranchName(from: string, to: string): void {
    const stored = JSON.parse(readFileSync(this.workspacePath, 'utf8')) as ThreadWorkspaceMetadata
    if (stored.branch !== from) return
    atomicWriteJsonSync(this.workspacePath, { ...stored, branch: to })
    noteThreadBranchChanged(stored.threadId)
  }

  /**
   * Whether Git registers a worktree at `path`, or any thread's reconstruction manifest names it. Git's registrations are
   * read without running Git (`worktreeRegistry`), once for all the names one placement tries (`registrations`).
   */
  private async pathNamed(commonDir: string, path: string, registrations: WorktreeListPass): Promise<boolean> {
    const fold = (value: string): string => process.platform === 'win32' || process.platform === 'darwin' ? resolve(value).toLowerCase() : resolve(value)
    // A repository Git could not list names nothing here, as before.
    if (await findListedWorktreeAsync(commonDir, path, (listed, wanted) => fold(listed) === fold(wanted), { pass: registrations }).catch(() => undefined)) return true
    const gate = getThreadLifecycleGate(this.threadDirectory)
    if (!(gate instanceof ResourceLifecycleStore)) return false
    const retirement = new WorktreeRetirementService(gate)
    let tasks: string[] = []
    try { tasks = await readdir(join(gate.root, 'workspaces')) } catch { return false }
    for (const task of tasks) if (await access(retirement.pathFor(task, path)).then(() => true, () => false)) return true
    return false
  }

  hasReconstructionManifest(metadata = this.load()): boolean {
    const gate = getThreadLifecycleGate(this.threadDirectory)
    return Boolean(metadata && gate instanceof ResourceLifecycleStore && existsSync(new WorktreeRetirementService(gate).pathFor(metadata.threadId, metadata.worktreePath)))
  }

  /**
   * `onNotice` gets what the thread should be told about the restore, once it has finished: files a rebuild set aside
   * (`keptAsideNotice`), with the command that brings each back. A failure to deliver it leaves the restore done.
   */
  async restore(projectPath: string, signal?: AbortSignal, heldThreadLease?: ThreadLeaseHandle, onNotice?: (notice: { id: string; text: string }) => unknown): Promise<ThreadWorkspaceMetadata> {
    // The project folder is the person's own: there is no worktree to bring back.
    const current = this.load()
    if (isProjectFolderWorkspace(current)) return this.verify(current)
    if (!current) throw new Error('Thread workspace metadata is missing')
    // A disconnected drive must return before anything is rebuilt at its mount point.
    await assertWorktreeFolderConnected(current.worktreePath)
    const unfinishedProvision = () => [...this.journal.latestByOperation().values()]
      .some((entry) => entry.operationType === 'workspace-provision' && !['completed', 'cancelled'].includes(entry.state))
    const initial = await this.verify(current)
    if (initial.lifecycle === 'ready' && current.lifecycle === 'ready' && !unfinishedProvision()) {
      const latest = this.load()
      if (latest && !latest.rebuilding && latest.generation === current.generation && latest.worktreePath === current.worktreePath) return initial
    }

    let threadLease: ThreadLeaseHandle | undefined
    let repositoryLease: RepositoryLeaseHandle | undefined
    try {
      if (heldThreadLease) assertHeldThreadLease(this.threadDirectory, heldThreadLease)
      threadLease = heldThreadLease ?? await waitAcquireExecutionLease(this.threadDirectory, { source: 'workspace-restore', signal })
      // Recheck under the lease. A restore that waited for another one sees the generation it already published.
      const metadata = this.load()
      if (!metadata) throw new Error('Thread workspace metadata is missing')
      if (isProjectFolderWorkspace(metadata)) return this.verify(metadata)
      await assertWorktreeFolderConnected(metadata.worktreePath)
      // A checkout a stop or a daemon exit interrupted is finished when its journal names it exactly; otherwise it waits.
      if (metadata.lifecycle === 'provisioning') {
        if (await this.resumeInterruptedProvision(projectPath, threadLease, signal)) {
          const recovered = this.load()
          if (recovered) return recovered
        }
        throw new Error('Workspace recovery is blocked: provisioning')
      }
      const verified = await this.verify(metadata)
      if (verified.lifecycle === 'ready' && metadata.lifecycle === 'ready' && !unfinishedProvision()) return verified
      const leftover = (verified.lifecycle === 'recovery_required' || metadata.rebuilding) && await this.partlyRemoved(metadata)
      if (verified.lifecycle !== 'missing' && verified.lifecycle !== 'ready' && !leftover) throw new Error(`Workspace recovery is blocked: ${verified.lifecycle}`)
      const repository = await this.resolveRepositoryAsync(projectPath)
      if (repository.repositoryId !== metadata.repositoryId) throw new Error('Workspace recovery repository identity changed.')
      repositoryLease = await acquireWorkspaceRepositoryLease(await resolveRepositoryIdentityAsync(repository.gitTopLevel, { requireMutationCapability: true }), signal)
      if (verified.lifecycle === 'ready') {
        const ready = await this.verify(metadata)
        if (ready.lifecycle !== 'ready') throw new Error('Workspace changed while acquiring recovery ownership.')
        await git(ready.worktreePath, ['update-ref', '--no-deref', ready.retainedRef, ready.snapshotSha ?? ready.headSha])
        atomicWriteJsonSync(this.workspacePath, ready)
        this.finishProvisionRecovery(ready)
        return ready
      }
      // The manifest tracks reconstruction of the files. The workspace record fences readers through verification and
      // clears the fence atomically with the generation update, including when there is only a retained snapshot.
      const beginRebuild = () => atomicWriteJsonSync(this.workspacePath, { ...metadata, rebuilding: true })
      const { rebuilding: _rebuilding, ...next } = { ...metadata, generation: (metadata.generation ?? 0) + 1 }
      const gate = getThreadLifecycleGate(this.threadDirectory)
      if (gate instanceof ResourceLifecycleStore && this.hasReconstructionManifest(metadata)) {
        const retirement = new WorktreeRetirementService(gate, { taskLease: threadLease, repositoryLease })
        const manifestPath = retirement.pathFor(metadata.threadId, metadata.worktreePath)
        const manifest = retirement.load(manifestPath)
        // HEAD is the agent's to move, so the one the worktree had when retired is not compared with the last one Mousse saw.
        if (manifest.branch !== metadata.branch || manifest.repositoryId !== metadata.repositoryId) throw new Error('Retired workspace manifest disagrees with authoritative task binding')
        // Refused before the rebuild registers anything: a worktree made and then refused would be left empty, without its safety.
        if (metadata.untrusted) await assertPerWorktreeConfig(repository.gitTopLevel)
        // The worktree's own configuration went with the worktree: for someone else's commits it is put back before anything is checked out.
        const safety = metadata.untrusted ? await untrustedSafety(repository.gitTopLevel) : undefined
        beginRebuild()
        if (leftover && await this.partlyRemoved(metadata)) await this.setAsidePartlyRemoved(metadata)
        const rebuilt = await retirement.reconstruct(manifestPath, safety ? { prepare: async (path) => pinUntrustedWorktree(path, await untrustedSafety(path, true)), env: { ...nonInteractiveGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' } } : undefined)
        if (metadata.untrusted) await pinUntrustedWorktree(metadata.worktreePath, await untrustedSafety(metadata.worktreePath, true), true)
        const restored = await this.verify(next)
        if (restored.lifecycle !== 'ready') throw new Error('Reconstructed task workspace failed verification')
        atomicWriteJsonSync(this.workspacePath, restored)
        noteThreadBranchChanged(restored.threadId)
        const notice = retirement.keptAsideNotice(rebuilt)
        if (notice) {
          // The copies are kept and listed in the thread's journal either way; only the line in the thread is missing then.
          try { await onNotice?.(notice) } catch (error) { console.warn('restore notice could not be delivered', { threadId: metadata.threadId, error: error instanceof Error ? error.message : String(error) }) }
        }
        return restored
      }
      // The files come from the retained snapshot, and the worktree starts at the HEAD the snapshot was taken on: on the
      // branch it was on, or on the thread's own, when that branch still is at that commit; detached there otherwise.
      if (metadata.rebuilding && await pathExists(metadata.worktreePath)) {
        throw new Error('An interrupted restore left files at the worktree path. Move them somewhere safe and remove the old worktree registration before retrying.')
      }
      const retained = await git(repository.gitTopLevel, ['rev-parse', '--verify', `${metadata.retainedRef}^{commit}`])
      const origin = await snapshotOriginAsync(repository.gitTopLevel, retained)
      const head = origin.head ?? await git(repository.gitTopLevel, ['rev-parse', '--verify', `${metadata.branch}^{commit}`])
      const tip = async (branch: string): Promise<string | undefined> => (await tryGit(repository.gitTopLevel, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`])).stdout || undefined
      let branch: string | undefined
      for (const name of [origin.branch, metadata.branch]) if (name && await tip(name) === head) { branch = name; break }
      // A restore is never refused for the pattern file: without it, the worktree comes back whole.
      const checkoutPlan = await worktreeCheckoutPlan(repository.gitTopLevel).catch(() => worktreeCheckoutPlan(repository.gitTopLevel, undefined, { sparse: false }))
      beginRebuild()
      await mkdir(dirname(metadata.worktreePath), { recursive: true })
      const addRestoredCheckout = async (target: string[]): Promise<void> => {
        if (metadata.untrusted) await addUntrustedWorktree(repository.gitTopLevel, target, metadata.worktreePath, checkoutPlan)
        else await addWorktree({ cwd: repository.gitTopLevel, worktreePath: metadata.worktreePath, add: target, plan: checkoutPlan, prefix: LONG_PATHS })
      }
      // A branch that another worktree has checked out cannot be added again; the commit can.
      if (branch) { try { await addRestoredCheckout([metadata.worktreePath, branch]) } catch { await addRestoredCheckout(['--detach', metadata.worktreePath, head]) } }
      else await addRestoredCheckout(['--detach', metadata.worktreePath, head])
      const moved = await moveFilesToSnapshotAsync(metadata.worktreePath, await git(metadata.worktreePath, ['rev-parse', 'HEAD^{tree}']), retained, { owner: this.threadDirectory, action: 'Restoring the worktree' })
      const movedNotice = movedFilesNotice(moved)
      if (movedNotice) {
        try { await onNotice?.({ id: `worktree-restore-${randomUUID()}`, text: movedNotice }) } catch (error) { console.warn('restore notice could not be delivered', { threadId: metadata.threadId, error: error instanceof Error ? error.message : String(error) }) }
      }
      const restored = await this.verify(next)
      if (restored.lifecycle !== 'ready') throw new Error('Restored task workspace failed verification')
      atomicWriteJsonSync(this.workspacePath, restored)
      if (restored.lifecycle === 'ready') await recordCheckoutIdentity(this.threadDirectory, restored.worktreePath)
      this.finishProvisionRecovery(restored)
      noteThreadBranchChanged(restored.threadId)
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
  private async partlyRemoved(metadata: ThreadWorkspaceMetadata): Promise<boolean> {
    if (await pathExists(join(metadata.worktreePath, '.git')) || !await pathExists(metadata.worktreePath) || !this.hasReconstructionManifest(metadata)) return false
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
  private async setAsidePartlyRemoved(metadata: ThreadWorkspaceMetadata): Promise<void> {
    const gate = getThreadLifecycleGate(this.threadDirectory) as ResourceLifecycleStore
    const retirement = new WorktreeRetirementService(gate)
    const manifest = retirement.load(retirement.pathFor(metadata.threadId, metadata.worktreePath))
    const aside = `${metadata.worktreePath}.partial-${Date.now()}`
    try { await rename(metadata.worktreePath, aside) }
    catch { throw new Error('The worktree was partly removed and programs are still using files in it; close them and try again.') }
    try {
      const retained = new Map(manifest.content.map((entry) => [entry.path, entry]))
      // What `lstat` says of every entry is read before the bytes are, so a write after that read is still seen right
      // before the delete, which starts with nothing awaited after that check.
      const signature = await folderSignatureAsync(aside, true)
      const content = await walkOwnedContentAsync(aside, true)
      const verified = content.every((entry) => entry.kind === 'directory' || (retained.get(entry.path)?.kind === entry.kind && retained.get(entry.path)?.digest === entry.digest))
      if (!verified) return
      assertFolderUnchanged(aside, signature, content, true)
      await rm(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* The moved folder stays; the worktree is rebuilt beside it. */ }
  }

  private finishProvisionRecovery(metadata: ThreadWorkspaceMetadata): void {
    for (const operation of this.journal.latestByOperation().values()) {
      if (operation.operationType !== 'workspace-provision' || ['completed', 'cancelled'].includes(operation.state)) continue
      const intent = this.journal.history(operation.operationId).find((entry) => entry.expectedPreState)
      const expected = intent?.expectedPreState as { worktreePath?: string; branch?: string } | undefined
      if (expected?.worktreePath !== metadata.worktreePath || expected.branch !== metadata.branch) continue
      this.journal.append({ operationId: operation.operationId, operationType: 'workspace-provision', state: 'completed', details: { recovered: true, head: metadata.headSha, branch: metadata.branch, retainedRef: metadata.retainedRef } })
    }
  }

  /**
   * An operation that started and did not finish, so a person or recovery has to settle it before the next one.
   * `inFlight` (status reads only, never admission) names records a live writer is still finishing; they are skipped.
   */
  hasPendingOperation(inFlight?: InFlightTest): boolean {
    // A publish waiting to be settled concerns the primary checkout only, so it does not hold up the thread.
    return this.journal.unsettled().some((entry) => ['prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state) && !['publish', 'change-publish'].includes(entry.operationType) && !settlesItself(entry.operationType) && !inFlight?.(entry))
  }

  /**
   * {@link verify}, blocking: only for the chat workspace check that the synchronous chat and browser APIs make
   * (`AgentChatService.workspace`). Everything else uses `verify`.
   */
  verifySync(metadata = this.load()): ThreadWorkspaceMetadata {
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    if (metadata.lifecycle === 'provisioning') return metadata
    if (this.rebuildUnfinished(metadata)) return { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
    if (!existsSync(metadata.worktreePath)) return { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
    if (!isProjectFolderWorkspace(metadata) && chosenFolderHolding(metadata.worktreePath) && 'problem' in worktreeRegistrationOfSync(metadata.worktreePath)) {
      return { ...metadata, lifecycle: 'recovery_required' as const, lastVerifiedAt: new Date().toISOString() }
    }
    try {
      gitSync(metadata.worktreePath, ['rev-parse', '--show-toplevel'])
      if (this.hasPendingOperation()) throw new Error('A Mousse operation is waiting for recovery.')
      let headSha: string
      try { headSha = gitSync(metadata.worktreePath, ['rev-parse', 'HEAD']) || metadata.headSha } catch (error) { rethrowGitPolicyError(error); headSha = metadata.headSha }
      return { ...metadata, lifecycle: 'ready' as const, headSha, lastVerifiedAt: new Date().toISOString() }
    } catch {
      return { ...metadata, lifecycle: 'recovery_required' as const, lastVerifiedAt: new Date().toISOString() }
    }
  }

  /** Reads the worktree with Git and async calls, never blocking the daemon. */
  /**
   * The repository moved (and `git worktree repair` brought its worktrees along): the round trip of the worktree's `.git`
   * proved which repository registers it, and that repository holds the thread's own retained ref, so it is the same one
   * under a new key. The record takes the new key; anything else about it stays. An unrelated repository never holds
   * the thread's ref, and the record is then left as it is, and the worktree refused.
   */
  private async rebind(metadata: ThreadWorkspaceMetadata, repositoryId: string): Promise<ThreadWorkspaceMetadata> {
    if (!metadata.retainedRef || !(await tryGit(metadata.worktreePath, ['rev-parse', '--verify', '-q', `${metadata.retainedRef}^{commit}`])).ok) {
      return { ...metadata, lifecycle: 'recovery_required' as const }
    }
    const rebound = { ...metadata, repositoryId }
    // Written only over the record it was read from, so a write that came in meanwhile is never undone.
    try {
      const stored = JSON.parse(readFileSync(this.workspacePath, 'utf8')) as ThreadWorkspaceMetadata
      if (stored.repositoryId === metadata.repositoryId && stored.worktreePath === metadata.worktreePath) atomicWriteJsonSync(this.workspacePath, { ...stored, repositoryId })
    } catch (error) {
      console.warn('the moved repository could not be recorded', { threadId: metadata.threadId, error: error instanceof Error ? error.message : String(error) })
    }
    return rebound
  }

  /**
   * Whether an operation of Mousse's own on the worktree did not finish: one its journal still waits on, a rebuild that
   * stopped, or a retirement that left the folder partly removed. A worktree that is gone or that Git cannot read
   * without any of these was removed or emptied by someone else (the agent, the person), and nothing waits to recover it.
   */
  async ownOperationUnfinished(metadata: ThreadWorkspaceMetadata, inFlight?: InFlightTest): Promise<boolean> {
    return this.hasPendingOperation(inFlight) || this.rebuildUnfinished(metadata) || await this.partlyRemoved(metadata)
  }

  /** Whether the worktree's record has a rebuild that did not finish: the folder at its path is then not the worktree. */
  rebuildUnfinished(metadata: ThreadWorkspaceMetadata): boolean {
    const gate = getThreadLifecycleGate(this.threadDirectory)
    return !isProjectFolderWorkspace(metadata) && (metadata.rebuilding === true ||
      gate instanceof ResourceLifecycleStore && new WorktreeRetirementService(gate).rebuildUnfinished(metadata.threadId, metadata.worktreePath))
  }

  /** `inFlight`: for status reads only, as in {@link hasPendingOperation}. */
  async verify(metadata = this.load(), options: { inFlight?: InFlightTest } = {}): Promise<ThreadWorkspaceMetadata> {
    if (!metadata) throw new Error('Thread workspace metadata is missing')
    if (metadata.lifecycle === 'provisioning') return metadata
    // An unfinished rebuild is never the worktree, whatever is at its path: the next restore finishes it (`clearHalfBuilt`).
    if (this.rebuildUnfinished(metadata)) return { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
    if (!await pathExists(metadata.worktreePath)) {
      const missing = { ...metadata, lifecycle: 'missing' as const, lastVerifiedAt: new Date().toISOString() }
      return missing
    }
    // In a worktree folder the person chose, before any Git runs there: the folder must be this repository's registered
    // worktree, or it is someone else's (another drive at the same path, a folder put there by hand).
    if (!isProjectFolderWorkspace(metadata) && chosenFolderHolding(metadata.worktreePath)) {
      const registration = await worktreeRegistrationOf(metadata.worktreePath)
      if ('problem' in registration) return { ...metadata, lifecycle: 'recovery_required' as const, lastVerifiedAt: new Date().toISOString() }
      if (registration.repositoryId !== metadata.repositoryId) {
        const rebound = await this.rebind(metadata, registration.repositoryId)
        if (rebound.lifecycle === 'recovery_required') return { ...rebound, lastVerifiedAt: new Date().toISOString() }
        metadata = rebound
      }
    }
    try {
      // The branch and HEAD are the agent's to move: ready means the checkout is there and no Mousse operation waits.
      // A worktree of the thread's own is read from Git's files (`worktreeHeadFiles.ts`), so its turn starts with no Git;
      // otherwise a turn's start asks once for all its callers (`repositoryFacts.ts`), Git's answer being the checkout there.
      const files = isProjectFolderWorkspace(metadata) ? undefined : await readRecordedCheckoutHead(this.threadDirectory, metadata.worktreePath)
      const facts = files ? undefined : await repositoryFacts(metadata.worktreePath)
      if (!files && !facts) await git(metadata.worktreePath, ['rev-parse', '--show-toplevel'])
      if (this.hasPendingOperation(options.inFlight)) throw new Error('A Mousse operation is waiting for recovery.')
      const headSha = (files ? files.head : facts ? facts.head : (await tryGit(metadata.worktreePath, ['rev-parse', 'HEAD'])).stdout) || metadata.headSha
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
  private async currentBranch(metadata: ThreadWorkspaceMetadata): Promise<string | undefined> {
    if (!await pathExists(metadata.worktreePath)) return metadata.branch
    const files = isProjectFolderWorkspace(metadata) ? undefined : await readRecordedCheckoutHead(this.threadDirectory, metadata.worktreePath)
    if (files) return branchOfHeadRef(files.headRef)
    const facts = await repositoryFacts(metadata.worktreePath)
    if (facts) return branchOfHeadRef(await facts.headRef())
    // A plain read: a branch name when HEAD is on one; detached HEAD answers nothing.
    if (!(await tryGit(metadata.worktreePath, ['rev-parse', '--git-dir'])).ok) return metadata.branch
    const current = await tryGit(metadata.worktreePath, ['symbolic-ref', '-q', '--short', 'HEAD'])
    return current.ok ? current.stdout.replace(/^heads\//, '') || undefined : undefined
  }

  /**
   * The folder a turn of this thread works in: `executionContext(...).projectPath`, without reading Git (it is worked
   * out from the record alone). `projectPath` when the thread has no workspace record.
   */
  workingFolder(projectPath: string, metadata = this.load()): string {
    if (!metadata || metadata.prepared) return projectPath
    return metadata.projectRelativeSubdirectory === '.' ? metadata.worktreePath : join(metadata.worktreePath, metadata.projectRelativeSubdirectory)
  }

  /** The thread's execution context; the branch HEAD is on is read with Git, without blocking the daemon. */
  async executionContext(projectPath: string, metadata = this.load()): Promise<WorkspaceExecutionContext> {
    if (!metadata || metadata.prepared) {
      return {
        threadId: '',
        workspacePath: projectPath,
        projectPath,
        primaryPath: projectPath,
        lifecycle: 'unprovisioned',
        capability: capability('Thread workspace has not been provisioned')
      }
    }
    const relativeProject = this.workingFolder(projectPath, metadata)
    return {
      threadId: metadata.threadId,
      workspacePath: metadata.worktreePath,
      projectPath: relativeProject,
      primaryPath: projectPath,
      branch: metadata.lifecycle === 'provisioning' ? metadata.branch : await this.currentBranch(metadata),
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
