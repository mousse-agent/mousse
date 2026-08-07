import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
  it('merges a surviving completed-agent branch before removing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-worktree-'))
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
    const worktree = await manager.createWorktree('completed-agent')
    const workerGit = simpleGit(worktree.path)
    writeFileSync(join(worktree.path, 'agent.txt'), 'preserved result\n')
    await workerGit.add('agent.txt')
    await workerGit.commit('agent result')

    expect(await manager.hasMergeCandidate(worktree)).toBe(true)
    expect(await git.raw(['show', `${worktree.branch}:agent.txt`])).toBe('preserved result\n')
    expect((await manager.mergeAndRemove(worktree)).success).toBe(true)
    expect(await git.raw(['show', 'HEAD:agent.txt'])).toBe('preserved result\n')
    expect(readFileSync(join(root, 'agent.txt'), 'utf8').trim()).toBe('preserved result')
    // Merge does not implicitly delete the worker checkout or branch.
    expect(existsSync(worktree.path)).toBe(true)
    expect(await manager.hasMergeCandidate(worktree)).toBe(true)
    expect(await manager.cleanupValidatedAgentWorktree(worktree, { deleteBranch: true })).toMatchObject({
      success: true
    })
    expect(existsSync(worktree.path)).toBe(false)
    expect(await manager.hasMergeCandidate(worktree)).toBe(false)
  }, 15_000)

  it('uses complete agent ids and rejects no-op, dirty, and empty-only agent completions', async () => {
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

    const noOp = await manager.createWorktree('no-op-agent-123456789')
    expect(noOp.branch).toBe('mousse/agent/no-op-agent-123456789')
    expect(noOp.path).toContain('no-op-agent-123456789')
    expect(await manager.validateAgentReadiness(noOp)).toMatchObject({
      ready: false,
      reason: 'Agent completed without creating a worker-authored commit.'
    })

    const dirty = await manager.createWorktree('dirty-agent')
    writeFileSync(join(dirty.path, 'unfinished.txt'), 'not committed\n')
    expect(await manager.validateAgentReadiness(dirty)).toMatchObject({
      ready: false,
      changedFiles: ['unfinished.txt']
    })

    const empty = await manager.createWorktree('empty-agent')
    await simpleGit(empty.path).raw(['commit', '--allow-empty', '-m', 'empty result'])
    expect(await manager.validateAgentReadiness(empty)).toMatchObject({
      ready: false,
      reason: 'Agent created only empty commits; the branch has no changes.'
    })
  }, 15_000)
})
