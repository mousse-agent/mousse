import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('completed worktree integration', () => {
  it('merges a surviving completed-agent branch before removing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-worktree-'))
    tempRoots.push(root)
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
    expect(existsSync(worktree.path)).toBe(false)
    expect(await manager.hasMergeCandidate(worktree)).toBe(false)
  }, 15_000)
})
