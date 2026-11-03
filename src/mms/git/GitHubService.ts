import type { UserAction } from './gitPolicy'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import type {
  GitHubAvailability,
  GitHubCloneRepositoryInput,
  GitHubCreateRepositoryInput,
  GitHubCreateRepositoryResult
} from '../../shared/github'
import { defaultRunner, isMissingExecutable, processMessage, type ExecutableRunner } from './ghRunner'

export { createGhFallbackRunner } from './ghRunner'
export type { ExecutableResult, ExecutableRunner } from './ghRunner'

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

  async createRepository(
    projectPath: string,
    input: Omit<GitHubCreateRepositoryInput, 'projectId'>,
    userRequested: UserAction
  ): Promise<GitHubCreateRepositoryResult> {
    const name = validateRepositoryName(input.name)
    if (input.visibility !== 'private' && input.visibility !== 'public') {
      throw new Error('Repository visibility must be private or public.')
    }
    return this.runExclusive(async () => {
      await this.requireReady()
      await this.runExecutable('git', ['init'], { cwd: projectPath, userRequested }).catch((error) => {
        throw new Error(`Could not initialize the local Git repository: ${processMessage(error)}`)
      })
      const args = [
        'repo', 'create', name, '--source=.',
        input.visibility === 'public' ? '--public' : '--private',
        '--remote=origin'
      ] as const
      try {
        const result = await this.runExecutable('gh', args, { cwd: projectPath, userRequested })
        const repositoryUrl = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//.test(line))
        return repositoryUrl ? { repositoryUrl } : {}
      } catch (error) {
        throw new Error(`GitHub repository creation failed: ${processMessage(error)}. The local folder was initialized, but no commits were pushed.`)
      }
    })
  }

  async cloneRepository(input: GitHubCloneRepositoryInput, userRequested: UserAction): Promise<string> {
    const repository = validateRepository(input.repository)
    const destination = resolve(input.destination.trim())
    if (!input.destination.trim() || !isAbsolute(input.destination) || destination === parse(destination).root) {
      throw new Error('Choose an absolute, non-root destination folder.')
    }

    return this.runExclusive(async () => {
      await this.requireReady()
      await this.assertSafeDestination(destination)
      try {
        await this.runExecutable('gh', ['repo', 'clone', repository, destination], { userRequested })
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
