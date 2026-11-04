import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublishService } from '../src/mms/actions/PublishService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

describe('Git foundation reviewed publish', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it('rejects stale reviewed source or target and publishes the exact pair once, as one commit, across service restart', async () => {
    const workspace = f.child('task')
    const reviewed = f.commit(workspace, 'reviewed\n')
    const newer = f.commit(workspace, 'newer\n')
    const target = git(f.repo, 'branch', '--show-current')
    const options = { operationId: 'publish-reviewed', expectedSourceSha: reviewed, expectedTargetSha: f.baseSha }
    const publish = new PublishService(f.thread)
    await expect(pressed('Publish', () => publish.publish(workspace, f.repo, target, undefined, options))).rejects.toThrow(/source revision changed/)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const moved = f.commit(f.repo, 'human primary commit\n', 'human.txt')
    await expect(pressed('Publish', () => publish.publish(workspace, f.repo, target, undefined, { ...options, expectedSourceSha: newer }))).rejects.toThrow(/destination revision changed/)
    const current = { ...options, expectedSourceSha: newer, expectedTargetSha: moved }
    const result = await pressed('Publish', () => publish.publish(workspace, f.repo, target, undefined, current))
    expect(result.state).toBe('completed')
    // One new commit on top of the primary's own, with the same files as the thread's; the thread's two commits are not in it.
    expect(git(f.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/)).toEqual([result.publishSha, moved])
    expect(git(f.repo, 'rev-list', '--count', `${moved}..HEAD`)).toBe('1')
    expect(git(f.repo, 'branch', '--contains', newer, '--list', target)).toBe('')
    expect(f.read(f.repo)).toBe('newer\n')
    expect(f.read(f.repo, 'human.txt')).toBe('human primary commit\n')
    expect(await pressed('Publish', () => new PublishService(f.thread).publish(workspace, f.repo, target, undefined, current))).toEqual(result)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(result.publishSha)
    expect(new ChangeReceiptService(f.thread).list().filter((receipt) => receipt.kind === 'publish')).toHaveLength(1)
    await expect(pressed('Publish', () => publish.publish(workspace, f.repo, target, undefined, options))).rejects.toThrow(/identity.*different revisions/)
  }, 30_000)
})
