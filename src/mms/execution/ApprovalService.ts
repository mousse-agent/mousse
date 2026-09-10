import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../data/AtomicFs'
import type { ExecutionActor } from '../../shared/execution/types'
import type { DurableApprovalRecord } from '../../shared/workflows'
import { WorkflowConcurrencyError } from '../../shared/workflows'

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

  constructor(options: { profileId: string; profileRoot: string }) {
    if (!options.profileId) throw new Error('ApprovalService requires profileId')
    if (!options.profileRoot) throw new Error('ApprovalService requires profileRoot')
    this.root = join(options.profileRoot, 'approvals')
    mkdirSync(this.root, { recursive: true })
  }

  create(input: CreateApprovalInput): DurableApprovalRecord {
    const record: DurableApprovalRecord = {
      approvalId: randomUUID(),
      ...input
    }
    this.write(record)
    return record
  }

  get(approvalId: string, profileId: string): DurableApprovalRecord | undefined {
    const path = join(this.root, `${approvalId}.json`)
    if (!existsSync(path)) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as DurableApprovalRecord
    if (record.profileId !== profileId) return undefined
    return record
  }

  listOpen(profileId: string, runId?: string): DurableApprovalRecord[] {
    return this.listAll(profileId, runId).filter((record) => !record.consumedAt && !record.revokedAt)
  }

  listAll(profileId: string, runId?: string): DurableApprovalRecord[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(this.root, name), 'utf8')) as DurableApprovalRecord)
      .filter((record) => record.profileId === profileId && (!runId || record.runId === runId))
  }

  decide(input: {
    approvalId: string
    profileId: string
    actorId: string
    approved: boolean
    now: string
    expectedDigest?: string
  }): DurableApprovalRecord {
    const record = this.get(input.approvalId, input.profileId)
    if (!record) throw new Error(`Approval ${input.approvalId} not found`)
    if (record.consumedAt) {
      throw new WorkflowConcurrencyError(`Approval ${input.approvalId} already consumed`)
    }
    if (record.revokedAt) throw new Error(`Approval ${input.approvalId} was revoked`)
    if (Date.parse(record.expiresAt) <= Date.parse(input.now)) {
      throw new Error(`Approval ${input.approvalId} expired`)
    }
    if (input.expectedDigest && input.expectedDigest !== record.requestDigest) {
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
  }

  revoke(approvalId: string, profileId: string, now: string): DurableApprovalRecord {
    const record = this.get(approvalId, profileId)
    if (!record) throw new Error(`Approval ${approvalId} not found`)
    if (record.consumedAt) throw new WorkflowConcurrencyError(`Approval ${approvalId} already consumed`)
    const next = { ...record, revokedAt: now }
    this.write(next)
    return next
  }

  digest(parts: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  }

  private write(record: DurableApprovalRecord): void {
    atomicWriteFileSync(join(this.root, `${record.approvalId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
}
