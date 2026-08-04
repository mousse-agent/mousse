import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceGcService } from '../src/mms/workspace/WorkspaceGcService'

const roots: string[] = []; const originalHome = process.env.MOUSSE_HOME
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = originalHome
})

describe('WorkspaceGcService', () => {
  it('reports only owned unreferenced resources and requires confirmation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mousse-gc-')); roots.push(base); process.env.MOUSSE_HOME = join(base, 'home')
    const repo = join(base, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
    writeFileSync(join(repo, 'README'), 'x'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
    const owned = join(process.env.MOUSSE_HOME, 'repositories', 'id', 'worktrees', 'agents', 'agent'); mkdirSync(join(owned, '..'), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'mousse/agent/agent', owned], { cwd: repo })
    execFileSync('git', ['update-ref', 'refs/mousse/agents/agent', 'HEAD'], { cwd: repo })
    const service = new WorkspaceGcService(repo); const report = service.dryRun(new Set(), new Set())
    expect(report.staleWorktrees.map((item) => resolve(item.path))).toContain(resolve(owned))
    expect(report.unreferencedRefs).toContain('refs/mousse/agents/agent')
    await expect(service.purge(report, false)).rejects.toThrow('confirmation')
  })
})
