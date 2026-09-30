import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublishService } from '../src/mms/actions/PublishService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { WorkspaceGcService } from '../src/mms/workspace/WorkspaceGcService'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation reviewed publish and retention', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it('rejects stale reviewed source or target and publishes the exact pair once across service restart', async () => {
    const workspace = f.child('task')
    const reviewed = f.commit(workspace, 'reviewed\n')
    const newer = f.commit(workspace, 'newer\n')
    const target = git(f.repo, 'branch', '--show-current')
    const options = { operationId: 'publish-reviewed', expectedSourceSha: reviewed, expectedTargetSha: f.baseSha }
    const publish = new PublishService(f.thread)
    await expect(publish.publish(workspace, f.repo, target, undefined, options)).rejects.toThrow(/source revision changed/)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const moved = f.commit(f.repo, 'human primary commit\n', 'human.txt')
    await expect(publish.publish(workspace, f.repo, target, undefined, { ...options, expectedSourceSha: newer })).rejects.toThrow(/destination revision changed/)
    const current = { ...options, expectedSourceSha: newer, expectedTargetSha: moved }
    const result = await publish.publish(workspace, f.repo, target, undefined, current)
    expect(result.state).toBe('completed')
    expect(git(f.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/)).toEqual([result.publishSha, moved, newer])
    expect(f.read(f.repo)).toBe('newer\n')
    expect(f.read(f.repo, 'human.txt')).toBe('human primary commit\n')
    expect(await new PublishService(f.thread).publish(workspace, f.repo, target, undefined, current)).toEqual(result)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(result.publishSha)
    expect(new ChangeReceiptService(f.thread).list().filter((receipt) => receipt.kind === 'publish')).toHaveLength(1)
    await expect(publish.publish(workspace, f.repo, target, undefined, options)).rejects.toThrow(/identity.*different revisions/)
  }, 30_000)

  it('empty caller inventory cannot retire an owned task or the before/after refs promised by undo', async () => {
    const workspace = (await new WorkspaceResolver(f.thread, 'task', f.repo).resolve('agent')).workspacePath!
    const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(workspace), () => writeFileSync(join(workspace, 'value.txt'), 'unpublished\n'))
    const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === action.receiptId)!
    const gc = new WorkspaceGcService(f.repo)
    const report = gc.dryRun(new Set(), new Set())
    expect(report.staleWorktrees.map((item) => item.path)).not.toContain(workspace)
    for (const ref of receipt.retainedRefs) expect(report.retainedRefs).toContain(ref)
    await gc.purge(report, true)
    expect(existsSync(workspace)).toBe(true)
    expect(f.read(workspace)).toBe('unpublished\n')
    for (const ref of receipt.retainedRefs) expect(git(f.repo, 'rev-parse', ref)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses a GC report whose candidate gained unpublished work after inventory', async () => {
    const ownedRoot = join(f.home, 'repositories', 'fixture')
    mkdirSync(ownedRoot, { recursive: true })
    const candidate = join(ownedRoot, 'retired')
    git(f.repo, 'worktree', 'add', '-q', '-b', 'retired', candidate)
    const gc = new WorkspaceGcService(f.repo)
    const report = gc.dryRun(new Set(), new Set())
    expect(report.staleWorktrees).toHaveLength(1)
    const result = f.commit(candidate, 'late unpublished work\n')
    await expect(gc.purge(report, true)).rejects.toThrow(/retained|revision changed/)
    expect(existsSync(candidate)).toBe(true)
    expect(git(candidate, 'rev-parse', 'HEAD')).toBe(result)
  })
})
