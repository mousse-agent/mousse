import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, realpath, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeManager } from '../../../src/mms/worktree/WorktreeManager'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mousse-safe-checkout-')))
  roots.push(root)
  const empty = join(root, 'global')
  await writeFile(empty, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', empty)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  git('init')
  git('config', 'user.name', 'Mousse QA')
  git('config', 'user.email', 'qa@example.invalid')
  await writeFile(join(root, 'README'), 'safe checkout fixture')
  git('add', 'README')
  git('commit', '-m', 'fixture')
  const marker = join(root, 'hook-ran')
  await writeFile(
    join(root, '.git/hooks/post-checkout'),
    `#!/bin/sh\nprintf executed > '${marker}'\n`,
    { mode: 0o700 }
  )
  return { root, git, marker, manager: new WorktreeManager(root, join(root, 'owned-installation')) }
}
it('suppresses a real installed checkout hook while creating a usable isolated worktree', async () => {
  const { root, manager, marker } = await fixture()
  const info = await manager.createWorktree('safe-checkout-test', root, undefined, undefined, {
    safeCheckout: true
  })
  await expect(access(join(info.path, 'README'))).resolves.toBeUndefined()
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['smudge', 'process', 'clean'])(
  'refuses an external %s filter before calling the effect journal or creating a branch',
  async (filter) => {
    const { root, git, manager, marker } = await fixture()
    git('config', `filter.fixture.${filter}`, `touch '${marker}'`)
    const before = vi.fn()
    await expect(
      manager.createWorktree('filter-denied-test', root, undefined, before, { safeCheckout: true })
    ).rejects.toThrow(/external clean, smudge or process filters/)
    expect(before).not.toHaveBeenCalled()
    expect(
      git('for-each-ref', '--format=%(refname)', 'refs/heads/mousse/agent/filter-denied-test')
    ).toBe('')
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
it('refuses worktree-specific filters before calling the effect journal or creating a branch', async () => {
  const { root, git, manager, marker } = await fixture()
  git('config', 'extensions.worktreeConfig', 'true')
  git('config', '--worktree', 'filter.fixture.smudge', `touch '${marker}'`)
  const before = vi.fn()
  await expect(
    manager.createWorktree('worktree-filter-denied-test', root, undefined, before, {
      safeCheckout: true
    })
  ).rejects.toThrow(/external clean, smudge or process filters/)
  expect(before).not.toHaveBeenCalled()
  expect(
    git(
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/mousse/agent/worktree-filter-denied-test'
    )
  ).toBe('')
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
