import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'

const roots: string[] = []
function repository(): { root: string; home: string; thread: string } {
  const base = mkdtempSync(join(tmpdir(), 'mousse-workspace-')); roots.push(base)
  const root = join(base, 'repo'); const home = join(base, 'home'); const thread = join(base, 'thread')
  mkdirSync(root); mkdirSync(thread)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  writeFileSync(join(root, 'README'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root })
  return { root, home, thread }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('ThreadWorkspaceManager', () => {
  it('provisions a durable full-id branch, retained ref, and external worktree', async () => {
    const fixture = repository(); const previous = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = fixture.home
    try {
      const manager = new ThreadWorkspaceManager(fixture.thread)
      const metadata = await manager.provision('thread-full-id', 'branch-full-id', fixture.root)
      expect(metadata.branch).toBe('mousse/thread/thread-full-id/branch-full-id')
      expect(metadata.worktreePath.startsWith(fixture.home)).toBe(true)
      expect(execFileSync('git', ['branch', '--show-current'], { cwd: metadata.worktreePath, encoding: 'utf8' }).trim()).toBe(metadata.branch)
      expect(execFileSync('git', ['show-ref', '--verify', metadata.retainedRef], { cwd: fixture.root, encoding: 'utf8' })).toContain(metadata.retainedRef)
      expect(manager.executionContext(fixture.root).projectPath).toBe(metadata.worktreePath)
    } finally {
      if (previous === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previous
    }
  })

  it('refuses dirty primary provisioning without changing HEAD', async () => {
    const fixture = repository(); const previous = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = fixture.home
    try {
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim()
      writeFileSync(join(fixture.root, 'dirty.txt'), 'dirty')
      await expect(new ThreadWorkspaceManager(fixture.thread).provision('thread', 'branch', fixture.root))
        .rejects.toThrow('clean primary checkout')
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim()).toBe(before)
    } finally {
      if (previous === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previous
    }
  })
})
