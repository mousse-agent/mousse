/**
 * Ownership checks read a worktree's facts without starting Git when the worktree has exactly the layout
 * `git worktree add` writes and its owner is one Git trusts, and read pinned refs per repository instead of per ref.
 * These answers decide whether another thread's worktree is verified (its claims are exact) or unverified (it holds
 * its whole repository), so the file reader may only ever be more careful than Git: whatever Git refuses, or might,
 * must end unverified or go to Git, never "verified". Git is the oracle here: `rev-parse` and
 * `git worktree list --porcelain -z`, not Mousse's own registration reader.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { verifyWorktreeFact } from '../src/mms/lifecycle/ResourceInventory'
import { getExternalResourceClaims, unverifiedOwnerOver } from '../src/mms/lifecycle/LifecycleClaims'
import { verifyPinsAsync } from '../src/mms/lifecycle/worktreeFacts'
import type { WorktreeReconstructionManifest } from '../src/mms/lifecycle/WorktreeRetirementService'
import { unverifiableThread } from './support/unverifiableThread'

// Each case runs Git dozens of times to build its layouts; starting a process on Windows is slow.
vi.setConfig({ testTimeout: 180_000 })

const FIXTURE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const roots: string[] = []
const savedEnv = { owner: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER, global: process.env.GIT_CONFIG_GLOBAL }
afterEach(() => {
  delete process.env.GIT_TRACE2_EVENT
  for (const [name, value] of [['GIT_TEST_ASSUME_DIFFERENT_OWNER', savedEnv.owner], ['GIT_CONFIG_GLOBAL', savedEnv.global]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const gitVersion = (): number[] => (git(tmpdir(), '--version').match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
const relativePathsSupported = (): boolean => { const [major = 0, minor = 0] = gitVersion(); return major > 2 || major === 2 && minor >= 48 }
const repositoryIdOf = (commonDir: string): string => createHash('sha256').update(realpathSync(commonDir).toLowerCase()).digest('hex').slice(0, 32)
const link = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-worktree-facts-')))
  roots.push(root)
  return root
}

function repository(root: string, name: string) {
  const main = join(root, name)
  mkdirSync(main, { recursive: true })
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

/**
 * Git's own answer: the checkout opens, its real common directory is the recorded repository, its top level is the
 * folder itself, and `git worktree list --porcelain -z` in that repository lists it.
 */
function gitVerifies(path: string, expectedRepository: string): boolean {
  try {
    const common = realpathSync(resolve(path, git(path, 'rev-parse', '--git-common-dir')))
    if (createHash('sha256').update(common.toLowerCase()).digest('hex').slice(0, 32) !== expectedRepository) return false
    if (realpathSync(git(path, 'rev-parse', '--show-toplevel')).toLowerCase() !== realpathSync(path).toLowerCase()) return false
    const listed = git(common, '--git-dir', common, 'worktree', 'list', '--porcelain', '-z').split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice('worktree '.length))
    return listed.some((entry) => resolve(entry).toLowerCase() === resolve(path).toLowerCase())
  } catch { return false }
}

/** The ways a worktree is laid out or broken, applied to a fresh worktree `path` of the repository at `main`. */
const LAYOUTS: Record<string, (path: string, main: string, root: string) => void> = {
  plain: () => undefined,
  locked: (path, main) => git(main, 'worktree', 'lock', '--reason', 'away', path),
  'malformed HEAD': (path) => { const gitDir = gitDirOf(path); rmSync(join(gitDir, 'HEAD')); writeFileSync(join(gitDir, 'HEAD'), 'not a head\n') },
  'core.bare in config.worktree': (path, main) => { git(main, 'config', 'extensions.worktreeConfig', 'true'); writeFileSync(join(gitDirOf(path), 'config.worktree'), '[core]\n\tbare = true\n') },
  'core.worktree in config.worktree': (path, main, root) => { git(main, 'config', 'extensions.worktreeConfig', 'true'); mkdirSync(join(root, 'elsewhere'), { recursive: true }); writeFileSync(join(gitDirOf(path), 'config.worktree'), `[core]\n\tworktree = ${join(root, 'elsewhere').replace(/\\/g, '/')}\n`) },
  'repositoryformatversion 2': (_path, main) => git(main, 'config', 'core.repositoryformatversion', '2'),
  'unknown extension': (_path, main) => { git(main, 'config', 'core.repositoryformatversion', '1'); git(main, 'config', 'extensions.noSuchExtension', 'true') },
  'include in the repository config': (_path, main, root) => { writeFileSync(join(root, 'extra.gitconfig'), '[user]\n\tname = Included\n'); git(main, 'config', 'include.path', join(root, 'extra.gitconfig').replace(/\\/g, '/')) },
  'admin folder is a junction': (path) => { const gitDir = gitDirOf(path); renameSync(gitDir, `${gitDir}-real`); link(`${gitDir}-real`, gitDir) },
  'names another registration': (path, main) => { const other = join(dirname(path), 'other'); git(main, 'worktree', 'add', '-q', '-b', `other-${Math.random().toString(16).slice(2, 8)}`, other); const pointer = readFileSync(join(other, '.git'), 'utf8'); rmSync(join(path, '.git')); writeFileSync(join(path, '.git'), pointer) },
  'repository moved, link left behind': (_path, main) => { renameSync(main, `${main}-moved`); link(`${main}-moved`, main) }
}
const gitDirOf = (path: string): string => readFileSync(join(path, '.git'), 'utf8').trim().slice('gitdir: '.length)
/** Layouts the reader may answer without Git; every other one must go to Git. */
const READER_ANSWERS = new Set(['plain', 'locked'])

it('gives Git’s answer for every layout, without Git only for the standard one', async () => {
  const root = tempRoot()
  const store = new ResourceLifecycleStore({ profileId: '11111111-1111-4111-8111-111111111111', profileHome: join(root, 'home') })
  const layouts = Object.entries(LAYOUTS)
  if (relativePathsSupported()) layouts.push(['relative paths', () => undefined])
  for (const [name, apply] of layouts) {
    const repo = repository(root, `repo-${layouts.findIndex(([entry]) => entry === name)}`)
    const id = repositoryIdOf(repo.commonDir)
    const path = join(root, 'wt', name.replace(/\W+/g, '-'), 'main')
    git(repo.main, 'worktree', 'add', '-q', ...(name === 'relative paths' ? ['--relative-paths'] : []), '-b', 'wt', path)
    apply(path, repo.main, root)
    const oracle = gitVerifies(path, id)
    const { value, starts } = await gitStarts(root, () => verifyWorktreeFact(store, path, undefined, id))
    expect({ name, verified: value === undefined }).toEqual({ name, verified: oracle })
    expect({ name, git: starts > 0 }).toEqual({ name, git: !READER_ANSWERS.has(name) })
  }
})

it('the hold at the delete decision is Git’s answer for each layout Git may refuse', async () => {
  const root = tempRoot()
  const home = join(root, 'home')
  const store = new ResourceLifecycleStore({ profileId: '11111111-1111-4111-8111-111111111111', profileHome: home })
  const rows: Array<{ name: string; repositoryId: string; oracle: boolean }> = []
  for (const name of ['plain', 'malformed HEAD', 'core.bare in config.worktree', 'core.worktree in config.worktree', 'repositoryformatversion 2', 'unknown extension', 'admin folder is a junction']) {
    const repo = join(root, `repo-${rows.length}`)
    const peer = unverifiableThread(store, { id: `peer-${rows.length}`, name: 'Fix prices', repo, how: 'intact' })
    LAYOUTS[name]!(peer.worktree, repo, root)
    rows.push({ name, repositoryId: peer.repositoryId, oracle: gitVerifies(peer.worktree, peer.repositoryId) })
  }
  const claims = await getExternalResourceClaims(store, new Set())
  const ref = `refs/mousse/changes/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/before`
  for (const row of rows) {
    const held = Boolean(unverifiedOwnerOver(claims, { repositoryIds: [row.repositoryId], ref }))
    // Git refuses (or does not list) the peer's checkout: its whole repository stays held, and only then.
    expect({ row: row.name, held }).toEqual({ row: row.name, held: !row.oracle })
  }
  expect(rows.find((row) => row.name === 'plain')!.oracle).toBe(true)
})

it('Git checks the checkout itself when only safe.directory can trust it', async () => {
  const root = tempRoot()
  const store = new ResourceLifecycleStore({ profileId: '11111111-1111-4111-8111-111111111111', profileHome: join(root, 'home') })
  const repo = repository(root, 'repo')
  const id = repositoryIdOf(repo.commonDir)
  const path = join(root, 'wt', 'main')
  git(repo.main, 'worktree', 'add', '-q', '-b', 'wt', path)
  // Git's own switch for treating every owner as someone else's: trust can only come from safe.directory.
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
  const config = join(root, 'global.gitconfig')
  writeFileSync(config, '')
  process.env.GIT_CONFIG_GLOBAL = config
  writeFileSync(config, `[safe]\n\tdirectory = ${repo.main.replace(/\\/g, '/')}\n`)
  const untrusted = await gitStarts(root, () => verifyWorktreeFact(store, path, undefined, id))
  expect(untrusted.value).toMatch(/dubious ownership|not a git repository/i)
  expect(untrusted.starts).toBeGreaterThan(0)
  writeFileSync(config, `[safe]\n\tdirectory = ${path.replace(/\\/g, '/')}\n`)
  const trusted = await gitStarts(root, () => verifyWorktreeFact(store, path, undefined, id))
  expect(trusted.value).toBeUndefined()
  expect(trusted.starts).toBeGreaterThan(0)
  writeFileSync(config, '[safe]\n\tdirectory = *\n\tdirectory =\n')
  expect(await verifyWorktreeFact(store, path, undefined, id)).toBeDefined()
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
  const repo = repository(root, 'main')
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
  writeFileSync(join(repo.commonDir, ...corrupt.baseRef.split('/')), 'not a commit\n')
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
  const repo = repository(root, 'main')
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
