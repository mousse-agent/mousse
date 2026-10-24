import { execFile } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import type {
  GitPullRequestInfo,
  GitPullRequestLookup,
  PullRequestCheckState
} from '../../shared/types'
import type {
  GitHubAvailability,
  GitHubCloneRepositoryInput,
  GitHubCreateRepositoryInput,
  GitHubCreateRepositoryResult
} from '../../shared/github'

export interface ExecutableResult {
  stdout: string
  stderr: string
}

export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: { cwd?: string }
) => Promise<ExecutableResult>

const execRunner: ExecutableRunner = (executable, args, options) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options?.cwd,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr })
          reject(error)
          return
        }
        resolvePromise({ stdout, stderr })
      }
    )
  })

/** A packaged macOS app gets a minimal PATH, so Homebrew's gh is not found by name. */
export function createGhFallbackRunner(
  base: ExecutableRunner,
  platform: NodeJS.Platform = process.platform
): ExecutableRunner {
  const fallbacks = platform === 'darwin' || platform === 'linux' ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : []
  let remembered: string | null = null
  return async (executable, args, options) => {
    if (executable !== 'gh') return base(executable, args, options)
    if (remembered) return base(remembered, args, options)
    try {
      return await base('gh', args, options)
    } catch (error) {
      if (!isMissingExecutable(error)) throw error
      for (const candidate of fallbacks) {
        try {
          const result = await base(candidate, args, options)
          remembered = candidate
          return result
        } catch (candidateError) {
          if (isMissingExecutable(candidateError)) continue
          remembered = candidate
          throw candidateError
        }
      }
      throw error
    }
  }
}

const defaultRunner = createGhFallbackRunner(execRunner)

function processMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const value = error as { stderr?: unknown; message?: unknown }
  const stderr = typeof value.stderr === 'string' ? value.stderr.trim() : ''
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  return stderr || message || 'Unknown command failure'
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

export interface PullRequestCheckSummary {
  checks: PullRequestCheckState
  checkCounts: GitPullRequestInfo['checkCounts']
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : ''
}

/** Maps gh's statusCheckRollup (CheckRun and StatusContext items) to one summary. */
export function summarizeCheckRollup(rollup: unknown): PullRequestCheckSummary {
  const counts = { passed: 0, failed: 0, pending: 0, total: 0 }
  for (const item of Array.isArray(rollup) ? rollup : []) {
    if (!item || typeof item !== 'object') continue
    const { status, conclusion, state } = item as Record<string, unknown>
    counts.total++
    if (FAILED_CONCLUSIONS.has(upper(conclusion)) || FAILED_STATES.has(upper(state))) counts.failed++
    else if ((upper(status) && upper(status) !== 'COMPLETED') || PENDING_STATES.has(upper(state))) counts.pending++
    else counts.passed++
  }
  const checks: PullRequestCheckState = counts.failed > 0
    ? 'failing'
    : counts.pending > 0
      ? 'pending'
      : counts.total > 0
        ? 'passing'
        : 'none'
  return { checks, checkCounts: counts }
}

/** Parses `gh pr view --json number,title,url,state,isDraft,statusCheckRollup` output. */
export function parsePullRequestJson(stdout: string): GitPullRequestInfo | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  const state = upper(value.state).toLowerCase()
  if (typeof value.number !== 'number' || typeof value.url !== 'string') return null
  if (state !== 'open' && state !== 'closed' && state !== 'merged') return null
  return {
    number: value.number,
    title: typeof value.title === 'string' ? value.title : '',
    url: value.url,
    state,
    isDraft: value.isDraft === true,
    ...summarizeCheckRollup(value.statusCheckRollup)
  }
}

/** Classifies a failed `gh pr view` by its error text. */
export function classifyPullRequestFailure(message: string): 'none' | 'not-github' | 'unauthenticated' | 'error' {
  const text = message.toLowerCase()
  if (text.includes('no pull requests found')) return 'none'
  if (text.includes('point to a known github host') || text.includes('not a github repository')) return 'not-github'
  if (text.includes('gh auth login') || text.includes('not logged in')) return 'unauthenticated'
  return 'error'
}

const AVAILABILITY_TTL_MS = 60_000

type GhProbe = { ok: true } | { ok: false; reason: 'gh-missing' | 'unauthenticated'; message: string }

function validateRepository(value: string): string {
  const repository = value.trim()
  const shorthand = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})(?:\.git)?$/
  const githubUrl = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(?:\.git)?\/?$/i
  if (!shorthand.test(repository) && !githubUrl.test(repository)) {
    throw new Error('Enter a GitHub repository as owner/name or an https://github.com/owner/name URL.')
  }
  return repository
}

function validateRepositoryName(value: string): string {
  const name = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    throw new Error('Repository name must be 1–100 letters, numbers, dots, dashes, or underscores and start with a letter or number.')
  }
  return name
}

export class GitHubService {
  private operationActive = false
  private probe: { at: number; result: GhProbe } | null = null
  private readonly defaultBranches = new Map<string, string>()

  constructor(private readonly runExecutable: ExecutableRunner = defaultRunner) {}

  async getAvailability(): Promise<GitHubAvailability> {
    if (this.operationActive) {
      return { state: 'busy', message: 'A GitHub operation is already in progress.' }
    }
    try {
      await this.runExecutable('gh', ['--version'])
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {
          state: 'missing',
          message: 'GitHub CLI (gh) was not found. Install it, then refresh this panel.'
        }
      }
      return { state: 'error', message: `Could not run GitHub CLI: ${processMessage(error)}` }
    }

    try {
      await this.runExecutable('gh', ['auth', 'status'])
      return { state: 'ready', message: 'GitHub CLI is installed and authenticated.' }
    } catch (error) {
      return {
        state: 'unauthenticated',
        message: `GitHub CLI is not authenticated. Run “gh auth login” in a terminal. ${processMessage(error)}`,
        loginCommand: 'gh auth login'
      }
    }
  }

  /** Looks up the pull request for the folder's current branch. Never takes the operation lock. */
  async getPullRequest(cwd: string): Promise<GitPullRequestLookup> {
    const branch = await this.runExecutable('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })
      .then((result) => result.stdout.trim())
      .catch(() => '')
    if (!branch) return { state: 'unavailable', reason: 'no-branch', message: 'There is no branch checked out.' }

    const probe = await this.probeGh()
    if (!probe.ok) return { state: 'unavailable', reason: probe.reason, message: probe.message }

    try {
      const { stdout } = await this.runExecutable(
        'gh',
        ['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'],
        { cwd }
      )
      const pullRequest = parsePullRequestJson(stdout)
      if (pullRequest) return { state: 'found', pullRequest }
      return { state: 'unavailable', reason: 'error', message: 'GitHub CLI returned an unexpected pull request response.' }
    } catch (error) {
      const message = processMessage(error)
      const kind = classifyPullRequestFailure(message)
      if (kind === 'none') return { state: 'none', isDefaultBranch: await this.isDefaultBranch(cwd, branch) }
      if (kind === 'not-github') return { state: 'unavailable', reason: 'not-github', message }
      if (kind === 'unauthenticated') {
        this.probe = null
        return { state: 'unavailable', reason: 'unauthenticated', message }
      }
      return { state: 'unavailable', reason: 'error', message }
    }
  }

  /** Opens GitHub's create page in the browser. */
  async createPullRequest(cwd: string): Promise<void> {
    await this.runExclusive(async () => {
      try {
        await this.runExecutable('gh', ['pr', 'create', '--web'], { cwd })
      } catch (error) {
        if (isMissingExecutable(error)) throw new Error('GitHub CLI (gh) was not found. Install it and try again.')
        throw new Error(processMessage(error))
      }
    })
  }

  private async probeGh(): Promise<GhProbe> {
    if (this.probe && Date.now() - this.probe.at < AVAILABILITY_TTL_MS) return this.probe.result
    let result: GhProbe
    try {
      await this.runExecutable('gh', ['auth', 'status'])
      result = { ok: true }
    } catch (error) {
      result = isMissingExecutable(error)
        ? { ok: false, reason: 'gh-missing', message: 'GitHub CLI (gh) was not found. Install it to see pull requests.' }
        : { ok: false, reason: 'unauthenticated', message: `GitHub CLI is not authenticated. Run “gh auth login” in a terminal. ${processMessage(error)}` }
    }
    this.probe = { at: Date.now(), result }
    return result
  }

  private async isDefaultBranch(cwd: string, branch: string): Promise<boolean> {
    let name = this.defaultBranches.get(cwd)
    if (!name) {
      try {
        const { stdout } = await this.runExecutable(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
          { cwd }
        )
        name = stdout.trim()
      } catch {
        return false
      }
      if (!name) return false
      this.defaultBranches.set(cwd, name)
    }
    return name === branch
  }

  async createRepository(
    projectPath: string,
    input: Omit<GitHubCreateRepositoryInput, 'projectId'>
  ): Promise<GitHubCreateRepositoryResult> {
    const name = validateRepositoryName(input.name)
    if (input.visibility !== 'private' && input.visibility !== 'public') {
      throw new Error('Repository visibility must be private or public.')
    }
    return this.runExclusive(async () => {
      await this.requireReady()
      await this.runExecutable('git', ['init'], { cwd: projectPath }).catch((error) => {
        throw new Error(`Could not initialize the local Git repository: ${processMessage(error)}`)
      })
      const args = [
        'repo', 'create', name, '--source=.',
        input.visibility === 'public' ? '--public' : '--private',
        '--remote=origin'
      ] as const
      try {
        const result = await this.runExecutable('gh', args, { cwd: projectPath })
        const repositoryUrl = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//.test(line))
        return repositoryUrl ? { repositoryUrl } : {}
      } catch (error) {
        throw new Error(`GitHub repository creation failed: ${processMessage(error)}. The local folder was initialized, but no commits were pushed.`)
      }
    })
  }

  async cloneRepository(input: GitHubCloneRepositoryInput): Promise<string> {
    const repository = validateRepository(input.repository)
    const destination = resolve(input.destination.trim())
    if (!input.destination.trim() || !isAbsolute(input.destination) || destination === parse(destination).root) {
      throw new Error('Choose an absolute, non-root destination folder.')
    }

    return this.runExclusive(async () => {
      await this.requireReady()
      await this.assertSafeDestination(destination)
      try {
        await this.runExecutable('gh', ['repo', 'clone', repository, destination])
      } catch (error) {
        throw new Error(`GitHub clone failed: ${processMessage(error)}`)
      }
      return destination
    })
  }

  private async requireReady(): Promise<void> {
    // Called only while the exclusive flag is held, so probe directly instead of
    // getAvailability(), whose busy response is intended for concurrent callers.
    try {
      await this.runExecutable('gh', ['--version'])
    } catch (error) {
      if (isMissingExecutable(error)) throw new Error('GitHub CLI (gh) was not found. Install it and try again.')
      throw new Error(`Could not run GitHub CLI: ${processMessage(error)}`)
    }
    try {
      await this.runExecutable('gh', ['auth', 'status'])
    } catch (error) {
      throw new Error(`GitHub CLI is not authenticated. Run “gh auth login” in a terminal. ${processMessage(error)}`)
    }
  }

  private async assertSafeDestination(destination: string): Promise<void> {
    try {
      const info = await lstat(destination)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Clone destination must be a normal directory.')
      }
      if ((await readdir(destination)).length > 0) {
        throw new Error('Clone destination is not empty. Choose a new or empty folder; existing project content will not be overwritten.')
      }
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
        try {
          const parent = await lstat(dirname(destination))
          if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Clone destination parent must be a normal directory.')
          return
        } catch (parentError) {
          if (parentError instanceof Error && parentError.message.includes('normal directory')) throw parentError
          throw new Error('Clone destination parent does not exist.')
        }
      }
      throw error
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationActive) throw new Error('A GitHub operation is already in progress. Wait for it to finish and try again.')
    this.operationActive = true
    try {
      return await operation()
    } finally {
      this.operationActive = false
    }
  }
}
