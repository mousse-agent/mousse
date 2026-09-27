import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildAgentIntegrationService } from '../src/mms/agents/ChildAgentIntegrationService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation pinned child results', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  function request(child: string, result: string, operationId = 'integrate-child') {
    return {
      operationId, agentId: 'child', workerWorktree: child, workerBranch: 'child',
      spawnBaseSha: f.baseSha, expectedWorkerHead: result,
      expectedDestinationHead: f.baseSha, threadWorkspace: f.repo
    }
  }

  it('records one immutable merge receipt with pinned base/result and retries without a second merge', async () => {
    const child = f.child()
    f.commit(child, 'first\n')
    const result = f.commit(child, 'second\n')
    const service = new ChildAgentIntegrationService(f.thread)
    const input = request(child, result)
    const integrated = await service.integrate(input)
    const receipts = new ChangeReceiptService(f.thread).list()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      id: integrated.receiptId, operationId: input.operationId, kind: 'integration',
      beforeSha: f.baseSha, afterSha: integrated.integrationSha,
      introducedCommits: [integrated.integrationSha],
      contributions: [{ actorId: 'child', baseSha: f.baseSha, resultSha: result }]
    })
    expect(git(f.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/)).toEqual([integrated.integrationSha, f.baseSha, result])
    for (const ref of receipts[0].retainedRefs) expect(git(f.repo, 'rev-parse', ref)).toMatch(/^[0-9a-f]{40}$/)
    expect(await service.integrate(input)).toEqual(integrated)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(integrated.integrationSha)
    expect(new ChangeReceiptService(f.thread).list()).toEqual(receipts)
    expect(f.read(child)).toBe('second\n')
  }, 30_000)

  it('rejects stale source and destination revisions before writing any integration receipt', async () => {
    const child = f.child()
    const reviewed = f.commit(child, 'reviewed\n')
    const newer = f.commit(child, 'newer\n')
    const service = new ChildAgentIntegrationService(f.thread)
    await expect(service.integrate(request(child, reviewed))).rejects.toThrow(/Worker HEAD changed/)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const movedParent = f.commit(f.repo, 'parent\n', 'parent.txt')
    await expect(service.integrate(request(child, newer))).rejects.toThrow(/destination HEAD changed/)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(movedParent)
    expect(new ChangeReceiptService(f.thread).list()).toEqual([])
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
  })

  it('keeps both divergent results and the conflict journal recoverable', async () => {
    const a = f.child()
    const b = f.child('other-child')
    const resultA = f.commit(a, 'result A\n')
    const resultB = f.commit(b, 'result B\n')
    const service = new ChildAgentIntegrationService(f.thread)
    const first = await service.integrate(request(a, resultA))
    await expect(service.integrate({
      ...request(b, resultB, 'integrate-other'), agentId: 'other-child', workerBranch: 'other-child',
      expectedDestinationHead: first.integrationSha
    })).rejects.toThrow(/conflict/i)
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    expect(git(a, 'rev-parse', 'HEAD')).toBe(resultA)
    expect(git(b, 'rev-parse', 'HEAD')).toBe(resultB)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(first.integrationSha)
    expect(git(f.repo, 'diff', '--name-only', '--diff-filter=U')).toBe('value.txt')
    expect(new ThreadJournal(f.thread).latestByOperation().get('integrate-other')).toMatchObject({
      state: 'recovery_required', details: { workerHeadSha: resultB, conflictFiles: ['value.txt'] }
    })
    expect(new ChangeReceiptService(f.thread).list()).toHaveLength(1)
  }, 30_000)

  it('rejects dirty child results without committing or discarding their work', async () => {
    const child = f.child()
    const result = f.commit(child, 'committed\n')
    writeFileSync(join(child, 'value.txt'), 'pending\n')
    await expect(new ChildAgentIntegrationService(f.thread).integrate(request(child, result))).rejects.toThrow(/clean|dirty|uncommitted/i)
    expect(f.read(child)).toBe('pending\n')
    expect(git(child, 'rev-parse', 'HEAD')).toBe(result)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  })
})
