import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SimpleGit } from 'simple-git'
import { guardedSimpleGit } from '../git/repoPrograms'

/** A verified, explicit Git repository root. Never falls back to process.cwd(). */
export class RepositoryContext {
  private constructor(readonly root: string) {}

  /** Git for the root; no program the repository configures runs, as its config is when called. */
  get git(): SimpleGit {
    return guardedSimpleGit(this.root)
  }

  static async open(repositoryPath: string): Promise<RepositoryContext> {
    if (!repositoryPath?.trim()) {
      throw new Error('An explicit repository path is required.')
    }
    const requestedPath = resolve(repositoryPath)
    if (!existsSync(requestedPath)) {
      throw new Error(`Repository path does not exist: ${requestedPath}`)
    }

    const git = guardedSimpleGit(requestedPath)
    if (!await git.checkIsRepo().catch(() => false)) {
      throw new Error(`Not a Git repository: ${requestedPath}`)
    }
    const root = resolve((await git.revparse(['--show-toplevel'])).trim())
    return new RepositoryContext(root)
  }
}
