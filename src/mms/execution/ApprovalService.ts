import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../data/AtomicFs'
import type { ExecutionActor } from '../../shared/execution/types'
import type { DurableApprovalRecord } from '../../shared/workflows'
import { WorkflowConcurrencyError } from '../../shared/workflows'
import { withFileLock } from '../scheduled/fileLock'

export interface CreateApprovalInput {
  profileId: string
  runId: string
  actor: ExecutionActor
  nodeId: string
  instanceKey: string
  attempt: number
  definitionId: string
  revisionId: string
  policySnapshotId: string
  requestDigest: string
  description: string
  expiresAt: string
  createdAt: string
}

export class ApprovalService {
  private readonly root: string
  private readonly profileId: string

  constructor(options: { profileId: string; profileRoot: string }) {
    if (!options.profileId) throw new Error('ApprovalService requires profileId')
    if (!options.profileRoot) throw new Error('ApprovalService requires profileRoot')
    this.profileId = options.profileId
    this.root = join(options.profileRoot, 'approvals')
    mkdirSync(this.root, { recursive: true })
  }

  create(input: CreateApprovalInput): DurableApprovalRecord {
    this.assertProfile(input.profileId)
    const record: DurableApprovalRecord = {
      approvalId: randomUUID(),
      ...input
    }
    this.write(record)
    return record
  }

  get(approvalId: string, profileId: string): DurableApprovalRecord | undefined {
    this.assertProfile(profileId)
    const path = this.recordPath(approvalId)
    if (!existsSync(path)) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as DurableApprovalRecord
    if (record.profileId !== profileId) return undefined
    return record
  }

  listOpen(profileId: string, runId?: string): DurableApprovalRecord[] {
    return this.listAll(profileId, runId).filter((record) => !record.consumedAt && !record.revokedAt)
  }

  listAll(profileId: string, runId?: string): DurableApprovalRecord[] {
    this.assertProfile(profileId)
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name))
      .map((name) => JSON.parse(readFileSync(join(this.root, name), 'utf8')) as DurableApprovalRecord)
      .filter((record) => record.profileId === profileId && (!runId || record.runId === runId))
  }

  decide(input: {
    approvalId: string
    profileId: string
    actorId: string
    approved: boolean
    now: string
    expectedDigest: string
    expectedRunId: string
  }): DurableApprovalRecord {
    return withFileLock(this.lockPath(input.approvalId), () => {
      const record = this.get(input.approvalId, input.profileId)
      if (!record) throw new Error(`Approval ${input.approvalId} not found`)
      if (record.runId !== input.expectedRunId) {
        throw new WorkflowConcurrencyError('Approval run mismatch')
      }
      if (record.consumedAt) {
        throw new WorkflowConcurrencyError(`Approval ${input.approvalId} already consumed`)
      }
      if (record.revokedAt) throw new Error(`Approval ${input.approvalId} was revoked`)
      const expiresAt = Date.parse(record.expiresAt)
      const decidedAt = Date.parse(input.now)
      if (!Number.isFinite(expiresAt) || !Number.isFinite(decidedAt) || expiresAt <= decidedAt) {
        throw new Error(`Approval ${input.approvalId} expired`)
      }
      if (input.expectedDigest !== record.requestDigest) {
        throw new WorkflowConcurrencyError('Approval request digest mismatch')
      }
      const next: DurableApprovalRecord = {
        ...record,
        consumedAt: input.now,
        decision: input.approved ? 'approved' : 'denied',
        decidedBy: input.actorId
      }
      this.write(next)
      return next
    })
  }

  revoke(approvalId: string, profileId: string, now: string): DurableApprovalRecord {
    return withFileLock(this.lockPath(approvalId), () => {
      const record = this.get(approvalId, profileId)
      if (!record) throw new Error(`Approval ${approvalId} not found`)
      if (record.consumedAt) throw new WorkflowConcurrencyError(`Approval ${approvalId} already consumed`)
      const next = { ...record, revokedAt: now }
      this.write(next)
      return next
    })
  }

  digest(parts: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  }

  private write(record: DurableApprovalRecord): void {
    atomicWriteFileSync(this.recordPath(record.approvalId), `${JSON.stringify(record, null, 2)}\n`)
  }

  private recordPath(approvalId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)) {
      throw new Error('Invalid approval id')
    }
    return join(this.root, `${approvalId}.json`)
  }

  private lockPath(approvalId: string): string {
    this.recordPath(approvalId)
    return join(this.root, `${approvalId}.lock`)
  }

  private assertProfile(profileId: string): void {
    if (profileId !== this.profileId) throw new Error('Approval profile mismatch')
  }
}
