import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { worktreeCheckoutPlan } from '../src/mms/worktree/worktreeCheckout'
import { actionOptions } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

vi.setConfig({ testTimeout: 60_000 })

/**
 * A new worktree's files (#1506): written by parallel workers unless Git's config says how many, and only the paths of
 * the project's sparse-checkout pattern file (`mousse.sparseCheckout`) when it names one.
 *
 * Inputs: no setting; `checkout.workers` set by the repository; a pattern file of folders (cone mode); one with
 * patterns (no-cone); a pattern file that is missing; one that names nothing; per-worktree settings off; a restore
 * after the pattern file went away; a turn and its Undo in the sparse worktree.
 */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let base: string, repo: string, home: string, thread: string, previousHome: string | undefined
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mousse-checkout-'))
  repo = join(base, 'repo'); home = join(base, 'home'); thread = join(base, 'thread')
  for (const dir of [repo, thread, join(repo, 'app'), join(repo, 'other')]) mkdirSync(dir)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test'); git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'root.txt'), 'root\n'); writeFileSync(join(repo, 'app', 'a.txt'), 'a\n'); writeFileSync(join(repo, 'other', 'b.txt'), 'b\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  previousHome = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previousHome
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function sparseProject(patterns: string, file = 'sparse.txt'): void {
  writeFileSync(join(repo, file), patterns)
  git(repo, 'config', 'extensions.worktreeConfig', 'true')
  git(repo, 'config', 'mousse.sparseCheckout', file)
}

const nothingMade = (): void => {
  expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/mousse', 'refs/mousse')).toBe('')
  expect(existsSync(join(home, 'repositories')) ? readdirSync(join(home, 'repositories'), { recursive: true }).filter((name) => String(name).includes('threads')) : []).toEqual([])
  expect(spawnSync('git', ['config', '--get', 'core.sparseCheckout'], { cwd: repo }).status).toBe(1)
}

describe('the plan read from the project\'s Git config', () => {
  it.each([
    { name: 'no setting: parallel workers, every file', config: [] as string[][], file: undefined as string | undefined, workers: true, sparse: undefined as undefined | { cone: boolean; patterns: string } },
    { name: 'the repository sets checkout.workers: Git\'s own setting stands', config: [['checkout.workers', '2']], file: undefined, workers: false, sparse: undefined },
    { name: 'folders: cone mode, slashes dropped', config: [['extensions.worktreeConfig', 'true'], ['mousse.sparseCheckout', 'sparse.txt']], file: '# app only\n/app/\n\n', workers: true, sparse: { cone: true, patterns: 'app\n' } },
    { name: 'patterns: no-cone mode, as written', config: [['extensions.worktreeConfig', 'true'], ['mousse.sparseCheckout', 'sparse.txt']], file: '/*.txt\n!/other/\n', workers: true, sparse: { cone: false, patterns: '/*.txt\n!/other/\n' } }
  ])('$name', async ({ config, file, workers, sparse }) => {
    for (const [key, value] of config) git(repo, 'config', key!, value!)
    if (file !== undefined) writeFileSync(join(repo, 'sparse.txt'), file)
    const plan = await worktreeCheckoutPlan(repo)
    expect(plan.settings.includes('checkout.workers=0')).toBe(workers)
    expect(plan.sparse ? { cone: plan.sparse.cone, patterns: plan.sparse.patterns } : undefined).toEqual(sparse)
  })
})

describe('a new thread\'s worktree', () => {
  it.runIf(availableParallelism() > 1)('is written by parallel checkout workers, unless the repository sets checkout.workers', async () => {
    const trace = join(base, 'trace')
    const workers = async (threadId: string): Promise<number> => {
      process.env.GIT_TRACE2_EVENT = trace
      try { await new ThreadWorkspaceManager(join(thread, threadId)).provision(threadId, 'main', repo) } finally { delete process.env.GIT_TRACE2_EVENT }
      const started = readFileSync(trace, 'utf8').split('\n').filter((line) => line.includes('"child_start"') && line.includes('checkout--worker')).length
      rmSync(trace)
      return started
    }
    // Past Git's threshold for parallel checkout (100 files).
    mkdirSync(join(repo, 'many'))
    for (let index = 0; index < 120; index++) writeFileSync(join(repo, 'many', `f${index}.txt`), `${index}\n`)
    git(repo, 'add', 'many'); git(repo, 'commit', '-qm', 'many')
    mkdirSync(join(thread, 'one')); mkdirSync(join(thread, 'two'))
    expect(await workers('one')).toBeGreaterThan(0)
    git(repo, 'config', 'checkout.workers', '1')
    expect(await workers('two')).toBe(0)
  })

  it('holds only the pattern file\'s paths, reads clean, and records and undoes a turn without touching the paths outside', async () => {
    sparseProject('app\n')
    const made = await new ThreadWorkspaceManager(thread).provision('task', 'main', repo)
    const cwd = made.worktreePath
    expect(readFileSync(join(cwd, 'app', 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(cwd, 'root.txt'), 'utf8')).toBe('root\n')
    expect(existsSync(join(cwd, 'other'))).toBe(false)
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
    // Only this worktree is sparse: the project's own checkout still has every file.
    expect(existsSync(join(repo, 'other', 'b.txt'))).toBe(true)
    expect(git(repo, 'status', '--porcelain')).toBe('?? sparse.txt')

    const { action } = await new ThreadActionService(thread).runCheckpointedAction(actionOptions(cwd), () => writeFileSync(join(cwd, 'app', 'new.txt'), 'new\n'))
    expect(action.state).toBe('completed')
    expect(action.changedPaths.map((item) => item.path)).toEqual(['app/new.txt'])
    expect(git(cwd, 'ls-tree', '-r', '--name-only', action.endSha!).split('\n')).toContain('other/b.txt')
    await pressed('Undo', () => new UndoService(thread).undoLatest('main', cwd))
    expect(existsSync(join(cwd, 'app', 'new.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'other'))).toBe(false)
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  })

  it.each([
    { name: 'a pattern file that is missing', setUp: () => { sparseProject('app\n'); rmSync(join(repo, 'sparse.txt')) }, error: /could not be read/ },
    { name: 'a pattern file that names nothing', setUp: () => sparseProject('# nothing yet\n\n'), error: /names no paths/ },
    { name: 'per-worktree settings off', setUp: () => { sparseProject('app\n'); git(repo, 'config', '--unset', 'extensions.worktreeConfig') }, error: /extensions\.worktreeConfig/ }
  ])('is refused before anything is made with $name', async ({ setUp, error }) => {
    setUp()
    await expect(new ThreadWorkspaceManager(thread).provision('task', 'main', repo)).rejects.toThrow(error)
    nothingMade()
  })

  it('comes back whole when it is restored after the pattern file went away', async () => {
    sparseProject('app\n')
    const manager = new ThreadWorkspaceManager(thread)
    const made = await manager.provision('task', 'main', repo)
    git(repo, 'worktree', 'remove', made.worktreePath)
    rmSync(join(repo, 'sparse.txt'))
    const restored = await manager.restore(repo)
    expect(restored.lifecycle).toBe('ready')
    expect(readFileSync(join(restored.worktreePath, 'other', 'b.txt'), 'utf8')).toBe('b\n')
  })
})
