import { describe, expect, it } from 'vitest'
import type { ExecutableRunner } from '../src/mms/git/ghRunner'
import { githubRemote, projectSource } from '../src/mms/sourceControl/projectSource'

/** A folder's Git as `git remote -v` and `git rev-parse --abbrev-ref HEAD` print it; a missing answer fails as Git does. */
const git = (answers: { remotes?: string; head?: string }): ExecutableRunner => async (_git, args) => {
  const stdout = args[0] === 'remote' ? answers.remotes : answers.head
  if (stdout === undefined) throw Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: not a git repository' })
  return { stdout, stderr: '' }
}

describe('where a project came from, to clone it on another computer', () => {
  it.each([
    ['https://github.com/acme/web-app.git', 'acme/web-app'],
    ['https://github.com/acme/web-app', 'acme/web-app'],
    ['https://token@github.com/acme/web-app.git', 'acme/web-app'],
    ['git@github.com:acme/web-app.git', 'acme/web-app'],
    ['ssh://git@github.com/acme/web-app.git', 'acme/web-app'],
    ['https://gitlab.com/acme/web-app.git', undefined],
    ['https://github.com/acme', undefined]
  ])('reads %s as %s', (url, repository) => {
    expect(githubRemote(url)).toBe(repository)
  })

  it('takes origin on GitHub, else upstream, else the first remote on GitHub, and the branch checked out', async () => {
    const both = 'mirror\thttps://gitlab.com/me/web-app.git (fetch)\nupstream\tgit@github.com:acme/web-app.git (fetch)\norigin\thttps://github.com/me/web-app.git (fetch)\n'
    expect(await projectSource('/p', git({ remotes: both, head: 'feature/login\n' }))).toEqual({ repository: 'me/web-app', branch: 'feature/login' })
    const noOrigin = 'origin\thttps://gitlab.com/me/web-app.git (fetch)\nupstream\tgit@github.com:acme/web-app.git (fetch)\n'
    expect(await projectSource('/p', git({ remotes: noOrigin, head: 'main' }))).toEqual({ repository: 'acme/web-app', branch: 'main' })
  })

  it('answers what it has: no branch when detached, nothing for a folder without Git or without a GitHub remote', async () => {
    expect(await projectSource('/p', git({ remotes: 'origin\thttps://github.com/me/a (fetch)\n', head: 'HEAD' }))).toEqual({ repository: 'me/a' })
    expect(await projectSource('/p', git({ remotes: 'origin\thttps://gitlab.com/me/a (fetch)\n', head: 'main' }))).toEqual({ branch: 'main' })
    expect(await projectSource('/p', git({}))).toEqual({})
  })
})
