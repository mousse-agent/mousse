import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJsonSync, fsyncDirectorySync } from '../data/AtomicFs'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { pathsEqual } from '../profiles/pathSafety'
import type { LifecycleOperation, LifecycleOperationKind, LifecycleOperationPhase, ResourceInventorySnapshot, TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { ResourceLifecycleError, ResourceLifecycleStore, validateResourceInventory } from './ResourceLifecycleStore'
import { buildResourceInventory } from './ResourceInventory'
import { ResourcePurgeService } from './ResourcePurgeService'

export interface LifecycleRequest { taskId: string; operationId: string; expectedGeneration?: number }
export interface ResourceLifecycleHooks {
  /** Atomic with installing the fence. Reject active work before affecting its writes. */
  assertCanTrash?(record: TaskLifecycleRecord): void
  /** No stable/task/repository lock is held across this await. Never replay model/tool work. */
  drain(record: TaskLifecycleRecord): Promise<void>
  inventory?(record: TaskLifecycleRecord): Promise<ResourceInventorySnapshot> | ResourceInventorySnapshot
  /** Acquire/prove execution+data+queue quiescence, then RELEASE every movable lock before returning. */
  settleMutationOwnership(record: TaskLifecycleRecord): Promise<void>
  /** Idempotent index/cache projection. Durable location authority is already updated. */
  projectIndex(record: TaskLifecycleRecord): Promise<void> | void
  projectPurged?(record: TaskLifecycleRecord): Promise<void> | void
  configurationChanged?(): void
  /** Fault injection / observability after durable boundaries, never used to authorize a move. */
  onPhase?(record: TaskLifecycleRecord, phase: LifecycleOperationPhase): Promise<void> | void
}

const running = new Set<string>()
const LOCATION_MARKER = '.lifecycle-location.json'
const MOVABLE_LOCKS = ['execution.lease', 'queue.mut.lock', 'thread-data.mut.lock']

/** Phase 1 only: reversible metadata moves. No resource deletion, ref updates or Git maintenance. */
export class ResourceLifecycleCoordinator {
  readonly cleanup: ResourcePurgeService
  constructor(readonly store: ResourceLifecycleStore, private readonly hooks: ResourceLifecycleHooks) {
    this.cleanup = new ResourcePurgeService(store, { assertIdle: (taskId) => hooks.assertCanTrash?.(store.require(taskId)), projectPurged: (record) => hooks.projectPurged?.(record), onBoundary: (record) => hooks.onPhase?.(record, 'purge-started'), configurationChanged: hooks.configurationChanged })
  }

  trash(request: LifecycleRequest): Promise<TaskLifecycleRecord> { return this.run('trash', request) }
  restore(request: LifecycleRequest): Promise<TaskLifecycleRecord> { return this.run('restore', request) }
  purge(input: Parameters<ResourcePurgeService['purge']>[0] | string): Promise<TaskLifecycleRecord> {
    if (typeof input === 'string') throw new ResourceLifecycleError('unsupported', 'Permanent purge is unavailable without an exact reviewed inventory')
    return this.cleanup.purge(input)
  }
  getOperationResult(taskId: string, operationId: string) {
    return this.store.require(taskId).operations.find((operation) => operation.id === operationId)?.result
  }

  async recover(taskId: string): Promise<TaskLifecycleRecord> {
    const record = this.store.require(taskId)
    if (record.state === 'purge-started' && record.purge) return this.purge({ taskId, operationId: record.purge.operationId })
    const operation = record.operations.at(-1)
    if (!operation || ['completed', 'rejected'].includes(operation.phase)) return record
    return this.run(operation.kind, { taskId, operationId: operation.id, expectedGeneration: operation.expectedGeneration })
  }
  async recoverAll(): Promise<Array<{ taskId: string; record?: TaskLifecycleRecord; error?: string }>> {
    const results: Array<{ taskId: string; record?: TaskLifecycleRecord; error?: string }> = []
    for (const record of this.store.list()) {
      try { results.push({ taskId: record.taskId, record: await this.recover(record.taskId) }) }
      catch (error) { results.push({ taskId: record.taskId, error: (error as Error).message }) }
    }
    return results
  }

  private async run(kind: LifecycleOperationKind, request: LifecycleRequest): Promise<TaskLifecycleRecord> {
    if (!request.operationId || request.operationId.length > 256 || /[\x00-\x1f]/.test(request.operationId)) throw new ResourceLifecycleError('ambiguous', 'Invalid lifecycle operation identity')
    const token = randomUUID()
    let claimed = false
    let terminalReplay = false
    this.store.update(request.taskId, (record) => {
      const old = record.operations.find((item) => item.id === request.operationId)
      if (old) {
        if (old.kind !== kind || (request.expectedGeneration !== undefined && request.expectedGeneration !== old.expectedGeneration)) throw new ResourceLifecycleError('stale', 'Lifecycle operation identity was reused with different input')
        if (old.phase === 'rejected') throw new ResourceLifecycleError('unavailable', 'Lifecycle operation was rejected; submit a new operation')
        if (old.phase === 'completed') { terminalReplay = true; return }
        if (old !== record.operations.at(-1)) throw new ResourceLifecycleError('stale', 'Lifecycle operation is no longer current')
        if (old.runner && (running.has(old.runner.token) || isOwnerLive(old.runner))) throw new ResourceLifecycleError('busy', 'Lifecycle operation is already running')
      } else {
        if (record.cleanupOwner && isOwnerLive(record.cleanupOwner)) throw new ResourceLifecycleError('busy', 'Task storage cleanup is running')
        if (request.expectedGeneration !== undefined && request.expectedGeneration !== record.generation) throw new ResourceLifecycleError('stale', 'Task lifecycle generation changed')
        if (record.state !== (kind === 'trash' ? 'active' : 'trashed')) throw new ResourceLifecycleError('unavailable', `Cannot ${kind} a ${record.state} task`)
        if (kind === 'trash') this.hooks.assertCanTrash?.(record)
        const to = kind === 'trash'
          ? join(this.store.profileHome, 'trash', 'threads', `${record.taskId}-${createHash('sha256').update(request.operationId).digest('hex').slice(0, 20)}`)
          : record.originalLocation
        record.operations.push({ id: request.operationId, kind, expectedGeneration: record.generation, phase: 'fenced', from: record.location, to, startedAt: new Date().toISOString() })
        if (!record.locations.some((path) => pathsEqual(path, to))) record.locations.push(to)
        record.state = kind === 'trash' ? 'draining' : 'restore-moving'
      }
      const operation = record.operations.at(-1)!
      operation.runner = { pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token }
      delete operation.error
      delete record.blockedReason
      claimed = true
    })
    if (terminalReplay) return this.store.require(request.taskId)
    running.add(token)
    try {
      let record = this.store.require(request.taskId)
      let operation = record.operations.at(-1)!
      if (operation.phase === 'fenced') {
        await this.hooks.onPhase?.(record, 'fenced')
        try {
          if (kind === 'trash') await this.store.withDrainWrites(request.taskId, request.operationId, () => this.hooks.drain(record))
          const inventory = await (this.hooks.inventory?.(record) ?? buildResourceInventory(this.store, record))
          validateResourceInventory(inventory)
          if (inventory.profileId !== record.profileId || inventory.taskId !== record.taskId || inventory.generation !== record.generation) throw new ResourceLifecycleError('stale', 'Inventory has a different lifecycle owner or generation')
          if (inventory.blockers.length || inventory.sources.some((source) => source.status !== 'verified')) throw new ResourceLifecycleError('ambiguous', `Resource ownership is not established: ${inventory.blockers.join('; ') || 'unknown source'}`)
          record = this.advance(request.taskId, token, 'drained', (current) => { current.operations.at(-1)!.inventory = inventory })
        } catch (error) {
          // No move has been attempted: rejecting a busy operation must not strand an admitted writer.
          this.store.update(request.taskId, (current) => {
            this.assertRunner(current, token)
            const active = current.operations.at(-1)!
            active.phase = 'rejected'; active.error = (error as Error).message; active.completedAt = new Date().toISOString()
            current.state = kind === 'trash' ? 'active' : 'trashed'
          })
          throw error
        }
        await this.hooks.onPhase?.(record, 'drained')
        operation = record.operations.at(-1)!
      }
      if (operation.phase === 'drained' || operation.phase === 'move-prepared') {
        if (existsSync(operation.from)) await this.store.withMutationSettlement(request.taskId, request.operationId, () => this.hooks.settleMutationOwnership(this.store.require(request.taskId)))
        if (operation.phase === 'drained') {
          record = this.store.update(request.taskId, (current) => {
            this.assertRunner(current, token)
            const active = current.operations.at(-1)!
            this.verifyMoveSource(current, active)
            this.assertNoMovableLocks(active.from)
            this.store.withMutationSettlement(request.taskId, request.operationId, () => atomicWriteJsonSync(join(active.from, LOCATION_MARKER), this.marker(current, active)))
            active.phase = 'move-prepared'
            current.state = kind === 'trash' ? 'trash-moving' : 'restore-moving'
          })
          await this.hooks.onPhase?.(record, 'move-prepared')
        }
        record = this.store.update(request.taskId, (current) => {
          this.assertRunner(current, token)
          const active = current.operations.at(-1)!
          const source = existsSync(active.from), target = existsSync(active.to)
          if (source === target) throw new ResourceLifecycleError('ambiguous', 'Lifecycle move has both or neither source and destination')
          const actual = source ? active.from : active.to
          this.store.assertTaskIdentity(actual, current.taskId)
          this.assertMarker(current, active, actual)
          this.assertNoMovableLocks(actual)
          if (source) {
            this.store.assertTaskLocation(active.to)
            mkdirSync(dirname(active.to), { recursive: true })
            renameSync(active.from, active.to)
            fsyncDirectorySync(dirname(active.from)); fsyncDirectorySync(dirname(active.to))
          }
          // This update can be recovered from the exact marker if the process exits after rename.
          current.location = active.to
          current.generation = active.expectedGeneration + 1
          active.phase = 'moved'
        })
        await this.hooks.onPhase?.(record, 'moved')
        operation = record.operations.at(-1)!
      }
      if (operation.phase === 'moved') {
        // Projection must not expose execution: admission remains fenced until completion.
        await this.store.withProjectionWrites(request.taskId, request.operationId, () => this.hooks.projectIndex(record))
        record = this.advance(request.taskId, token, 'indexed')
        await this.hooks.onPhase?.(record, 'indexed')
        operation = record.operations.at(-1)!
      }
      if (operation.phase === 'indexed') {
        record = this.advance(request.taskId, token, 'completed', (current) => {
          current.state = kind === 'trash' ? 'trashed' : 'active'
          current.operations.at(-1)!.completedAt = new Date().toISOString()
          if (kind === 'trash') current.trashedAt = current.operations.at(-1)!.completedAt
          const operation = current.operations.at(-1)!
          operation.result = { operationId: operation.id, kind: operation.kind, generation: current.generation, location: current.location, state: kind === 'trash' ? 'trashed' : 'active', completedAt: operation.completedAt! }
        })
        await this.hooks.onPhase?.(record, 'completed')
      }
      return record
    } catch (error) {
      if (claimed) this.store.update(request.taskId, (record) => {
        this.assertRunner(record, token)
        const operation = record.operations.at(-1)!
        if (!['completed', 'rejected'].includes(operation.phase)) { operation.error = (error as Error).message; record.blockedReason = operation.error }
      })
      throw error
    } finally {
      running.delete(token)
      if (claimed) this.store.update(request.taskId, (record) => {
        if (record.operations.at(-1)?.runner?.token === token) delete record.operations.at(-1)!.runner
      })
    }
  }

  private advance(taskId: string, token: string, phase: LifecycleOperationPhase, fn?: (record: TaskLifecycleRecord) => void): TaskLifecycleRecord {
    return this.store.update(taskId, (record) => { this.assertRunner(record, token); record.operations.at(-1)!.phase = phase; fn?.(record) })
  }
  private assertRunner(record: TaskLifecycleRecord, token: string): void {
    if (record.operations.at(-1)?.runner?.token !== token) throw new ResourceLifecycleError('stale', 'Lifecycle operation ownership changed')
  }
  private verifyMoveSource(record: TaskLifecycleRecord, operation: LifecycleOperation): void {
    if (!pathsEqual(record.location, operation.from) || !existsSync(operation.from) || existsSync(operation.to)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle source or destination changed')
    this.store.assertTaskIdentity(operation.from, record.taskId)
  }
  private marker(record: TaskLifecycleRecord, operation: LifecycleOperation) {
    return { schemaVersion: 1, profileId: record.profileId, taskId: record.taskId, operationId: operation.id, generation: operation.expectedGeneration, from: operation.from, to: operation.to }
  }
  private assertMarker(record: TaskLifecycleRecord, operation: LifecycleOperation, location: string): void {
    this.store.assertTaskLocation(join(location, LOCATION_MARKER))
    const actual = JSON.parse(readFileSync(join(location, LOCATION_MARKER), 'utf8')) as unknown
    if (JSON.stringify(actual) !== JSON.stringify(this.marker(record, operation))) throw new ResourceLifecycleError('ambiguous', 'Lifecycle move marker does not match the durable intent')
  }
  private assertNoMovableLocks(location: string): void {
    if (MOVABLE_LOCKS.some((name) => existsSync(join(location, name)))) throw new ResourceLifecycleError('busy', 'Task execution/data/queue ownership is not settled')
  }
}
