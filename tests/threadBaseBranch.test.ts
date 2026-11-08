import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { Thread } from '../src/shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
}

describe('threads.create with a base branch', () => {
  let home: string
  let mms: MousseMainService
  let repo: string
  let projectId: string
  let mainSha: string
  let featureSha: string
  const ctx = () => ({ mms, globalSequence: () => 0 })

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-base-branch-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    repo = join(home, 'projects', 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'file.txt'), 'one\n')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-q', '-m', 'one')
    mainSha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', '-b', 'feat/x')
    writeFileSync(join(repo, 'file.txt'), 'two\n')
    git(repo, 'commit', '-q', '-am', 'two')
    featureSha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', 'main')
    projectId = (await dispatchMethod(ctx(), 'projects.open', { path: repo }) as { project: { id: string } }).project.id
  })

  afterEach(async () => {
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const create = async (params: Record<string, unknown>) =>
    (await dispatchMethod(ctx(), 'threads.create', { name: 'Base branch', projectId, worktreeEnabled: true, ...params }) as { thread: Thread }).thread

  /** The commit the thread's new worktree is made at. */
  async function worktreeHead(thread: Thread): Promise<string> {
    const manager = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo, undefined, undefined, undefined, { nameFrom: 'base branch' })
    return git(metadata.worktreePath, 'rev-parse', 'HEAD')
  }

  it('starts the new worktree from the given branch, on a branch of its own', async () => {
    const thread = await create({ baseBranch: 'feat/x' })
    expect(thread.worktreeStartSha).toBe(featureSha)
    expect(thread.worktreeBaseBranch).toBe('feat/x')
    expect(await worktreeHead(thread)).toBe(featureSha)
    // The project folder is left on its own branch.
    expect(git(repo, 'branch', '--show-current')).toBe('main')
  })

  it('starts from the project folder\'s HEAD when no branch is given, as before', async () => {
    const thread = await create({})
    expect(thread.worktreeStartSha).toBeUndefined()
    expect(thread.worktreeBaseBranch).toBeUndefined()
    expect(await worktreeHead(thread)).toBe(mainSha)
  })

  it('refuses a branch the project does not have', async () => {
    await expect(create({ baseBranch: 'no-such-branch' })).rejects.toMatchObject({ code: 'invalid_params', message: 'Branch no-such-branch was not found' })
  })

  it('refuses revision syntax and option-like names instead of resolving them', async () => {
    for (const baseBranch of ['feat/x~1', 'main@{1}', 'main^', '--help', 'main..feat/x']) {
      await expect(create({ baseBranch })).rejects.toMatchObject({ code: 'invalid_params', message: `Branch ${baseBranch} was not found` })
    }
  })

  it('keeps the start after a restart and uses it when the worktree is made later', async () => {
    const created = await create({ baseBranch: 'feat/x' })
    await mms.stop()
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const reloaded = mms.threads.getThread(created.id)!
    expect(reloaded.worktreeStartSha).toBe(featureSha)
    expect(reloaded.worktreeBaseBranch).toBe('feat/x')
    expect(await worktreeHead(reloaded)).toBe(featureSha)
  })

  it('refuses a base branch without a new worktree', async () => {
    await expect(create({ baseBranch: 'feat/x', worktreeEnabled: false })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
