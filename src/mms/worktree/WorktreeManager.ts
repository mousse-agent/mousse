import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { symlink } from 'fs/promises'
import { spawn } from 'child_process'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import simpleGit, { SimpleGit } from 'simple-git'
import { GitStateInspector } from './GitStateInspector'
import { RepositoryContext } from './RepositoryContext'
import { WorktreeIdentity } from './WorktreeIdentity'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'
import { BlastRadiusAnalyzer, type BlastRadiusResult } from './BlastRadiusAnalyzer'

export interface WorktreeInfo {
  path: string
  branch: string
  repositoryRoot?: string
}

export interface SelectiveWorktreeInfo extends WorktreeInfo {
  selection: BlastRadiusResult
  sharedDependencyPaths: string[]
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
  private git: SimpleGit
  private repoRoot: string
  private worktreesBase: string
  private repository?: RepositoryContext

  constructor(repoRoot: string) {
    if (!repoRoot?.trim()) throw new Error('WorktreeManager requires an explicit repository path.')
    this.repoRoot = resolve(repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = simpleGit(this.repoRoot)
  }

  async init(): Promise<void> {
    // Keep the caller's path spelling for filesystem-facing results. On macOS,
    // Git often canonicalizes /var to /private/var; replacing repoRoot with
    // RepositoryContext.root would make scans miss directories created through
    // the user's original path and would return paths that cannot be matched by
    // callers. RepositoryContext still owns the canonical Git command context.
    this.repository = await RepositoryContext.open(this.repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = this.repository.git
    if (!existsSync(this.worktreesBase)) mkdirSync(this.worktreesBase, { recursive: true })
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
    this.git = simpleGit(this.repoRoot)
    this.repository = undefined
  }

  async createWorktree(agentId: string, repositoryPath = this.repoRoot): Promise<WorktreeInfo> {
    const repository = await RepositoryContext.open(repositoryPath)
    const repositoryId = resolveRepositoryIdentity(repository.root, { requireMutationCapability: true }).key
    const worktreesBase = join(getMousseHomeDir(), 'repositories', repositoryId, 'worktrees', 'agents')
    mkdirSync(worktreesBase, { recursive: true })
    const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
    if (existsSync(identity.path)) {
      throw new Error(`Refusing to reuse existing agent worktree path: ${identity.path}`)
    }
    const branchExists = await repository.git.raw(['show-ref', '--verify', `refs/heads/${identity.branch}`])
      .then(() => true).catch(() => false)
    if (branchExists) throw new Error(`Refusing to reuse existing agent branch: ${identity.branch}`)

    try {
      await repository.git.raw(['worktree', 'add', '-b', identity.branch, identity.path, 'HEAD'])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create isolated Git worktree ${identity.branch}: ${message}`)
    }
    return { path: identity.path, branch: identity.branch, repositoryRoot: repository.root }
  }

  /**
   * Creates a sparse agent checkout from an explicit edit declaration plus its computed
   * transitive blast radius. Repository objects remain shared through Git's worktree model.
   */
  async createSelectiveWorktree(
    agentId: string,
    requestedFiles: string[],
    repositoryPath = this.repoRoot
  ): Promise<SelectiveWorktreeInfo> {
    const repository = await RepositoryContext.open(repositoryPath)
    const selection = await new BlastRadiusAnalyzer(repository.root, repository.git).analyze(requestedFiles)
    const repositoryId = resolveRepositoryIdentity(repository.root, { requireMutationCapability: true }).key
    const worktreesBase = join(getMousseHomeDir(), 'repositories', repositoryId, 'worktrees', 'agents')
    mkdirSync(worktreesBase, { recursive: true })
    const identity = WorktreeIdentity.forAgent(worktreesBase, agentId)
    if (existsSync(identity.path)) throw new Error(`Refusing to reuse existing agent worktree path: ${identity.path}`)
    const branchExists = await repository.git.raw(['show-ref', '--verify', `refs/heads/${identity.branch}`])
      .then(() => true).catch(() => false)
    if (branchExists) throw new Error(`Refusing to reuse existing agent branch: ${identity.branch}`)

    try {
      await repository.git.raw(['worktree', 'add', '--no-checkout', '-b', identity.branch, identity.path, 'HEAD'])
      await runGitWithInput(
        identity.path,
        ['sparse-checkout', 'set', '--no-cone', '--stdin'],
        `${selection.includedFiles.join('\n')}\n`
      )
      await simpleGit(identity.path).raw(['checkout', 'HEAD'])
      // Sparse checkout only materializes files present in HEAD. Explicit task inputs
      // can be intentionally untracked (videos, screenshots, local fixtures), so copy
      // selected existing files that checkout did not create, without overwriting HEAD.
      const materializedInputs: string[] = []
      for (const selectedFile of selection.includedFiles) {
        const source = join(repository.root, ...selectedFile.split('/'))
        const destination = join(identity.path, ...selectedFile.split('/'))
        if (!existsSync(destination) && existsSync(source) && statSync(source).isFile()) {
          mkdirSync(dirname(destination), { recursive: true })
          copyFileSync(source, destination)
          materializedInputs.push(selectedFile)
        }
      }
      // Every agent writes its progress protocol beneath .mousse, even when there are
      // no untracked task inputs. Keep that control channel out of Git from the moment
      // the worktree is created so `git status` and readiness only reflect user work.
      const mousseDir = join(identity.path, '.mousse')
      const excludesFile = join(mousseDir, 'materialized-inputs.exclude')
      mkdirSync(mousseDir, { recursive: true })
      writeFileSync(excludesFile, `.mousse/\nnode_modules\n${materializedInputs.join('\n')}\n`)
      await repository.git.raw(['config', 'extensions.worktreeConfig', 'true'])
      await simpleGit(identity.path).raw([
        'config', '--worktree', 'core.excludesFile', excludesFile
      ])
      const sharedDependencyPaths = await linkSharedDependencies(repository.root, identity.path)
      return {
        path: identity.path,
        branch: identity.branch,
        repositoryRoot: repository.root,
        selection,
        sharedDependencyPaths
      }
    } catch (err) {
      await repository.git.raw(['worktree', 'remove', '--force', identity.path]).catch(() => {})
      await repository.git.raw(['branch', '-D', identity.branch]).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create selective worktree ${identity.branch}: ${message}`)
    }
  }

  /**
   * Whether an agent still has an isolated branch/directory that can be finalized.
   * This deliberately does not trust the persisted agent status: older sessions could
   * mark a worker "completed" when it was merely ready to merge.
   */
  async hasMergeCandidate(worktreeInfo: WorktreeInfo): Promise<boolean> {
    const repository = await this.repositoryFor(worktreeInfo)
    return repository.git.raw(['show-ref', '--verify', `refs/heads/${worktreeInfo.branch}`])
      .then(() => existsSync(worktreeInfo.path))
      .catch(() => false)
  }

  /**
   * True when path is a directory under `.mousse-worktrees` with an agent-* name.
   * Prevents cleanup from touching unrelated project data.
   */
  isValidatedAgentWorktreePath(worktreePath: string): boolean {
    const resolved = resolve(worktreePath)
    const repositoriesRoot = resolve(getMousseHomeDir(), 'repositories')
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

    if (existsSync(basePath)) {
      for (const name of readdirSync(basePath)) {
        const full = resolve(basePath, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
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
        const looksLikeGitWorktree = existsSync(join(full, '.git'))
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

  /** Explicit cleanup only: Git refuses dirty worktrees and does not alter other metadata. */
  async cleanupValidatedAgentWorktree(
    worktreeInfo: WorktreeInfo,
    options: { deleteBranch?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const repository = await this.repositoryFor(worktreeInfo)
      const agentId = worktreeInfo.branch.match(/^mousse\/agent\/(.+)$/)?.[1]
      const repositoryId = resolveRepositoryIdentity(repository.root, { requireMutationCapability: true }).key
      const expectedBase = join(getMousseHomeDir(), 'repositories', repositoryId, 'worktrees', 'agents')
      const identity = agentId ? WorktreeIdentity.forAgent(expectedBase, agentId) : undefined
      const valid = identity
        ? WorktreeIdentity.isPathFor(identity, expectedBase) && resolve(worktreeInfo.path) === resolve(identity.path)
        : this.isValidatedAgentWorktreePath(worktreeInfo.path)
      if (!valid) {
        return { success: false, error: `Refusing to remove path that is not a validated agent worktree: ${worktreeInfo.path}` }
      }
      if (existsSync(worktreeInfo.path)) await repository.git.raw(['worktree', 'remove', worktreeInfo.path])
      if (options.deleteBranch === true) await repository.git.branch(['-d', worktreeInfo.branch])
      return { success: true }
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

  async validateAgentReadiness(worktreeInfo: WorktreeInfo) {
    return new GitStateInspector(await this.repositoryFor(worktreeInfo)).inspectWorker(worktreeInfo)
  }

  /**
   * Capture an immutable readiness claim without modifying worker files or creating commits.
   * Verification-only assignments may explicitly claim a clean, unchanged checkout.
   */
  async prepareForReady(
    worktreeInfo: WorktreeInfo,
    options: { verificationOnly?: boolean; summary?: string } = {}
  ): Promise<{ success: boolean; error?: string; commit?: string; diffFiles: string[] }> {
    const repository = await this.repositoryFor(worktreeInfo)
    const workerGit = simpleGit(worktreeInfo.path)
    const initialStatus = await workerGit.status()
    const implementationFiles = initialStatus.files.filter(
      (file) => !['.mousse/task-progress.json', '.mousse/materialized-inputs.exclude']
        .includes(file.path.replace(/\\/g, '/'))
    )
    if (implementationFiles.length > 0) {
      await workerGit.add(implementationFiles.map((file) => file.path))
      await workerGit.commit(options.summary?.trim() || 'Finalize agent implementation')
    }
    const inspected = await new GitStateInspector(repository).inspectWorker(worktreeInfo)
    if (inspected.ready && inspected.commit) {
      return { success: true, commit: inspected.commit, diffFiles: inspected.changedFiles ?? [] }
    }
    if (options.verificationOnly && /without creating|no changes|empty commits/i.test(inspected.reason ?? '')) {
      const status = await workerGit.status()
      if (status.files.length === 0) {
        return { success: true, commit: (await workerGit.revparse(['HEAD'])).trim(), diffFiles: [] }
      }
    }
    const error = /without creating|empty commits/i.test(inspected.reason ?? '')
      ? `No implementation diff: ${inspected.reason}`
      : inspected.reason
    return { success: false, error, diffFiles: inspected.changedFiles ?? [] }
  }

  async mergeAndRemove(
    worktreeInfo: WorktreeInfo,
    expected?: { commit?: string; diffFiles?: string[] }
  ): Promise<{ success: boolean; error?: string; conflict?: boolean; conflicts?: string[] }> {
    const repository = await this.repositoryFor(worktreeInfo)

    try {
      // Manual conflict recovery: if resolutions are staged and MERGE_HEAD remains,
      // finish the merge commit so complete_task can complete bookkeeping.
      const mergeInProgress = await repository.git.raw(['rev-parse', '--verify', 'MERGE_HEAD'])
        .then(() => true)
        .catch(() => false)
      if (mergeInProgress) {
        const conflicts = await repository.git
          .raw(['diff', '--name-only', '--diff-filter=U'])
          .then((output) => output.split(/\r?\n/).filter(Boolean))
          .catch(() => [] as string[])
        if (conflicts.length > 0) {
          return {
            success: false,
            error: `A merge is already in progress with unresolved conflicts: ${conflicts.join(', ')}`,
            conflict: true,
            conflicts
          }
        }
        await repository.git.commit(['--no-edit'])
        return { success: true }
      }

      // After a manual merge commit, the worker tip is already contained in main
      // (merge-base(main, worker) === worker). Treat that as success so complete_task
      // can close the agent and clean up. Do not use `merge-base --is-ancestor` via
      // simple-git: non-zero exits are not reliably surfaced as rejections.
      if (existsSync(worktreeInfo.path)) {
        const workerGit = simpleGit(worktreeInfo.path)
        const workerStatus = await workerGit.status()
        if (workerStatus.files.length === 0) {
          const repositoryHead = (await repository.git.revparse(['HEAD'])).trim()
          const workerHead = (await workerGit.revparse(['HEAD'])).trim()
          const mergeBase = (
            await repository.git.raw(['merge-base', repositoryHead, workerHead])
          ).trim()
          if (mergeBase === workerHead) {
            return { success: true }
          }
        }
      }

      // Validate at the merge boundary, not just when the worker first signals readiness.
      const readiness = await new GitStateInspector(repository).inspectWorker(worktreeInfo)
      if (!readiness.ready) return { success: false, error: readiness.reason }
      if (expected?.commit && readiness.commit !== expected.commit) {
        return {
          success: false,
          error: `Ready commit mismatch: expected ${expected.commit}, found ${readiness.commit}.`
        }
      }
      if (expected?.diffFiles) {
        const actual = [...(readiness.changedFiles ?? [])].sort()
        const claimed = [...expected.diffFiles].sort()
        if (actual.length !== claimed.length || actual.some((file, index) => file !== claimed[index])) {
          return {
            success: false,
            error: 'Ready diff mismatch: worker changes no longer match the validated claim.'
          }
        }
      }

      await repository.git.merge([worktreeInfo.branch, '--no-edit'])
      // Removal and branch deletion are intentionally separate explicit operations.
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const conflicts = await repository.git
        .raw(['diff', '--name-only', '--diff-filter=U'])
        .then((output) => output.split(/\r?\n/).filter(Boolean))
        .catch(() => [] as string[])
      if (conflicts.length > 0) return { success: false, error: message, conflict: true, conflicts }
      return { success: false, error: message }
    }
  }

  static resolveMacrosPath(): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      process.env.MOUSSE_MACROS_PATH,
      process.resourcesPath ? join(process.resourcesPath, 'macros') : undefined,
      resolve(moduleDir, '../../../macros'),
      resolve(moduleDir, '../../../../macros'),
      resolve(process.cwd(), 'macros')
    ].filter((value): value is string => Boolean(value))

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }

    return resolve(process.cwd(), 'macros')
  }
}

function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with code ${code}`))
    })
    child.stdin.end(input)
  })
}

/** Reuse heavyweight immutable dependency trees instead of duplicating them per agent. */
async function linkSharedDependencies(repositoryRoot: string, worktreePath: string): Promise<string[]> {
  const linked: string[] = []
  const source = join(repositoryRoot, 'node_modules')
  const target = join(worktreePath, 'node_modules')
  if (!existsSync(source) || existsSync(target)) return linked
  try {
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    linked.push(target)
  } catch {
    // A missing link permission must not prevent the isolated sparse checkout itself.
  }
  return linked
}
