import { access, readdir, stat } from 'fs/promises'
import { GIT_NULL_DEVICE } from '../git/gitNullDevice'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import simpleGit, { SimpleGit } from 'simple-git'
import { guardedSimpleGit, HOOK_EVENTS, policedSimpleGit, repoProgramEnv, UNSAFE_ALLOWED } from '../git/repoPrograms'
import { RepositoryContext } from './RepositoryContext'
import { WorktreeIdentity } from './WorktreeIdentity'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'
import { samePath } from '../lifecycle/verifiedDelete'
import { agentWorktreeBases, chosenFolderPlace, defaultAgentWorktreeBase, isAgentWorktreePlace, placeAgentWorktreeBase } from './worktreeLayout'
import { cleanupRecordFor, DELETING_NAME, findCleanupRecord, resumeCleanupAsync, verifiedCleanupAsync } from './verifiedCleanup'


/** `existsSync` without blocking the daemon. */
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

export interface WorktreeInfo {
  path: string
  branch: string
  repositoryRoot?: string
  baseSha?: string
}

/**
 * Who keeps the copies cleanup makes before it removes a worktree: one of its ignored files, and one of Git's own data
 * of it (its settings, HEAD history and own refs, with the commits only they name).
 */
export interface KeepIgnoredFiles {
  /**
   * The journal folder that owns the copies: the dispatch's (`dispatchKeptFilesOwner`), the agent's thread's, or, for an
   * agent with no thread, its project's (`projectKeptFilesOwner`).
   */
  owner: string
  /**
   * A person confirmed deleting the worktree with its ignored files, after Storage named them: they are not copied.
   * Git's own data of the worktree is still kept.
   */
  deleteIgnored?: boolean
  /**
   * Told before anything is kept, then once the copies and the proof are complete and recorded, right before the folder
   * is renamed to `path` (`.deleting-<hex>` beside it) and deleted, so the caller can record each step durably first. A
   * later start that finds `deleting` finishes the delete against the proof (`verifiedCleanup.ts`). `ref` and `sha`
   * name the copy of the files Git cannot write back, when there are any; `admin` the copy of Git's own data.
   */
  record?: (step: { phase: 'keeping'; files: number } | { phase: 'deleting'; ref?: string; sha?: string; files: number; admin: { ref: string; sha: string }; path: string }) => void
}

export interface WorktreeCleanupResult {
  success: boolean
  error?: string
  /**
   * The worktree was not removed. It has uncommitted changes (`uncommitted_changes`, with `uncommitted` naming the
   * files), its files could not be kept first, or Git has it locked: nothing in it changed. Or (`cleanup_stopped`)
   * cleanup stopped part way, and what is left of it is at `path`, with every byte it held kept.
   */
  kept?: { ignoredFiles: number; reason: string; code: 'uncommitted_changes' | 'keep_copy_too_large' | 'keep_copy_refused' | 'nested_repository' | 'no_owner' | 'worktree_locked' | 'cleanup_stopped' | 'cleanup_running'; path?: string; /** The files with uncommitted changes: the first three, then "and N more". */ uncommitted?: string }
  /**
   * The copy of the files Git cannot write back, kept before the worktree was removed: its ignored and other untracked
   * files and links, and tracked files whose raw bytes are not what Git writes from their blob (CRLF under
   * `core.autocrlf=input`, say). `files` is how many it holds.
   */
  copy?: { ref: string; sha: string; files: number; windowMs: number }
  /** Copies of files written into the worktree while cleanup was deleting it. */
  late?: Array<{ ref: string; sha: string; files: number; windowMs: number }>
  /** The copy of Git's own data of the worktree kept before it was removed, which also holds the commits only that data named. */
  admin?: { ref: string; sha: string; windowMs: number }
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
    /** `worktreeFolder`: the worktree folder the person chose (Settings → Storage); unset for Mousse's own. */
    options?: { safeCheckout?: boolean; worktreeFolder?: string }
  ): Promise<WorktreeInfo> {
    const repository = await RepositoryContext.open(repositoryPath)
    const repositoryId = (await resolveRepositoryIdentityAsync(repository.root, { requireMutationCapability: true })).key
    const worktreesBase = await placeAgentWorktreeBase({ home: this.installationHome, folder: options?.worktreeFolder, repositoryId, projectName: basename(repository.root) })
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
   * True when path is an agent's worktree where Mousse makes them (`worktreeLayout`: its own folder, or a worktree folder
   * the person chose), or a directory under the old `.mousse-worktrees` with an agent-* name.
   * Prevents cleanup from touching unrelated project data.
   */
  isValidatedAgentWorktreePath(worktreePath: string): boolean {
    const resolved = resolve(worktreePath)
    // A cleanup under way renamed the worktree to `.deleting-<hex>` in its own folder (`verifiedCleanup.ts`).
    if (DELETING_NAME.test(basename(resolved))) return this.isAgentWorktreeFolder(dirname(resolved))
    const repositoriesRoot = resolve(this.installationHome, 'repositories')
    const externalRelative = relative(repositoriesRoot, resolved)
    const externalParts = externalRelative.split(sep)
    if (
      externalParts.length === 4 &&
      /^[a-f0-9]{32}$/i.test(externalParts[0]) &&
      /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(externalParts[3]) &&
      isAgentWorktreePlace(resolved, { home: this.installationHome, repositoryId: externalParts[0], agentId: externalParts[3] })
    ) return true
    // `<folder>/<project>-<short key>/agents/<agent>` in a worktree folder the person chose.
    const chosen = chosenFolderPlace(resolved)
    if (chosen && chosen.rest.length === 2 && chosen.rest[0] === 'agents' && /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(chosen.rest[1]!)) return true
    const base = resolve(this.worktreesBase)
    if (resolved === base) return false
    const rel = relative(base, resolved)
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return false
    // Only direct children of the base (no nested arbitrary deletes).
    if (rel.includes(sep) || rel.includes('/')) return false
    return AGENT_DIR_PATTERN.test(basename(resolved))
  }

  /** Whether `folder` is a folder agent worktrees are made in: Mousse's own `agents` folder of a repository, a chosen worktree folder's, or the old `.mousse-worktrees`. */
  private isAgentWorktreeFolder(folder: string): boolean {
    const resolved = resolve(folder)
    const parts = relative(resolve(this.installationHome, 'repositories'), resolved).split(sep)
    if (parts.length === 3 && /^[a-f0-9]{32}$/i.test(parts[0]!) && samePath(resolved, defaultAgentWorktreeBase(this.installationHome, parts[0]!))) return true
    const chosen = chosenFolderPlace(resolved)
    if (chosen && chosen.rest.length === 1 && chosen.rest[0] === 'agents') return true
    return samePath(resolved, this.worktreesBase)
  }

  /** Whether `path` is the agent's worktree for `branch` (`mousse/agent/<id>`), or a validated agent worktree path without one. */
  private async validAgentWorktree(path: string, agentId: string | undefined, repositoryId: string): Promise<boolean> {
    if (!agentId) return this.isValidatedAgentWorktreePath(path) && !DELETING_NAME.test(basename(path))
    // In Mousse's own agents folder, or the repository's in a worktree folder the person chose (`worktreeLayout`).
    return (await agentWorktreeBases(this.installationHome, repositoryId)).some((base) => {
      const identity = WorktreeIdentity.forAgent(base, agentId)
      return WorktreeIdentity.isPathFor(identity, base) && resolve(path) === resolve(identity.path) && isAgentWorktreePlace(identity.path, { home: this.installationHome, repositoryId, agentId })
    })
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
   * Explicit cleanup only, and it changes no other metadata. A worktree with uncommitted changes (changed, staged or
   * untracked files) is kept as it is, and Git is never asked to remove it: the result names the files
   * (`uncommitted_changes`). Once it is clean, a later cleanup takes the verified path below. A clean worktree is
   * removed as a verified delete (`verifiedCleanup.ts`): what removing it would lose is kept first, as copies owned by
   * `keepIgnored.owner` (its ignored and other untracked files, links, tracked files whose raw bytes Git cannot write
   * back, and Git's own data of it: its settings, HEAD history and own refs, with the commits only they name); then the
   * proof is recorded, the folder is renamed to `.deleting-<hex>` beside it, deleted entry by entry against the proof,
   * and unregistered. A write found meanwhile is kept as another copy, at most three rounds, then cleanup stops and
   * keeps what is left (`kept.code` `cleanup_stopped`). A worktree whose files cannot be kept (over the copy limit,
   * changing while they are read, a repository inside, or no owner was given) or that Git has locked is not removed:
   * the result says `kept`, with how many ignored files it holds, and nothing in it changes.
   * `keepIgnored.deleteIgnored` is a person's own delete from Storage: the ignored files go with the worktree.
   * A cleanup a process left part way is finished first, against its recorded proof: one of this worktree, or the
   * `.deleting-<hex>` folder itself when that is the path given.
   */
  async cleanupValidatedAgentWorktree(
    worktreeInfo: WorktreeInfo,
    options: { deleteBranch?: boolean; safeCheckout?: boolean; keepIgnored?: KeepIgnoredFiles; /** Test seam: runs right before each entry is removed. */ beforeRemove?: (path: string) => void } = {}
  ): Promise<WorktreeCleanupResult> {
    try {
      const repository = await this.repositoryFor(worktreeInfo)
      const agentId = worktreeInfo.branch.match(/^mousse\/agent\/(.+)$/)?.[1]
      const repositoryId = (await resolveRepositoryIdentityAsync(repository.root, { requireMutationCapability: true })).key
      const renamed = DELETING_NAME.test(basename(worktreeInfo.path))
      const recorded = renamed ? await cleanupRecordFor(this.installationHome, resolve(worktreeInfo.path)) : undefined
      // What is left of a cleanup whose record is gone was finished by another run, or is no cleanup's: never touched here.
      if (renamed && !recorded) return { success: false, error: `No cleanup is recorded for ${worktreeInfo.path}; it is left as it is.`, kept: { ignoredFiles: 0, code: 'cleanup_running', reason: `Kept: no cleanup is recorded for ${worktreeInfo.path}.` } }
      const worktreePath = renamed ? recorded?.worktreePath : worktreeInfo.path
      // The worktree's own path first: that reads which worktree folders were chosen, which the renamed path's check uses.
      const valid = worktreePath !== undefined
        && await this.validAgentWorktree(worktreePath, agentId, repositoryId)
        && (!renamed || this.isValidatedAgentWorktreePath(worktreeInfo.path) && recorded!.branch === worktreeInfo.branch)
      if (!valid) {
        return { success: false, error: `Refusing to remove path that is not a validated agent worktree: ${worktreeInfo.path}` }
      }
      const pending = recorded ?? await findCleanupRecord(this.installationHome, worktreePath)
      if (pending) {
        const resumed = await resumeCleanupAsync({ home: this.installationHome, id: pending.id, ...(options.keepIgnored ? { owner: options.keepIgnored.owner } : {}), ...(options.beforeRemove ? { beforeRemove: options.beforeRemove } : {}) })
        if (resumed === 'gone' && renamed) return { success: false, error: `Another cleanup finished ${worktreeInfo.path}.`, kept: { ignoredFiles: 0, code: 'cleanup_running', reason: `Kept: another cleanup finished ${worktreeInfo.path}.` } }
        if (resumed !== 'restart' && resumed !== 'gone') {
          if ('kept' in resumed) return { success: false, error: resumed.kept.reason, kept: resumed.kept }
          if (options.deleteBranch === true) await repository.git.branch(['-d', worktreeInfo.branch])
          return { success: true, ...resumed }
        }
      }
      let kept: Pick<WorktreeCleanupResult, 'copy' | 'admin' | 'late'> = {}
      if (await exists(worktreePath)) {
        // Read in the worktree with hooks, the file system monitor and every filter driver off, so none runs for the check.
        const { git: inWorktree, safety: worktreeSafety } = options.safeCheckout
          ? await safeWorktreeGit(worktreePath)
          : { git: guardedSimpleGit(worktreePath), safety: [] }
        const inWorktreeGit = (args: string[]) => inWorktree.raw([...worktreeSafety, ...args])
        const ignored = await ignoredFilesOf(inWorktreeGit)
        // A dirty check is no proof for a delete: the worktree could be clean a moment later, and Git would then remove
        // it with its ignored files and its own data, keeping nothing. So it stays, and nothing runs that could remove it.
        if ('dirty' in ignored) {
          const uncommitted = namedFiles(ignored.dirty)
          const reason = `Kept: it has uncommitted changes (${uncommitted}). Nothing in it was changed.`
          return { success: false, error: reason, kept: { ignoredFiles: 0, code: 'uncommitted_changes', reason, uncommitted } }
        }
        const outcome = await keepThenDelete({ home: this.installationHome, filters: !options.safeCheckout, worktreePath, branch: worktreeInfo.branch, repositoryRoot: repository.root, ignored, keep: options.keepIgnored, git: inWorktreeGit, ...(options.beforeRemove ? { beforeRemove: options.beforeRemove } : {}) })
        if ('kept' in outcome) return { success: false, error: outcome.kept.reason, kept: outcome.kept }
        kept = outcome
      }
      if (options.deleteBranch === true) await repository.git.branch(['-d', worktreeInfo.branch])
      return { success: true, ...kept }
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
    options: { deleteBranch?: boolean; keepIgnored?: KeepIgnoredFiles } = {}
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

/** Up to three paths by name, then how many more: "a.txt, b.txt, c.txt and 2 more". */
function namedFiles(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown
}

/**
 * The ignored files in a worktree, as removing it would delete them, or the paths with uncommitted changes (`dirty`):
 * every path `git status --porcelain --ignore-submodules=none` lists, untracked ones included, which is what Git's own
 * removal checks. A repository of its own inside an ignored folder is listed apart: a copy cannot hold it.
 */
export async function ignoredFilesOf(git: (args: string[]) => Promise<string>): Promise<{ dirty: string[] } | { files: string[]; repositories: string[] }> {
  const status = (await git(['status', '--porcelain', '-z', '--ignore-submodules=none'])).split('\0')
  const dirty: string[] = []
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index]!
    if (entry.length < 4) continue
    dirty.push(entry.slice(3))
    // A rename or copy, staged or not, is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1
  }
  if (dirty.length) return { dirty }
  const listed = (await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean)
  return { files: listed.filter((path) => !path.endsWith('/')), repositories: listed.filter((path) => path.endsWith('/')) }
}

/**
 * Keeps what removing the worktree would lose, then deletes it against the proof (`verifiedCleanupAsync`, which holds the
 * owner's and the repository's locks while it keeps, so the copies' expiry never runs in between). A repository of its
 * own inside, or no owner for the copies, leaves the worktree as it is.
 */
async function keepThenDelete(input: {
  home: string
  filters: boolean
  worktreePath: string
  branch: string
  repositoryRoot: string
  ignored: { files: string[]; repositories: string[] }
  keep: KeepIgnoredFiles | undefined
  git: (args: string[]) => Promise<string>
  beforeRemove?: (path: string) => void
}): Promise<Pick<WorktreeCleanupResult, 'copy' | 'admin' | 'late'> | { kept: NonNullable<WorktreeCleanupResult['kept']> }> {
  const { ignored, keep } = input
  const ignoredFiles = keep?.deleteIgnored ? 0 : ignored.files.length
  const holds = ignoredFiles ? `Kept, ${plural(ignoredFiles, 'ignored file')}` : 'Kept'
  if (!keep?.deleteIgnored && ignored.repositories.length) {
    return { kept: { ignoredFiles, code: 'nested_repository', reason: `${holds}: ${ignored.repositories.slice(0, 3).join(', ')} is a repository of its own, which a copy cannot hold.` } }
  }
  if (!keep) {
    return { kept: { ignoredFiles, code: 'no_owner', reason: ignoredFiles ? `${holds}: nothing owns a copy of them.` : `${holds}: nothing owns a copy of Git's own data of it (its settings and HEAD history).` } }
  }
  return verifiedCleanupAsync({
    home: input.home, filters: input.filters, worktreePath: input.worktreePath, branch: input.branch, repositoryRoot: input.repositoryRoot, keep, git: input.git, ignored: ignored.files,
    ...(input.beforeRemove ? { beforeRemove: input.beforeRemove } : {})
  })
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
