import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { ownedHome } from './support/fixtureGit'

// Any read of the large file is refused and noted, so the test shows whether cleanup reads it at all.
const reads = vi.hoisted(() => ({ target: '', attempted: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const guard = <T extends (...args: never[]) => unknown>(original: T): T => ((...args: Parameters<T>) => {
    if (reads.target && String(args[0]) === reads.target) { reads.attempted = true; return Promise.reject(new Error('read of the large file')) }
    return original(...args)
  }) as T
  return { ...actual, readFile: guard(actual.readFile), open: guard(actual.open) }
})

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

it('refuses a worktree whose ignored files are over the copy limit from their sizes, before reading any of them', async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null'); vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cleanup-large-')))
  roots.push(root)
  const cwd = join(root, 'repo'), home = join(root, 'home'), owner = join(root, 'owner')
  mkdirSync(cwd); mkdirSync(home); mkdirSync(owner)
  owned.push(ownedHome(home))
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Audit'); git(cwd, 'config', 'user.email', 'audit@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  const manager = new WorktreeManager(cwd, home)
  const info = await manager.createWorktree('large-agent', cwd)
  mkdirSync(join(info.path, 'ignored'))
  const large = join(info.path, 'ignored', 'large.bin')
  // Sparse: 3 GiB by `lstat`, nothing on disk.
  writeFileSync(large, ''); execFileSync('truncate', ['-s', String(3 * 1024 ** 3), large])
  reads.target = large
  try {
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
    expect(result).toMatchObject({ success: false, kept: { code: 'keep_copy_too_large', reason: expect.stringContaining('ignored/large.bin') } })
  } finally { reads.target = '' }
  expect(reads.attempted).toBe(false)
  expect(lstatSync(large).size).toBe(3 * 1024 ** 3)
})
