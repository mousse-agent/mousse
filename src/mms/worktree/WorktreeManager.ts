import { access, mkdir, readdir, stat } from 'fs/promises'
import { GIT_NULL_DEVICE } from '../git/gitNullDevice'
import { basename, join, relative, resolve, sep } from 'path'
import simpleGit, { SimpleGit } from 'simple-git'
import { guardedSimpleGit, HOOK_EVENTS, policedSimpleGit, repoProgramEnv, UNSAFE_ALLOWED } from '../git/repoPrograms'
import { RepositoryContext } from './RepositoryContext'
import { WorktreeIdentity } from './WorktreeIdentity'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'
import { keepCopy, KeepCopyRefusedError, KeepCopyTooLargeError, type KeptCopy } from '../actions/keptCopies'
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { withGitAccess } from '../git/gitPolicy'


/** `existsSync` without blocking the daemon. */
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

export interface WorktreeInfo {
  path: string
  branch: string
  repositoryRoot?: string
  baseSha?: string
}

/** Who keeps the copy of a worktree's ignored files that cleanup makes before it removes the worktree. */
export interface KeepIgnoredFiles {
  /** The journal folder that owns the copy: the dispatch's (`dispatchKeptFilesOwner`), or the agent's thread's. */
  owner: string
  /**
   * Told before anything is kept, then once the copy is complete and before the removal starts, so the caller can
   * record each step durably first. Whatever was recorded last tells a later start what happened; nothing is replayed.
   */
  record?: (step: { phase: 'keeping'; files: number } | { phase: 'removing'; ref: string; sha: string; files: number }) => void
}

export interface WorktreeCleanupResult {
  success: boolean
  error?: string
  /** The worktree was not removed, because its ignored files could not be kept first. Nothing in it changed. */
  kept?: { ignoredFiles: number; reason: string; code: 'keep_copy_too_large' | 'keep_copy_refused' | 'nested_repository' | 'no_owner' }
  /** The copy of the ignored files kept before the worktree was removed. */
  copy?: { ref: string; sha: string; files: number; windowMs: number }
}

export interface GhostWorktreeEntry {
  path: string
  name: string
  reason: string
}

export interface OrphanWorktreeReport {
  /** Absolute base directory scanned (`.mousse-worktrees`). */
  basePath: string
  /** Directories that look like Mousse agent worktrees and match known agent records. */
  knownAgentDirs: string[]
  /**
   * Directories under the base path that are not registered git worktrees and are not
   * known agent paths — e.g. typo / progress-only folders. Reported only; never auto-deleted.
   */
  ghostDirectories: GhostWorktreeEntry[]
  /** Git worktree paths under the base that do not match any known agent record. */
  staleGitWorktrees: Array<{ path: string; branch?: string }>
  /** Known agent paths that still exist on disk (recoverable). */
  recoverableKnown: WorktreeInfo[]
}

/**
 * Matches directories created by createWorktree: `agent-` + first 8 chars of agentId.
 * Agent ids are normally UUIDs (hex), but tests and tooling may use other prefixes.
 */
const AGENT_DIR_PATTERN = /^agent-[0-9a-z][0-9a-z_-]{2,63}$/i

export class WorktreeManager {
  private repoRoot: string
  private worktreesBase: string
  private repository?: RepositoryContext

  constructor(repoRoot: string, private readonly installationHome = getMousseHomeDir()) {
    if (!repoRoot?.trim()) throw new Error('WorktreeManager requires an explicit repository path.')
    this.repoRoot = resolve(repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
  }

  /** Git for the repository; no program the repository configures runs. */
  private get git(): SimpleGit {
    return this.repository?.git ?? guardedSimpleGit(this.repoRoot)
  }

  async init(): Promise<void> {
    // Keep the caller's path spelling for filesystem-facing results. On macOS,
    // Git often canonicalizes /var to /private/var; replacing repoRoot with
    // RepositoryContext.root would make scans miss directories created through
    // the user's original path and would return paths that cannot be matched by
    // callers. RepositoryContext still owns the canonical Git command context.
    this.repository = await RepositoryContext.open(this.repoRoot)
    // `.mousse-worktrees` is only read: older versions made agent worktrees there, and the orphan scan
    // still reports what it finds. Nothing is created in the person's repository, and a folder that is
    // already there is left as it is.
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
  }

  private async getRepository(): Promise<RepositoryContext> {
    if (!this.repository) await this.init()
    return this.repository!
  }

  private async repositoryFor(worktreeInfo: WorktreeInfo): Promise<RepositoryContext> {
    return worktreeInfo.repositoryRoot
      ? RepositoryContext.open(worktreeInfo.repositoryRoot)
      : this.getRepository()
  }

  getRepoRoot(): string {
    return this.repoRoot
  }

  getWorktreesBase(): string {
    return this.worktreesBase
  }

  setRepoRoot(repoRoot: string): void {
    if (!repoRoot?.trim()) throw new Error('WorktreeManager requires an explicit repository path.')
    this.repoRoot = resolve(repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.repository = undefined
  }

  async createWorktree(
    agentId: string,
    repositoryPath = this.repoRoot,
    baseSha?: string,
    beforeCreate?: (info: WorktreeInfo) => void,
    options?: { safeCheckout?: boolean }
  ): Promise<WorktreeInfo> {
    const repository = await RepositoryContext.open(repositoryPath)
    const repositoryId = (await resolveRepositoryIdentityAsync(repository.root, { requireMutationCapability: true })).key
    const worktreesBase = join(this.installationHome, 'repositories', repositoryId, 'worktrees', 'agents')
    await mkdir(worktreesBase, { recursive: true })
    const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
    if (await exists(identity.path)) {
      throw new Error(`Refusing to reuse existing agent worktree path: ${identity.path}`)
    }
    const branchExists = await repository.git.raw(['show-ref', '--verify', `refs/heads/${identity.branch}`])
      .then(() => true).catch(() => false)
    if (branchExists) throw new Error(`Refusing to reuse existing agent branch: ${identity.branch}`)

    try {
      const { git: checkoutGit, safety } = options?.safeCheckout
        ? await safeWorktreeGit(repository.root)
        : { git: repository.git, safety: [] }
      baseSha ??= (await repository.git.revparse(['HEAD'])).trim()
      beforeCreate?.({ path: identity.path, branch: identity.branch, repositoryRoot: repository.root, baseSha })
      await checkoutGit.raw([...safety, 'worktree', 'add', '-b', identity.branch, identity.path, baseSha])
      await checkoutGit.raw([...safety, 'update-ref', '--no-deref', `refs/mousse/agents/${agentId}/base`, baseSha])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create isolated Git worktree ${identity.branch}: ${message}`)
    }
    return { path: identity.path, branch: identity.branch, repositoryRoot: repository.root, baseSha }
  }

  /**
   * Whether an agent still has an isolated branch/directory that can be finalized.
   * This deliberately does not trust the persisted agent status: older sessions could
   * mark a worker "completed" when it was merely ready to merge.
   */
  async hasMergeCandidate(worktreeInfo: WorktreeInfo): Promise<boolean> {
    const repository = await this.repositoryFor(worktreeInfo)
    return repository.git.raw(['show-ref', '--verify', `refs/heads/${worktreeInfo.branch}`])
      .then(() => exists(worktreeInfo.path))
      .catch(() => false)
  }

  /**
   * True when path is a directory under `.mousse-worktrees` with an agent-* name.
   * Prevents cleanup from touching unrelated project data.
   */
  isValidatedAgentWorktreePath(worktreePath: string): boolean {
    const resolved = resolve(worktreePath)
    const repositoriesRoot = resolve(this.installationHome, 'repositories')
    const externalRelative = relative(repositoriesRoot, resolved)
    const externalParts = externalRelative.split(sep)
    if (
      externalParts.length === 4 &&
      /^[a-f0-9]{32}$/i.test(externalParts[0]) &&
      externalParts[1] === 'worktrees' &&
      externalParts[2] === 'agents' &&
      /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(externalParts[3])
    ) return true
    const base = resolve(this.worktreesBase)
    if (resolved === base) return false
    const rel = relative(base, resolved)
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return false
    // Only direct children of the base (no nested arbitrary deletes).
    if (rel.includes(sep) || rel.includes('/')) return false
    return AGENT_DIR_PATTERN.test(basename(resolved))
  }

  /**
   * Read-only scan for orphan / ghost entries under `.mousse-worktrees`.
   * Never deletes. Use {@link cleanupValidatedAgentWorktree} for explicit removal.
   */
  async scanOrphanWorktrees(known: WorktreeInfo[] = []): Promise<OrphanWorktreeReport> {
    const basePath = this.worktreesBase
    const knownNormalized = known.map((entry) => ({
      path: resolve(entry.path),
      branch: entry.branch
    }))
    const knownPathSet = new Set(knownNormalized.map((entry) => entry.path))

    const ghostDirectories: GhostWorktreeEntry[] = []
    const knownAgentDirs: string[] = []
    const recoverableKnown: WorktreeInfo[] = []

    if (await exists(basePath)) {
      for (const name of await readdir(basePath)) {
        const full = resolve(basePath, name)
        let isDir = false
        try {
          isDir = (await stat(full)).isDirectory()
        } catch {
          continue
        }
        if (!isDir) continue

        if (knownPathSet.has(full)) {
          knownAgentDirs.push(full)
          const match = knownNormalized.find((entry) => entry.path === full)
          if (match) recoverableKnown.push(match)
          continue
        }

        const isAgentNamed = AGENT_DIR_PATTERN.test(name)
        const looksLikeGitWorktree = await exists(join(full, '.git'))
        if (!looksLikeGitWorktree) {
          ghostDirectories.push({
            path: full,
            name,
            reason: isAgentNamed
              ? 'Agent-named directory without a Git worktree metadata file (possible typo or progress-only folder)'
              : 'Non-Git directory under .mousse-worktrees (not an agent worktree)'
          })
        } else if (!isAgentNamed) {
          ghostDirectories.push({
            path: full,
            name,
            reason: 'Git checkout under .mousse-worktrees with a non-agent directory name'
          })
        }
      }
    }

    const staleGitWorktrees: Array<{ path: string; branch?: string }> = []
    await this.getRepository()
    const listed = await this.listGitWorktreesUnderBase()
    for (const entry of listed) {
      const resolved = resolve(entry.path)
      if (knownPathSet.has(resolved)) continue
      // Primary worktree (repo root) is never an orphan agent tree.
      if (resolve(entry.path) === resolve(this.repoRoot)) continue
      if (!resolved.startsWith(resolve(this.worktreesBase) + sep) && resolved !== resolve(this.worktreesBase)) continue
      staleGitWorktrees.push(entry)
    }

    return {
      basePath,
      knownAgentDirs,
      ghostDirectories,
      staleGitWorktrees,
      recoverableKnown
    }
  }

  /**
   * Explicit cleanup only: Git refuses dirty worktrees and does not alter other metadata. `git worktree remove` deletes
   * ignored files (build outputs, logs) with the folder, so they are kept first, as a copy owned by
   * `keepIgnored.owner` (`keepCopy`), and the worktree is removed only once that copy is complete. A worktree whose
   * ignored files cannot be kept (over the copy limit, changing while they are read, a repository inside, or no owner
   * was given) is not removed: the result says `kept`, with how many ignored files it holds, and nothing in it changes.
   * `delete-confirmed` is a person's own delete from Storage: the ignored files go with the worktree.
   */
  async cleanupValidatedAgentWorktree(
    worktreeInfo: WorktreeInfo,
    options: { deleteBranch?: boolean; safeCheckout?: boolean; keepIgnored?: KeepIgnoredFiles | 'delete-confirmed' } = {}
  ): Promise<WorktreeCleanupResult> {
    try {
      const repository = await this.repositoryFor(worktreeInfo)
      const agentId = worktreeInfo.branch.match(/^mousse\/agent\/(.+)$/)?.[1]
      const repositoryId = (await resolveRepositoryIdentityAsync(repository.root, { requireMutationCapability: true })).key
      const expectedBase = join(this.installationHome, 'repositories', repositoryId, 'worktrees', 'agents')
      const identity = agentId ? WorktreeIdentity.forAgent(expectedBase, agentId) : undefined
      const valid = identity
        ? WorktreeIdentity.isPathFor(identity, expectedBase) && resolve(worktreeInfo.path) === resolve(identity.path)
        : this.isValidatedAgentWorktreePath(worktreeInfo.path)
      if (!valid) {
        return { success: false, error: `Refusing to remove path that is not a validated agent worktree: ${worktreeInfo.path}` }
      }
      let copy: WorktreeCleanupResult['copy']
      if (await exists(worktreeInfo.path)) {
        const { git: cleanupGit, safety } = options.safeCheckout
          ? await safeWorktreeGit(repository.root)
          : { git: repository.git, safety: [] }
        const remove = () => cleanupGit.raw([...safety, 'worktree', 'remove', worktreeInfo.path])
        // Read in the worktree with the same overrides as the removal, so no filter or hook runs for the check either.
        const { git: inWorktree, safety: worktreeSafety } = options.safeCheckout
          ? await safeWorktreeGit(worktreeInfo.path)
          : { git: guardedSimpleGit(worktreeInfo.path), safety: [] }
        const ignored = await ignoredFilesOf((args) => inWorktree.raw([...worktreeSafety, ...args]))
        if (ignored === 'dirty' || options.keepIgnored === 'delete-confirmed') {
          // Git refuses a worktree with untracked or changed files, and changes nothing: no copy is needed for that. A
          // person who confirmed deleting this worktree, after Storage named its ignored files, deletes them with it.
          await remove()
        } else if (ignored.files.length || ignored.repositories.length) {
          const kept = await keepIgnoredThenRemove(worktreeInfo.path, ignored, options.keepIgnored, remove)
          if ('kept' in kept) return { success: false, error: kept.kept.reason, kept: kept.kept }
          copy = kept.copy
        } else {
          await remove()
        }
      }
      if (options.deleteBranch === true) await repository.git.branch(['-d', worktreeInfo.branch])
      return { success: true, ...(copy ? { copy } : {}) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Remove several validated agent worktrees. Skips invalid paths and returns per-path results.
   * Ghost directories from {@link scanOrphanWorktrees} are never deleted here.
   */
  async cleanupValidatedAgentWorktrees(
    worktrees: WorktreeInfo[],
    options: { deleteBranch?: boolean } = {}
  ): Promise<Array<{ path: string; success: boolean; error?: string }>> {
    const results: Array<{ path: string; success: boolean; error?: string }> = []
    for (const info of worktrees) {
      const result = await this.cleanupValidatedAgentWorktree(info, options)
      results.push({ path: info.path, success: result.success, error: result.error })
    }
    return results
  }

  private async listGitWorktreesUnderBase(): Promise<Array<{ path: string; branch?: string }>> {
    try {
      const raw = await this.git.raw(['worktree', 'list', '--porcelain'])
      const entries: Array<{ path: string; branch?: string }> = []
      let current: { path?: string; branch?: string } = {}
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          if (current.path) entries.push({ path: current.path, branch: current.branch })
          current = { path: line.slice('worktree '.length).trim() }
        } else if (line.startsWith('branch ')) {
          const ref = line.slice('branch '.length).trim()
          current.branch = ref.replace(/^refs\/heads\//, '')
        } else if (line === '') {
          if (current.path) entries.push({ path: current.path, branch: current.branch })
          current = {}
        }
      }
      if (current.path) entries.push({ path: current.path, branch: current.branch })
      return entries
    } catch {
      return []
    }
  }
}


const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The ignored files in a worktree, as `git worktree remove` would delete them, or `dirty` when Git would refuse the
 * removal anyway: it checks `git status --porcelain --ignore-submodules=none` and refuses on any line, changing nothing.
 * A repository of its own inside an ignored folder is listed apart: a copy cannot hold it.
 */
async function ignoredFilesOf(git: (args: string[]) => Promise<string>): Promise<'dirty' | { files: string[]; repositories: string[] }> {
  if ((await git(['status', '--porcelain', '--ignore-submodules=none'])).trim()) return 'dirty'
  const listed = (await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean)
  return { files: listed.filter((path) => !path.endsWith('/')), repositories: listed.filter((path) => path.endsWith('/')) }
}

/**
 * Keeps the worktree's ignored files as one copy (`keepCopy`, operation `worktree-cleanup`), owned by `keep.owner`, then
 * removes the worktree, both under the owner's and the repository's locks, so the copy's expiry never runs in between.
 * A copy that cannot be kept leaves the worktree as it is.
 */
async function keepIgnoredThenRemove(
  worktreePath: string,
  ignored: { files: string[]; repositories: string[] },
  keep: KeepIgnoredFiles | undefined,
  remove: () => Promise<unknown>
): Promise<{ copy: NonNullable<WorktreeCleanupResult['copy']> } | { kept: NonNullable<WorktreeCleanupResult['kept']> }> {
  const ignoredFiles = ignored.files.length
  const holds = plural(ignoredFiles, 'ignored file')
  if (ignored.repositories.length) {
    return { kept: { ignoredFiles, code: 'nested_repository', reason: `Kept, ${holds}: ${ignored.repositories.slice(0, 3).join(', ')} is a repository of its own, which a copy cannot hold.` } }
  }
  if (!keep) return { kept: { ignoredFiles, code: 'no_owner', reason: `Kept, ${holds}: nothing owns a copy of them.` } }
  return withGitAccess('worktree.cleanup', 'owned', () => withGitMutationLocks(keep.owner, worktreePath, 'worktree-cleanup', async () => {
    keep.record?.({ phase: 'keeping', files: ignoredFiles })
    let kept: KeptCopy
    try {
      kept = await keepCopy({ owner: keep.owner, top: worktreePath, operationType: 'worktree-cleanup', action: 'Worktree cleanup', paths: ignored.files })
    } catch (error) {
      if (!(error instanceof KeepCopyRefusedError)) throw error
      const code = error instanceof KeepCopyTooLargeError ? 'keep_copy_too_large' as const : 'keep_copy_refused' as const
      return { kept: { ignoredFiles, code, reason: `Kept, ${holds}: ${error.message.replace(/ Nothing was changed\..*$/s, '')}` } }
    }
    keep.record?.({ phase: 'removing', ref: kept.ref, sha: kept.sha, files: ignoredFiles })
    await remove()
    return { copy: { ref: kept.ref, sha: kept.sha, files: ignoredFiles, windowMs: kept.windowMs } }
  }))
}

/**
 * Disable external content drivers only for explicitly isolated worktree operations. `safety` holds the `-c`
 * overrides that switch off hooks, the file system monitor and every configured clean, smudge and process
 * filter; a thread worktree that holds a pull request's commits keeps the same values in its own configuration.
 */
export async function safeWorktreeGit(repositoryRoot: string): Promise<{ git: SimpleGit; safety: string[] }> {
  // The unsafe library flags only permit fixed disabling overrides and the process's own environment.
  const git = policedSimpleGit(repositoryRoot, simpleGit({ baseDir: repositoryRoot, unsafe: UNSAFE_ALLOWED }).env(repoProgramEnv()))
  const safety = ['-c', `core.hooksPath=${GIT_NULL_DEVICE}`, '-c', 'core.fsmonitor=false', ...HOOK_EVENTS.flatMap((event) => ['-c', `hook.${event}.enabled=false`])]
  // Git LFS and other inherited drivers must never execute on dispatched content,
  // including Git's dirty-file check before worktree removal.
  const configuration = await git.raw([...safety, 'config', '--null', '--show-scope', '--list'])
  const drivers = new Set<string>()
  const entries = configuration.split('\0')
  // With --null --show-scope, Git emits scope NUL key LF value NUL pairs.
  for (let index = 0; index < entries.length - 1; index += 2) {
    const scope = entries[index]
    const match = /^filter\.(.+)\.(smudge|process|clean|required)\n/i.exec(entries[index + 1])
    if (match && ['local', 'worktree'].includes(scope) && match[2].toLowerCase() !== 'required') {
      throw new Error('Safe checkout refuses configured external clean, smudge or process filters.')
    }
    if (match) drivers.add(match[1])
  }
  for (const driver of drivers) {
    if (/[=\n\r]/.test(driver)) {
      throw new Error('Safe checkout refuses a filter driver name it cannot override.')
    }
    for (const command of ['smudge', 'clean', 'process']) {
      safety.push('-c', `filter.${driver}.${command}=`)
    }
    safety.push('-c', `filter.${driver}.required=false`)
  }
  return { git, safety }
}
