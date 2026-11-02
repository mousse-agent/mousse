import { access } from 'node:fs/promises'
import { waitForFolderAccess } from '../files/folderAccess'
import { resolve } from 'node:path'
import type { SimpleGit } from 'simple-git'
import { checkRepoPrograms, guardedSimpleGit } from '../git/repoPrograms'

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
    await waitForFolderAccess([requestedPath])
    if (!await access(requestedPath).then(() => true, () => false)) {
      throw new Error(`Repository path does not exist: ${requestedPath}`)
    }

    // A repository whose programs cannot be turned off is refused with its reason, not taken for "not a repository".
    await checkRepoPrograms(requestedPath)
    const git = guardedSimpleGit(requestedPath)
    if (!await git.checkIsRepo().catch(() => false)) {
      throw new Error(`Not a Git repository: ${requestedPath}`)
    }
    const root = resolve((await git.revparse(['--show-toplevel'])).trim())
    return new RepositoryContext(root)
  }
}
