import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import simpleGit, { type SimpleGit } from 'simple-git'

/** A verified, explicit Git repository root. Never falls back to process.cwd(). */
export class RepositoryContext {
  private constructor(
    readonly root: string,
    readonly git: SimpleGit
  ) {}

  static async open(repositoryPath: string): Promise<RepositoryContext> {
    if (!repositoryPath?.trim()) {
      throw new Error('An explicit repository path is required.')
    }
    const requestedPath = resolve(repositoryPath)
    if (!existsSync(requestedPath)) {
      throw new Error(`Repository path does not exist: ${requestedPath}`)
    }

    const git = simpleGit(requestedPath)
    if (!await git.checkIsRepo().catch(() => false)) {
      throw new Error(`Not a Git repository: ${requestedPath}`)
    }
    const root = resolve((await git.revparse(['--show-toplevel'])).trim())
    return new RepositoryContext(root, simpleGit(root))
  }
}
