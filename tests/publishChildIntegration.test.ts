import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PublishService } from '../src/mms/actions/PublishService'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'

const roots: string[] = []
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'mousse-publish-')); roots.push(base)
  const repo = join(base, 'repo'); const threadDir = join(base, 'thread-data'); mkdirSync(repo); mkdirSync(threadDir)
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  writeFileSync(join(repo, 'base.txt'), 'base\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  return { base, repo, threadDir }
}
function commit(cwd: string, path: string, content: string, message: string): string {
  writeFileSync(join(cwd, path), content); execFileSync('git', ['add', '.'], { cwd }); execFileSync('git', ['commit', '-qm', message], { cwd })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('publish and child integration', () => {
  it('publishes a thread branch with an auditable no-ff merge and no push', async () => {
    const { base, repo, threadDir } = setup(); const workspace = join(base, 'workspace')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'mousse/thread/t/b', workspace], { cwd: repo })
    commit(workspace, 'thread.txt', 'thread\n', 'thread change')
    const target = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()
    const result = await new PublishService(threadDir).publish(workspace, repo, target)
    expect(result.state).toBe('completed')
    expect(readFileSync(join(repo, 'thread.txt'), 'utf8').trim()).toBe('thread')
    expect(execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim().split(/\s+/)).toHaveLength(3)
  })

  it('merges committed stopped worker work into the thread and retains its ref', async () => {
    const { base, repo, threadDir } = setup(); const worker = join(base, 'worker')
    const spawnBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'mousse/agent/full-agent-id', worker], { cwd: repo })
    const workerHead = commit(worker, 'agent.txt', 'agent\n', 'agent work')
    const record = await new ChildAgentIntegrationService(threadDir).integrate({
      agentId: 'full-agent-id', workerWorktree: worker, workerBranch: 'mousse/agent/full-agent-id',
      spawnBaseSha, expectedWorkerHead: workerHead, threadWorkspace: repo
    })
    expect(record.workerHeadSha).toBe(workerHead)
    expect(readFileSync(join(repo, 'agent.txt'), 'utf8').trim()).toBe('agent')
    expect(execFileSync('git', ['show-ref', '--verify', 'refs/mousse/agents/full-agent-id'], { cwd: repo, encoding: 'utf8' })).toContain(workerHead)
  })
})
