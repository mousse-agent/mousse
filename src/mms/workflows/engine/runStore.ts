import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../../data/AtomicFs'
import { PROCESS_INSTANCE_ID, isOwnerLive } from '../../queue/processLiveness'
import { withFileLock } from '../../scheduled/fileLock'
import type {
  WorkflowJournalEvent,
  WorkflowRunManifest,
  WorkflowRunState
} from '../../../shared/workflows'

export interface RunLease {
  pid: number
  processInstanceId: string
  token: string
  heartbeatAt: string
  runId: string
}

export interface RunCheckpoint {
  seq: number
  ready: string[]
  instances: Record<string, InstanceRecord>
  outputs: Record<string, unknown>
  result?: unknown
  pendingApprovalId?: string
  pendingInput?: { instanceKey: string; schema?: unknown; prompt: string }
  wakeAt?: string
  lastIntent?: { instanceKey: string; idempotencyKey: string; effect: string; prepared: boolean; completed: boolean }
}

export interface InstanceRecord {
  instanceKey: string
  nodeId: string
  type: string
  path: string
  status: 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting'
  attempt: number
  port?: string
  output?: unknown
  error?: string
  loop?: { item: unknown; index: number; previous?: unknown }
}

export class WorkflowRunStore {
  readonly profileId: string
  private readonly runsRoot: string

  constructor(options: { profileId: string; profileRoot: string }) {
    if (!options.profileId) throw new Error('WorkflowRunStore requires profileId')
    this.profileId = options.profileId
    this.runsRoot = join(options.profileRoot, 'workflow-runs')
    mkdirSync(this.runsRoot, { recursive: true })
  }

  runDir(runId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid run id')
    return join(this.runsRoot, runId)
  }

  create(manifest: WorkflowRunManifest, checkpoint: RunCheckpoint): { lease: RunLease } {
    const dir = this.runDir(manifest.runId)
    mkdirSync(dir)
    mkdirSync(join(dir, 'results'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'staging'), { recursive: true })
    atomicWriteFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    atomicWriteFileSync(join(dir, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`)
    atomicWriteFileSync(join(dir, 'journal.ndjson'), '')
    const lease = this.acquire(manifest.runId, manifest.updatedAt)
    return { lease }
  }

  acquire(runId: string, nowIso: string): RunLease {
    const path = join(this.runDir(runId), 'lease.json')
    return withFileLock(join(this.runDir(runId), 'lease.acquire.lock'), () => {
      if (existsSync(path)) {
        const existing = JSON.parse(readFileSync(path, 'utf8')) as RunLease
        if (isOwnerLive(existing, { staleHeartbeatMs: 30_000 })) {
          throw new Error(`Run ${runId} is leased by pid ${existing.pid}`)
        }
      }
      const lease: RunLease = {
        pid: process.pid,
        processInstanceId: PROCESS_INSTANCE_ID,
        token: randomUUID(),
        heartbeatAt: nowIso,
        runId
      }
      atomicWriteFileSync(path, `${JSON.stringify(lease, null, 2)}\n`)
      return lease
    })
  }

  assertLease(runId: string, token: string): void {
    const path = join(this.runDir(runId), 'lease.json')
    const lease = JSON.parse(readFileSync(path, 'utf8')) as RunLease
    if (lease.token !== token || lease.processInstanceId !== PROCESS_INSTANCE_ID) {
      throw new Error(`Stale lease for run ${runId}`)
    }
  }

  heartbeat(runId: string, token: string, nowIso: string): void {
    this.assertLease(runId, token)
    const path = join(this.runDir(runId), 'lease.json')
    const lease = JSON.parse(readFileSync(path, 'utf8')) as RunLease
    lease.heartbeatAt = nowIso
    atomicWriteFileSync(path, `${JSON.stringify(lease, null, 2)}\n`)
  }

  release(runId: string, token: string): void {
    withFileLock(join(this.runDir(runId), 'lease.acquire.lock'), () => {
      const path = join(this.runDir(runId), 'lease.json')
      if (!existsSync(path)) return
      const lease = JSON.parse(readFileSync(path, 'utf8')) as RunLease
      if (lease.token === token && lease.processInstanceId === PROCESS_INSTANCE_ID) unlinkSync(path)
    })
  }

  readManifest(runId: string): WorkflowRunManifest {
    return JSON.parse(readFileSync(join(this.runDir(runId), 'manifest.json'), 'utf8')) as WorkflowRunManifest
  }

  writeManifest(manifest: WorkflowRunManifest, token: string): void {
    this.assertLease(manifest.runId, token)
    atomicWriteFileSync(join(this.runDir(manifest.runId), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  readCheckpoint(runId: string): RunCheckpoint {
    return JSON.parse(readFileSync(join(this.runDir(runId), 'checkpoint.json'), 'utf8')) as RunCheckpoint
  }

  writeCheckpoint(runId: string, checkpoint: RunCheckpoint, token: string): void {
    this.assertLease(runId, token)
    atomicWriteFileSync(join(this.runDir(runId), 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`)
  }

  append(runId: string, event: WorkflowJournalEvent, token: string): void {
    this.assertLease(runId, token)
    const path = join(this.runDir(runId), 'journal.ndjson')
    const line = `${JSON.stringify(event)}\n`
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, line)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  readJournal(runId: string): WorkflowJournalEvent[] {
    const path = join(this.runDir(runId), 'journal.ndjson')
    if (!existsSync(path)) return []
    const source = readFileSync(path, 'utf8')
    const lines = source.split('\n')
    const events: WorkflowJournalEvent[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        events.push(JSON.parse(line) as WorkflowJournalEvent)
      } catch (error) {
        if (index === lines.length - 1 && !source.endsWith('\n')) break
        throw error
      }
    }
    return events
  }

  writeResult(runId: string, instanceKey: string, value: unknown, token: string): void {
    this.assertLease(runId, token)
    const safe = instanceKey.replace(/[^a-zA-Z0-9._#-]/g, '_')
    atomicWriteFileSync(
      join(this.runDir(runId), 'results', `${safe}.json`),
      `${JSON.stringify(value)}\n`
    )
  }

  listRunIds(): string[] {
    if (!existsSync(this.runsRoot)) return []
    return readdirSync(this.runsRoot).filter(
      (name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name) &&
        existsSync(join(this.runsRoot, name, 'manifest.json'))
    )
  }

  setState(manifest: WorkflowRunManifest, state: WorkflowRunState, nowIso: string, error?: string): WorkflowRunManifest {
    manifest.state = state
    manifest.updatedAt = nowIso
    if (error) manifest.terminalError = error
    return manifest
  }
}
