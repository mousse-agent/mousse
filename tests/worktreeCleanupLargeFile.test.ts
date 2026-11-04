import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { ownedHome } from './support/fixtureGit'

// Any read of the large file is refused and noted, so the test shows whether cleanup reads it at all. A path with
// `coarse` in its name has its times rounded to whole milliseconds, as a FAT or HFS+ volume gives them.
const reads = vi.hoisted(() => ({ target: '', attempted: false }))
const coarse = vi.hoisted(() => (path: unknown, stat: unknown): unknown => {
  const value = stat as { mtimeNs?: unknown; ctimeNs?: bigint } | undefined
  if (!String(path).includes('coarse') || !value || typeof value.mtimeNs !== 'bigint') return stat
  const rounded = Object.assign(Object.create(Object.getPrototypeOf(value)), value) as { mtimeNs: bigint; ctimeNs: bigint }
  rounded.mtimeNs -= rounded.mtimeNs % 1_000_000n
  rounded.ctimeNs -= rounded.ctimeNs % 1_000_000n
  return rounded
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const guard = <T extends (...args: never[]) => unknown>(original: T): T => ((...args: Parameters<T>) => {
    if (reads.target && String(args[0]) === reads.target) { reads.attempted = true; return Promise.reject(new Error('read of the large file')) }
    return original(...args)
  }) as T
  const lstat = ((path: string, options?: unknown) => (actual.lstat as (p: string, o?: unknown) => Promise<unknown>)(path, options).then((stat) => coarse(path, stat))) as typeof actual.lstat
  return { ...actual, readFile: guard(actual.readFile), open: guard(actual.open), lstat }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const lstatSync = ((path: string, options?: unknown) => coarse(path, (actual.lstatSync as (p: string, o?: unknown) => unknown)(path, options))) as typeof actual.lstatSync
  return { ...actual, default: { ...actual, lstatSync }, lstatSync }
})

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  reads.target = ''
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function setup() {
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
  return { cwd, home, owner, manager: new WorktreeManager(cwd, home) }
}

it.each(['large.bin', 'coarse-large.bin'])('refuses a worktree whose ignored %s is over the copy limit from its size, before reading it', async (name) => {
  const { cwd, owner, manager } = setup()
  const info = await manager.createWorktree('large-agent', cwd)
  mkdirSync(join(info.path, 'ignored'))
  const large = join(info.path, 'ignored', name)
  // Sparse: 3 GiB by `lstat`, nothing on disk.
  writeFileSync(large, ''); execFileSync('truncate', ['-s', String(3 * 1024 ** 3), large])
  if (name.includes('coarse')) expect(lstatSync(large, { bigint: true }).mtimeNs % 1_000_000n).toBe(0n)
  reads.target = large
  const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner } })
  expect(result).toMatchObject({ success: false, kept: { code: 'keep_copy_too_large', reason: expect.stringContaining(`ignored/${name}`) } })
  expect(reads.attempted).toBe(false)
  expect(lstatSync(large).size).toBe(3 * 1024 ** 3)
})

it('a confirmed delete whose ignored file has coarse times resumes and finishes', async () => {
  const { cwd, owner, manager } = setup()
  const info = await manager.createWorktree('coarse-agent', cwd, undefined, undefined, { safeCheckout: true })
  mkdirSync(join(info.path, 'ignored')); writeFileSync(join(info.path, 'ignored', 'coarse.bin'), 'build output with coarse times\n')
  expect(lstatSync(join(info.path, 'ignored', 'coarse.bin'), { bigint: true }).ctimeNs % 1_000_000n).toBe(0n)
  const crashed = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner, deleteIgnored: true }, beforeRemove: () => { throw new Error('The process ended') } })
  expect(crashed).toMatchObject({ success: false, error: 'The process ended' })
  const deleting = join(dirname(info.path), readdirSync(dirname(info.path)).find((entry) => entry.startsWith('.deleting-'))!)
  const result = await manager.cleanupValidatedAgentWorktree({ path: deleting, branch: info.branch, repositoryRoot: cwd }, { safeCheckout: true })
  expect(result).toMatchObject({ success: true })
  expect(existsSync(deleting)).toBe(false)
})
