import { execFileSync } from 'node:child_process'
import { stripInheritedGitEnv } from '../../src/mms/git/gitEnv'
import { registerOwnedGitRoot } from '../../src/mms/git/gitPolicy'

/**
 * The test's own Git, as a person runs it in a terminal: it sets up fixtures (init, commit, branches, remotes)
 * and reads them back. Mousse's central Git check covers only the commands Mousse runs, so fixture setup never
 * goes through Mousse's runners. A `GIT_DIR` or similar a test stubs for the runner it checks is dropped.
 */
export function fixtureGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, env: stripInheritedGitEnv(process.env), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
}

/** {@link fixtureGit} with the signature of the bridge dispatch runner, for tests that set up its repositories. */
export async function fixtureGitAsync(cwd: string, args: string[]): Promise<string> {
  return fixtureGit(cwd, args)
}

/**
 * Treats a test's profile or installation home as Mousse's own, as the real one is: it lives under the Mousse home,
 * so the worktrees, trash and private stores Mousse keeps there are Mousse's to change. Returns the undo.
 */
export function ownedHome(path: string): () => void {
  return registerOwnedGitRoot(path)
}
