import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import simpleGit from 'simple-git'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'

const roots: string[] = []

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-ready-'))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.addConfig('user.name', 'Mousse Test')
  await git.addConfig('user.email', 'mousse@test.invalid')
  writeFileSync(join(root, '.gitignore'), '.mousse-worktrees/\n.mousse/\n')
  writeFileSync(join(root, 'file.txt'), 'base\n')
  await git.add(['.'])
  await git.commit('base')
  const manager = new WorktreeManager(root)
  await manager.init()
  const worktree = await manager.createWorktree('abcdef12-test')
  return { root, git, manager, worktree }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agent worktree readiness', () => {
  it('rejects an empty implementation commit but permits explicit verification-only work', async () => {
    const { manager, worktree } = await fixture()
    const rejected = await manager.prepareForReady(worktree)
    expect(rejected.success).toBe(false)
    expect(rejected.error).toMatch(/no implementation diff/i)

    const verified = await manager.prepareForReady(worktree, { verificationOnly: true })
    expect(verified.success).toBe(true)
    expect(verified.diffFiles).toEqual([])
  })

  it('safely commits dirty worker changes before reporting ready', async () => {
    const { manager, worktree } = await fixture()
    writeFileSync(join(worktree.path, 'file.txt'), 'implemented\n')

    const result = await manager.prepareForReady(worktree, { summary: 'Implement change' })
    expect(result.success).toBe(true)
    expect(result.diffFiles).toEqual(['file.txt'])
    expect((await simpleGit(worktree.path).status()).isClean()).toBe(true)
    expect((await simpleGit(worktree.path).show([`${result.commit}:file.txt`])).trim()).toBe('implemented')
  })

  it('refuses false-ready merge when the branch moved after validation', async () => {
    const { root, manager, worktree } = await fixture()
    writeFileSync(join(worktree.path, 'file.txt'), 'first\n')
    const ready = await manager.prepareForReady(worktree)
    expect(ready.success).toBe(true)

    writeFileSync(join(worktree.path, 'file.txt'), 'unclaimed\n')
    await simpleGit(worktree.path).add(['file.txt'])
    await simpleGit(worktree.path).commit('unclaimed follow-up')
    const merged = await manager.mergeAndRemove(worktree, {
      commit: ready.commit,
      diffFiles: ready.diffFiles
    })

    expect(merged.success).toBe(false)
    expect(merged.error).toMatch(/ready commit mismatch/i)
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('base\n')
  })

  it('treats an already-merged agent branch as successful complete_task bookkeeping', async () => {
    const { root, git, manager, worktree } = await fixture()
    writeFileSync(join(worktree.path, 'file.txt'), 'implemented\n')
    const ready = await manager.prepareForReady(worktree, { summary: 'Implement change' })
    expect(ready.success).toBe(true)

    const first = await manager.mergeAndRemove(worktree, {
      commit: ready.commit,
      diffFiles: ready.diffFiles
    })
    expect(first.success).toBe(true)
    expect(readFileSync(join(root, 'file.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('implemented\n')

    // Simulate the recovery path: branch tip is already contained in main.
    const retry = await manager.mergeAndRemove(worktree, {
      commit: ready.commit,
      diffFiles: ready.diffFiles
    })
    expect(retry.success).toBe(true)
    expect((await git.status()).isClean()).toBe(true)
  })
})
