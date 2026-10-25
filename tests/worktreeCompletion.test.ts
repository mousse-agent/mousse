import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'

const tempRoots: string[] = []
const originalMousseHome = process.env.MOUSSE_HOME

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  if (originalMousseHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = originalMousseHome
})

describe('completed worktree integration', () => {
  it('uses complete agent ids for the worktree branch and path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-readiness-'))
    tempRoots.push(root)
    process.env.MOUSSE_HOME = join(root, 'home')
    const git = simpleGit(root)
    await git.init()
    await git.addConfig('user.name', 'Mousse Test')
    await git.addConfig('user.email', 'mousse@example.test')
    writeFileSync(join(root, 'base.txt'), 'base\n')
    await git.add('base.txt')
    await git.commit('base')

    const manager = new WorktreeManager(root)
    await manager.init()

    const worktree = await manager.createWorktree('no-op-agent-123456789')
    expect(worktree.branch).toBe('mousse/agent/no-op-agent-123456789')
    expect(worktree.path).toContain('no-op-agent-123456789')
  }, 15_000)

  it('reports a merge candidate only while both the agent branch and its directory exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-merge-candidate-'))
    tempRoots.push(root)
    process.env.MOUSSE_HOME = join(root, 'home')
    const git = simpleGit(root)
    await git.init()
    await git.addConfig('user.name', 'Mousse Test')
    await git.addConfig('user.email', 'mousse@example.test')
    writeFileSync(join(root, 'base.txt'), 'base\n')
    await git.add('base.txt')
    await git.commit('base')
    const manager = new WorktreeManager(root)
    await manager.init()

    const intact = await manager.createWorktree('intact-agent-123456')
    expect(await manager.hasMergeCandidate(intact)).toBe(true)

    const branchGone = await manager.createWorktree('branch-gone-agent')
    await git.raw(['update-ref', '-d', `refs/heads/${branchGone.branch}`])
    expect(await manager.hasMergeCandidate(branchGone)).toBe(false)

    const directoryGone = await manager.createWorktree('directory-gone-agent')
    rmSync(directoryGone.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(await manager.hasMergeCandidate(directoryGone)).toBe(false)
  }, 15_000)
})
