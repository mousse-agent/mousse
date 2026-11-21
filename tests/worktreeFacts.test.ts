/**
 * Ownership checks read a worktree's facts without starting Git when the worktree has the layout `git worktree add`
 * writes, and read pinned refs per repository instead of per ref. These answers decide whether another thread's
 * worktree is verified (its claims are exact) or unverified (it holds its whole repository), so each must be Git's
 * answer, and anything the file reader does not recognise must still go to Git.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { verifyWorktreeFact } from '../src/mms/lifecycle/ResourceInventory'
import { findListedWorktreeAsync } from '../src/mms/lifecycle/worktreeRegistry'
import { verifyPinsAsync } from '../src/mms/lifecycle/worktreeFacts'
import type { WorktreeReconstructionManifest } from '../src/mms/lifecycle/WorktreeRetirementService'

const FIXTURE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const roots: string[] = []
afterEach(() => {
  delete process.env.GIT_TRACE2_EVENT
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const gitVersion = (): number[] => (git(tmpdir(), '--version').match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
const relativePathsSupported = (): boolean => { const [major = 0, minor = 0] = gitVersion(); return major > 2 || major === 2 && minor >= 48 }
const repositoryIdOf = (commonDir: string): string => createHash('sha256').update(realpathSync(commonDir).toLowerCase()).digest('hex').slice(0, 32)

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-worktree-facts-')))
  roots.push(root)
  return root
}

function repository(root: string, name = 'main') {
  const main = join(root, name)
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'config', 'user.name', 'Facts fixture')
  git(main, 'config', 'user.email', 'facts@example.invalid')
  writeFileSync(join(main, 'base.txt'), 'base\n')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'base')
  return { main, commonDir: join(main, '.git') }
}

/** Git processes started while `run` runs, read from Git's own trace. */
async function gitStarts<T>(root: string, run: () => Promise<T>): Promise<{ value: T; starts: number }> {
  const trace = join(root, `trace-${Math.random().toString(16).slice(2)}`)
  mkdirSync(trace)
  process.env.GIT_TRACE2_EVENT = trace
  try {
    const value = await run()
    return { value, starts: readdirSync(trace).flatMap((file) => readFileSync(join(trace, file), 'utf8').split('\n').filter((line) => line.includes('"event":"start"'))).length }
  } finally { delete process.env.GIT_TRACE2_EVENT }
}

/** The slow answer, as the check read it before: Git's common directory and top level, then the registration. */
async function gitAnswer(path: string, expectedRepository: string): Promise<boolean> {
  try {
    const common = realpathSync(resolve(path, git(path, 'rev-parse', '--git-common-dir')))
    if (createHash('sha256').update(common.toLowerCase()).digest('hex').slice(0, 32) !== expectedRepository) return false
    if (realpathSync(git(path, 'rev-parse', '--show-toplevel')).toLowerCase() !== realpathSync(path).toLowerCase()) return false
    return Boolean(await findListedWorktreeAsync(common, path, (entry, wanted) => resolve(entry).toLowerCase() === resolve(wanted).toLowerCase()))
  } catch { return false }
}

/**
 * Each layout, with whether the file reader may answer it (no Git) or must leave it to Git:
 * - plain, locked, moved by `git worktree move`: the default layout, no Git;
 * - a `.git` file naming another worktree's registration: default layout, unregistered, no Git;
 * - the wrong recorded repository: default layout, no Git;
 * - relative paths (`--relative-paths`, Git 2.48+), `core.worktree` in `config.worktree`, an `include` in the
 *   repository's config, an unknown extension: Git, every time;
 * - a repository moved with a junction or link left at its old path: the `.git` file still reads, and both answers
 *   name the moved repository, whose id differs from the recorded one.
 */
it('gives Git’s answer for every layout, without Git for the standard one', async () => {
  const root = tempRoot()
  const repo = repository(root)
  const id = repositoryIdOf(repo.commonDir)
  const add = (name: string, ...extra: string[]) => { const path = join(root, 'wt', name); git(repo.main, 'worktree', 'add', '-q', ...extra, '-b', name, path); return path }
  const rows: Array<{ name: string; path: string; repository?: string; git: boolean }> = []
  rows.push({ name: 'plain', path: add('plain'), git: false })
  const locked = add('locked'); git(repo.main, 'worktree', 'lock', '--reason', 'away', locked)
  rows.push({ name: 'locked', path: locked, git: false })
  const before = add('before-move'); const moved = join(root, 'wt', 'moved-here'); git(repo.main, 'worktree', 'move', before, moved)
  rows.push({ name: 'moved', path: moved, git: false })
  const misled = add('misled')
  const pointer = readFileSync(join(rows[0]!.path, '.git'), 'utf8')
  rmSync(join(misled, '.git')); writeFileSync(join(misled, '.git'), pointer)
  rows.push({ name: 'names another registration', path: misled, git: false })
  rows.push({ name: 'another repository recorded', path: rows[0]!.path, repository: 'f'.repeat(32), git: false })
  if (relativePathsSupported()) rows.push({ name: 'relative paths', path: add('relative', '--relative-paths'), git: true })
  // A worktree whose own config moves its top level elsewhere: only Git knows, so the reader must not answer.
  const moving = add('core-worktree')
  git(repo.main, 'config', 'extensions.worktreeConfig', 'true')
  git(moving, 'config', '--worktree', 'core.worktree', join(root, 'elsewhere'))
  mkdirSync(join(root, 'elsewhere'))
  rows.push({ name: 'core.worktree in config.worktree', path: moving, git: true })

  // A second repository for config the whole repository carries.
  const other = repository(root, 'other')
  const otherId = repositoryIdOf(other.commonDir)
  const included = join(root, 'wt2', 'included'); git(other.main, 'worktree', 'add', '-q', '-b', 'included', included)
  writeFileSync(join(root, 'extra.gitconfig'), '[user]\n\tname = Included\n')
  git(other.main, 'config', 'include.path', join(root, 'extra.gitconfig'))
  rows.push({ name: 'include in the repository config', path: included, repository: otherId, git: true })

  const third = repository(root, 'third')
  const thirdId = repositoryIdOf(third.commonDir)
  const extended = join(root, 'wt3', 'extended'); git(third.main, 'worktree', 'add', '-q', '-b', 'extended', extended)
  git(third.main, 'config', 'extensions.noop', 'true')
  rows.push({ name: 'unknown extension', path: extended, repository: thirdId, git: true })

  // Moved, with a link left where it was: every file inside is unchanged, the real repository is not the recorded one.
  const fourth = repository(root, 'fourth')
  const fourthId = repositoryIdOf(fourth.commonDir)
  const stranded = join(root, 'wt4', 'stranded'); git(fourth.main, 'worktree', 'add', '-q', '-b', 'stranded', stranded)
  renameSync(fourth.main, join(root, 'fourth-moved'))
  symlinkSync(join(root, 'fourth-moved'), fourth.main, process.platform === 'win32' ? 'junction' : 'dir')
  rows.push({ name: 'repository moved, link left behind', path: stranded, repository: fourthId, git: false })

  const store = new ResourceLifecycleStore({ profileId: '11111111-1111-4111-8111-111111111111', profileHome: join(root, 'home') })
  for (const row of rows) {
    const expected = row.repository ?? id
    const slow = await gitAnswer(row.path, expected)
    const { value, starts } = await gitStarts(root, () => verifyWorktreeFact(store, row.path, undefined, expected))
    expect({ row: row.name, verified: value === undefined }).toEqual({ row: row.name, verified: slow })
    expect({ row: row.name, git: starts > 0 }).toEqual({ row: row.name, git: row.git })
  }
  // The rows that must differ do: the stranded worktree and the misled one are not verified, the plain one is.
  expect(await verifyWorktreeFact(store, stranded, undefined, fourthId)).toMatch(/identity changed/)
  expect(await verifyWorktreeFact(store, rows[0]!.path, undefined, id)).toBeUndefined()
})

/** A manifest as retirement writes it, with only the fields the pin check reads. */
function manifest(commonDir: string, name: string, base: string, result: string, tree: string): WorktreeReconstructionManifest {
  const prefix = `refs/mousse/lifecycle/11111111-1111-4111-8111-111111111111/${'a'.repeat(36)}/${createHash('sha256').update(name).digest('hex').slice(0, 32)}-${'x'.repeat(40)}`
  return { commonDir, repositoryId: repositoryIdOf(commonDir), baseRef: `${prefix}/base`, baseSha: base, resultRef: `${prefix}/result`, resultSha: result, treeSha: tree } as WorktreeReconstructionManifest
}

/**
 * Rows: every pin holds; one manifest's ref moved; one manifest's ref is symbolic; a corrupt loose ref elsewhere in the
 * repository (Git warns and leaves it out); a recorded tree that is not the commit's; the wrong repository recorded.
 * Each manifest gets its own answer: one bad pin never makes the others unverified.
 */
it('reads every pin of a repository at once, and one bad ref fails only its own manifest', async () => {
  const root = tempRoot()
  const repo = repository(root)
  const head = git(repo.main, 'rev-parse', 'HEAD')
  const tree = git(repo.main, 'rev-parse', 'HEAD^{tree}')
  writeFileSync(join(repo.main, 'second.txt'), 'two\n'); git(repo.main, 'add', '.'); git(repo.main, 'commit', '-qm', 'second')
  const second = git(repo.main, 'rev-parse', 'HEAD')
  const pin = (m: WorktreeReconstructionManifest, base = head, result = head) => { git(repo.main, 'update-ref', m.baseRef, base); git(repo.main, 'update-ref', m.resultRef, result) }
  const good = Array.from({ length: 3 }, (_, i) => manifest(repo.commonDir, `good-${i}`, head, head, tree))
  for (const m of good) pin(m)
  const moved = manifest(repo.commonDir, 'moved', head, head, tree); pin(moved, head, second)
  const symbolic = manifest(repo.commonDir, 'symbolic', head, head, tree); pin(symbolic); git(repo.main, 'update-ref', '-d', symbolic.resultRef); git(repo.main, 'symbolic-ref', symbolic.resultRef, 'refs/heads/main')
  const corrupt = manifest(repo.commonDir, 'corrupt', head, head, tree); pin(corrupt)
  const loose = join(repo.commonDir, ...corrupt.baseRef.split('/'))
  writeFileSync(loose, 'not a commit\n')
  const wrongTree = manifest(repo.commonDir, 'wrong-tree', head, head, second); pin(wrongTree)
  const wrongRepository = { ...manifest(repo.commonDir, 'wrong-repo', head, head, tree), repositoryId: 'f'.repeat(32) }
  const verdicts = await verifyPinsAsync([...good, moved, symbolic, corrupt, wrongTree, wrongRepository])
  for (const m of good) expect(verdicts.get(m)).toBeUndefined()
  expect(verdicts.get(moved)?.message).toMatch(/pin changed/)
  expect(verdicts.get(symbolic)?.message).toMatch(/Symbolic/)
  expect(verdicts.get(corrupt)).toBeInstanceOf(Error)
  expect(verdicts.get(wrongTree)?.message).toMatch(/result tree changed/)
  expect(verdicts.get(wrongRepository)?.message).toMatch(/identity/)
})

it('costs the same Git processes for one retired worktree as for hundreds, past the command-line limit', async () => {
  const root = tempRoot()
  const repo = repository(root)
  const head = git(repo.main, 'rev-parse', 'HEAD')
  const tree = git(repo.main, 'rev-parse', 'HEAD^{tree}')
  // 300 manifests, 600 refs of ~150 characters: far past one Windows command line, so the listing is split.
  const many = Array.from({ length: 300 }, (_, i) => manifest(repo.commonDir, `m-${i}`, head, head, tree))
  writeFileSync(join(root, 'refs.txt'), many.flatMap((m) => [`update ${m.baseRef} ${head}`, `update ${m.resultRef} ${head}`]).join('\n') + '\n')
  execFileSync('git', ['update-ref', '--stdin'], { cwd: repo.main, env: FIXTURE_ENV, input: readFileSync(join(root, 'refs.txt')) })
  await verifyPinsAsync([many[0]!]) // The central check reads the repository's settings once; not counted.
  const one = await gitStarts(root, () => verifyPinsAsync([many[0]!]))
  const all = await gitStarts(root, () => verifyPinsAsync(many))
  expect([...one.value.values()]).toEqual([undefined])
  expect([...all.value.values()].every((error) => error === undefined)).toBe(true)
  expect(one.starts).toBeLessThanOrEqual(2)
  // The listing in parts, plus one object read: a handful, not two per ref.
  expect(all.starts).toBeLessThanOrEqual(one.starts + 10)
})
