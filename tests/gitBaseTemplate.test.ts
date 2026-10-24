import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { committedGitTemplate } from './support/gitBase'
import { ownedTemp } from './support/tmp'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

it('copies independent object stores and worktree registries without changing the committed template', async () => {
  const temp = ownedTemp('git-base-copies-')
  let builds = 0
  const copy = committedGitTemplate((repo) => {
    builds++
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
  })
  try {
    const first = join(temp.path, 'first'), second = join(temp.path, 'second'), third = join(temp.path, 'third')
    const sha = copy(first)
    expect(copy(second)).toBe(sha)
    git(first, 'worktree', 'add', '-qb', 'first-only', join(temp.path, 'first-child'))
    writeFileSync(join(first, 'value.txt'), 'changed\n')
    git(first, 'commit', '-qam', 'first change')
    expect(copy(third)).toBe(sha)
    expect(builds).toBe(1)
    for (const repo of [second, third]) {
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('first-child')
      expect(existsSync(join(repo, '.git', 'objects', 'info', 'alternates'))).toBe(false)
      git(repo, 'worktree', 'add', '-qb', 'first-only', join(temp.path, repo === second ? 'second-child' : 'third-child'))
    }
    expect(() => copy(first)).toThrow('destination must be empty')
  } finally { await temp.close() }
})
