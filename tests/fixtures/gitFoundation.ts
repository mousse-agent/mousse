import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { committedGitTemplate } from '../support/gitBase'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const copyBaseRepo = committedGitTemplate((repo) => {
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Foundation Test')
  git(repo, 'config', 'user.email', 'foundation@example.test')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
})

export function gitFoundationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-foundation-test-'))
  const repo = join(root, 'primary')
  const home = join(root, 'home')
  const thread = join(root, 'thread')
  for (const dir of [repo, home, thread]) mkdirSync(dir)
  const baseSha = copyBaseRepo(repo)
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  return {
    root, repo, home, thread, baseSha,
    read: (cwd: string, path = 'value.txt') => readFileSync(join(cwd, path), 'utf8').replace(/\r\n/g, '\n'),
    commit(cwd: string, value: string, path = 'value.txt') {
      writeFileSync(join(cwd, path), value)
      git(cwd, 'add', '--', path)
      git(cwd, 'commit', '-qm', 'fixture change')
      return git(cwd, 'rev-parse', 'HEAD')
    },
    child(branch = 'child', base = baseSha) {
      const path = join(root, branch)
      git(repo, 'worktree', 'add', '-q', '-b', branch, path, base)
      return path
    },
    dispose() {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      const rel = relative(realpathSync(tmpdir()), realpathSync(root))
      if (isAbsolute(rel) || !rel.startsWith('mousse-foundation-test-') || rel.includes('..')) {
        throw new Error('Unsafe fixture cleanup path')
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}

/**
 * Banner for an ESM crash-child bundle: bundled CommonJS dependencies (simple-git's `@kwsites/file-exists`)
 * call `require`, which an ES module does not have.
 */
export const CRASH_CHILD_REQUIRE = "import { createRequire as crashChildRequire } from 'node:module'; const require = crashChildRequire(import.meta.url);"

export const contextBoundary = {
  messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'fixture'
}

export function actionOptions(workspacePath: string, turnId = 'turn') {
  return {
    threadId: 'task', turnId, conversationBranchId: 'main', workspacePath,
    presentationMessageStart: 0, presentationMessageEnd: 2,
    nativeContextStartBoundary: contextBoundary,
    nativeContextBoundary: { ...contextBoundary, messageIndex: 2 }
  }
}
