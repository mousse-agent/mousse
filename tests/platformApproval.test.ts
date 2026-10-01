import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/mms/execution/ApprovalService'
import { WorkflowConcurrencyError } from '../src/shared/workflows'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('ApprovalService', () => {
  it('binds digest/revision and consumes once', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-appr-'))
    dirs.push(root)
    const service = new ApprovalService({ profileId: 'p1', profileRoot: root })
    const created = service.create({
      profileId: 'p1',
      runId: '11111111-1111-4111-8111-111111111111',
      actor: { kind: 'workflow' },
      nodeId: 'collect',
      instanceKey: 'collect',
      attempt: 1,
      definitionId: 'd',
      revisionId: 'rev',
      policySnapshotId: 'pol',
      requestDigest: 'abc',
      description: 'script collect',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    const first = service.decide({
      approvalId: created.approvalId,
      profileId: 'p1',
      actorId: 'user',
      approved: true,
      now: new Date().toISOString(),
      expectedRunId: created.runId,
      expectedDigest: 'abc'
    })
    expect(first.decision).toBe('approved')
    expect(() =>
      service.decide({
        approvalId: created.approvalId,
        profileId: 'p1',
        actorId: 'user',
        approved: true,
        now: new Date().toISOString(),
        expectedRunId: created.runId,
        expectedDigest: 'abc'
      })
    ).toThrow(WorkflowConcurrencyError)
  })

  it('rejects stale digest and expired approvals', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-appr-'))
    dirs.push(root)
    const service = new ApprovalService({ profileId: 'p1', profileRoot: root })
    const created = service.create({
      profileId: 'p1',
      runId: '11111111-1111-4111-8111-111111111111',
      actor: { kind: 'workflow' },
      nodeId: 'collect',
      instanceKey: 'collect',
      attempt: 1,
      definitionId: 'd',
      revisionId: 'rev',
      policySnapshotId: 'pol',
      requestDigest: 'abc',
      description: 'script',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })
    expect(() =>
      service.decide({
        approvalId: created.approvalId,
        profileId: 'p1',
        actorId: 'user',
        approved: true,
        now: new Date().toISOString(),
        expectedRunId: created.runId,
        expectedDigest: 'abc'
      })
    ).toThrow(/expired/)
  })

  it('rejects path-shaped ids and approvals submitted for another run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-appr-'))
    dirs.push(root)
    const service = new ApprovalService({ profileId: 'p1', profileRoot: root })
    expect(() => service.get('../../outside', 'p1')).toThrow(/Invalid approval id/)
    const created = service.create({
      profileId: 'p1',
      runId: '11111111-1111-4111-8111-111111111111',
      actor: { kind: 'workflow' },
      nodeId: 'collect',
      instanceKey: 'collect',
      attempt: 1,
      definitionId: 'd',
      revisionId: 'rev',
      policySnapshotId: 'pol',
      requestDigest: 'abc',
      description: 'script',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    expect(() => service.decide({
      approvalId: created.approvalId,
      profileId: 'p1',
      expectedRunId: '22222222-2222-4222-8222-222222222222',
      actorId: 'user',
      approved: true,
      now: new Date().toISOString(),
      expectedDigest: 'abc'
    })).toThrow(/run mismatch/)
    expect(service.get(created.approvalId, 'p1')?.consumedAt).toBeUndefined()
  })
})
