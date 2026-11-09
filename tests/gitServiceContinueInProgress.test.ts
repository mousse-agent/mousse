import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { operationInProgressAsync } from '../src/mms/actions/git'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'

const USER = userAction('button', 'Continue')
const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } }).trim()
}
function tryGit(cwd: string, ...args: string[]): void {
  try { git(cwd, ...args) } catch { /* stops on conflicts, as intended */ }
}
function commit(cwd: string, file: string, content: string, message = file): void {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', message)
}

/** main and topic both change a.txt from the same base; topic has a second commit that changes it again. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-continue-'))
  roots.push(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Continue fixture')
  git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  commit(cwd, 'a.txt', 'base\n', 'base')
  git(cwd, 'checkout', '-q', '-b', 'topic')
  commit(cwd, 'a.txt', 'topic one\n', 'topic one')
  commit(cwd, 'a.txt', 'topic two\n', 'topic two')
  git(cwd, 'checkout', '-q', 'main')
  commit(cwd, 'a.txt', 'main\n', 'main change')
  return cwd
}

const resolve = (cwd: string, content: string) => {
  writeFileSync(join(cwd, 'a.txt'), content)
  git(cwd, 'add', 'a.txt')
}
const marker = (cwd: string, name: string) => existsSync(join(cwd, '.git', name))
const slash = (path: string) => path.replace(/\\/g, '/')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitService.continueInProgress', () => {
  it('finishes a merge with the message Git prepared', async () => {
    const cwd = repo()
    tryGit(cwd, 'merge', 'topic')
    resolve(cwd, 'merged\n')

    expect(await new GitService().continueInProgress(cwd, USER, 'merge')).toEqual({ result: 'done' })
    expect(marker(cwd, 'MERGE_HEAD')).toBe(false)
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe("Merge branch 'topic'")
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  it('carries a rebase on, and says so when it stops on the next commit’s conflict', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', 'topic')
    tryGit(cwd, 'rebase', 'main')
    resolve(cwd, 'topic one on main\n')

    // The second topic commit conflicts with the resolution of the first.
    const first = await new GitService().continueInProgress(cwd, USER, 'rebase')
    expect(first).toEqual({ result: 'conflicted' })
    expect(marker(cwd, 'rebase-merge')).toBe(true)

    resolve(cwd, 'topic two on main\n')
    expect(await new GitService().continueInProgress(cwd, USER, 'rebase')).toEqual({ result: 'done' })
    expect(marker(cwd, 'rebase-merge')).toBe(false)
    expect(git(cwd, 'log', '--format=%s', '-3').split('\n')).toEqual(['topic two', 'topic one', 'main change'])
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('topic two on main\n')
  })

  it('does not count a REBASE_HEAD left after a finished rebase as a rebase still waiting', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', 'topic')
    writeFileSync(join(cwd, '.git', 'REBASE_HEAD'), `${git(cwd, 'rev-parse', 'HEAD')}
`)

    expect((await new GitService().getStatus(cwd)).inProgress).toBeNull()
    expect(await operationInProgressAsync(cwd)).toBeUndefined()
  })

  it('finishes a cherry-pick, keeping the picked commit’s message', async () => {
    const cwd = repo()
    tryGit(cwd, 'cherry-pick', 'topic~1')
    resolve(cwd, 'picked\n')

    expect(await new GitService().continueInProgress(cwd, USER, 'cherry-pick')).toEqual({ result: 'done' })
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('topic one')
  })

  it('refuses while conflicts are unresolved, and when nothing of that kind is stopped', async () => {
    const cwd = repo()
    await expect(new GitService().continueInProgress(cwd, USER, 'merge')).rejects.toMatchObject({ code: 'git_continue_none' })
    tryGit(cwd, 'merge', 'topic')
    await expect(new GitService().continueInProgress(cwd, USER, 'merge')).rejects.toMatchObject({ code: 'git_continue_conflicted' })
    await expect(new GitService().continueInProgress(cwd, USER, 'rebase')).rejects.toMatchObject({ code: 'git_continue_none' })
    expect(marker(cwd, 'MERGE_HEAD')).toBe(true)
  })

  it('says paused, not conflicted, when an interactive rebase stops at its next edit step', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', 'topic')
    // Mark both topic commits "edit": the rebase stops after each with nothing in conflict.
    const editor = `${cwd}-sequence.cjs`
    roots.push(editor)
    writeFileSync(editor, "const f = process.argv[2]; const fs = require('fs'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pick /gm, 'edit '))")
    execFileSync('git', ['rebase', '-i', 'main~1'], { cwd, stdio: 'ignore', env: { ...process.env, GIT_SEQUENCE_EDITOR: `node "${slash(editor)}"`, GIT_EDITOR: 'true' } })
    expect(marker(cwd, 'rebase-merge')).toBe(true)

    expect(await new GitService().continueInProgress(cwd, USER, 'rebase')).toEqual({ result: 'paused' })
    expect(await new GitService().continueInProgress(cwd, USER, 'rebase')).toEqual({ result: 'done' })
    expect(marker(cwd, 'rebase-merge')).toBe(false)
  })

  it('stops a hook that goes silent, so the repository is free for the next action', async () => {
    const cwd = repo()
    tryGit(cwd, 'merge', 'topic')
    resolve(cwd, 'merged\n')
    const hooks = `${cwd}-hooks`
    roots.push(hooks)
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit.cjs'), 'setTimeout(() => {}, 60000)')
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec node "${slash(join(hooks, 'pre-commit.cjs'))}"\n`, { mode: 0o755 })
    git(cwd, 'config', 'core.hooksPath', hooks)

    await expect(new GitService({ commitSilenceMs: 3000 }).continueInProgress(cwd, USER, 'merge')).rejects.toMatchObject({ code: 'git_silence_timeout' })
    expect(marker(cwd, 'MERGE_HEAD')).toBe(true)
    expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false)

    // The lease was let go: the next action runs.
    git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
    expect(await new GitService().continueInProgress(cwd, USER, 'merge')).toEqual({ result: 'done' })
  }, 60_000)
})
