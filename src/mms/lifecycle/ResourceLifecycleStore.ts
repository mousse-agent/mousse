import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { canonicalizeAbsolutePath, pathsEqual } from '../profiles/pathSafety'
import { RESOURCE_LIFECYCLE_VERSION, RETENTION_CLAIM_KINDS, type LifecycleAdmission, type ResourceInventorySnapshot, type TaskLifecycleRecord } from '../../shared/resourceLifecycle'

export class ResourceLifecycleError extends Error {
  constructor(readonly code: 'busy' | 'stale' | 'unavailable' | 'ambiguous' | 'unsupported', message: string) {
    super(message); this.name = 'ResourceLifecycleError'
  }
}
export interface ResourceLifecycleStoreOptions {
  profileId: string
  profileHome: string
  allowedTaskRoots?: string[]
}

const gateDepth = new Map<string, number>()
const drainScope = new AsyncLocalStorage<{ root: string; taskId: string; operationId: string; settlement?: boolean; projection?: boolean }>()
const identity = (value: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw new ResourceLifecycleError('ambiguous', 'Invalid lifecycle identity')
  return value
}
function contains(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}
/** No lifecycle authority or movable directory may be accessed through a link. */
export function assertLifecyclePath(root: string, path: string): void {
  if (!isAbsolute(path) || path.includes('\0') || !contains(root, path)) throw new ResourceLifecycleError('ambiguous', `Lifecycle path escapes its owned root: ${path}`)
  let current = resolve(path)
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new ResourceLifecycleError('ambiguous', `Lifecycle path is a link: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (pathsEqual(current, root)) break
    const parent = dirname(current)
    if (parent === current) throw new ResourceLifecycleError('ambiguous', 'Lifecycle root is not an ancestor')
    current = parent
  }
}

/** Inventory is a projection of source records, never deletion authority. Unknown schemas fail closed. */
export function validateResourceInventory(value: ResourceInventorySnapshot): void {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.sources) || !Array.isArray(value.resources) || !Array.isArray(value.blockers)) throw new ResourceLifecycleError('unsupported', 'Unsupported resource inventory schema')
  const sources = new Map(value.sources.map((source) => [source.id, source]))
  if (sources.size !== value.sources.length) throw new ResourceLifecycleError('ambiguous', 'Duplicate resource source identities')
  for (const source of value.sources) {
    if (!source.id || !source.path || !source.digest || !['verified', 'unknown'].includes(source.status)) throw new ResourceLifecycleError('ambiguous', 'Invalid resource source')
  }
  const resources = new Set<string>()
  for (const resource of value.resources) {
    if (!resource.id || resources.has(resource.id) || !resource.identity || !resource.ownerTaskId || !Array.isArray(resource.sourceIds) || !Array.isArray(resource.claims)) throw new ResourceLifecycleError('ambiguous', 'Invalid resource identity')
    resources.add(resource.id)
    for (const source of resource.sourceIds) if (!sources.has(source)) throw new ResourceLifecycleError('ambiguous', 'Resource source is missing')
    for (const claim of resource.claims) {
      if (claim.schemaVersion !== 1 || !(RETENTION_CLAIM_KINDS as readonly string[]).includes(claim.kind)) throw new ResourceLifecycleError('unsupported', 'Unknown retention claim version or kind')
      if (!sources.has(claim.sourceId) || !claim.ownerTaskId || !claim.condition) throw new ResourceLifecycleError('ambiguous', 'Retention claim lacks source authority')
    }
  }
}

/** Stable profile/task authority. No execution, data or queue lock lives in this directory. */
export class ResourceLifecycleStore {
  readonly profileId: string
  readonly profileHome: string
  readonly root: string
  readonly allowedTaskRoots: string[]

  constructor(options: ResourceLifecycleStoreOptions) {
    this.profileId = identity(options.profileId)
    this.profileHome = canonicalizeAbsolutePath(options.profileHome)
    this.root = join(this.profileHome, 'lifecycle')
    this.allowedTaskRoots = (options.allowedTaskRoots ?? [join(this.profileHome, 'thread-data')]).map((path) => canonicalizeAbsolutePath(path))
    this.assertCompatible()
  }

  assertCompatible(): void {
    assertLifecyclePath(this.profileHome, this.root)
    const path = join(this.root, 'manifest.json')
    if (!existsSync(path)) {
      if (existsSync(join(this.root, 'tasks')) && readdirSync(join(this.root, 'tasks')).length) throw new ResourceLifecycleError('ambiguous', 'Lifecycle manifest missing for existing records')
      return
    }
    assertLifecyclePath(this.root, path)
    const manifest = this.readJson(path) as { schemaVersion?: number; minimumWriterVersion?: number; profileId?: string }
    if (manifest.schemaVersion !== RESOURCE_LIFECYCLE_VERSION || manifest.minimumWriterVersion !== 1 || manifest.profileId !== this.profileId) throw new ResourceLifecycleError('unsupported', 'Lifecycle storage requires a compatible writer and matching profile')
  }

  private initialize(): void {
    this.assertCompatible()
    if (!existsSync(join(this.root, 'manifest.json'))) atomicWriteJsonSync(join(this.root, 'manifest.json'), { schemaVersion: 1, minimumWriterVersion: 1, profileId: this.profileId })
  }

  recordPath(taskId: string): string { return join(this.root, 'tasks', `${identity(taskId)}.json`) }
  get(taskId: string): TaskLifecycleRecord | undefined {
    this.assertCompatible()
    const path = this.recordPath(taskId)
    assertLifecyclePath(this.root, path)
    if (!existsSync(path)) return undefined
    const value = this.readJson(path) as TaskLifecycleRecord
    this.validateRecord(value, taskId)
    return value
  }
  list(): TaskLifecycleRecord[] {
    this.assertCompatible()
    const path = join(this.root, 'tasks')
    assertLifecyclePath(this.root, path)
    if (!existsSync(path)) return []
    return readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => this.get(name.slice(0, -5))!)
  }
  findByLocation(path: string): TaskLifecycleRecord | undefined {
    // Include every historical path; missing former directories must never become unmanaged.
    if (contains(this.root, path)) return undefined
    this.assertCompatible()
    // The index only routes to the authoritative record. Hot writes never scan all retained tasks.
    const indexRoot = join(this.root, 'locations')
    if (!existsSync(indexRoot) && existsSync(join(this.root, 'tasks'))) {
      this.withGate('_registry', () => { for (const record of this.list()) this.writeLocationIndexes(record) })
    }
    let candidate = resolve(path)
    while (this.allowedTaskRoots.some((root) => contains(root, candidate)) || contains(join(this.profileHome, 'trash', 'threads'), candidate)) {
      const indexPath = this.locationIndexPath(candidate)
      assertLifecyclePath(this.root, indexPath)
      if (existsSync(indexPath)) {
        const index = this.readJson(indexPath) as { schemaVersion?: number; profileId?: string; taskId?: string; location?: string }
        if (index.schemaVersion !== 1 || index.profileId !== this.profileId || !index.taskId || !index.location || !pathsEqual(index.location, candidate)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle location index is invalid')
        const record = this.require(index.taskId)
        if (!record.locations.some((location) => pathsEqual(location, candidate))) throw new ResourceLifecycleError('ambiguous', 'Lifecycle source does not authorize indexed location')
        return record
      }
      const parent = dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
    return undefined
  }

  registerTask(input: { taskId: string; location: string; parentTaskId?: string; creating?: boolean }): TaskLifecycleRecord {
    identity(input.taskId)
    if (input.parentTaskId) identity(input.parentTaskId)
    const location = resolve(input.location)
    this.assertTaskLocation(location)
    return this.withGate('_registry', () => {
      this.initialize()
      return this.withGate(input.taskId, () => {
        const existing = this.get(input.taskId)
        if (existing) {
          if (existing.state !== 'active' || !pathsEqual(existing.location, location) || existing.parentTaskId !== input.parentTaskId) throw new ResourceLifecycleError('stale', 'Task identity already has a lifecycle location or tombstone')
          return existing
        }
        if (this.findByLocation(location)) throw new ResourceLifecycleError('ambiguous', 'Task location is already owned')
        if (input.parentTaskId) {
          const parent = this.get(input.parentTaskId)
          if (!parent || parent.state !== 'active' || input.parentTaskId === input.taskId) throw new ResourceLifecycleError('unavailable', 'Invocation parent is unavailable')
        }
        if (!input.creating || existsSync(location)) this.assertTaskIdentity(location, input.taskId)
        const now = new Date().toISOString()
        const record: TaskLifecycleRecord = { schemaVersion: 1, minimumWriterVersion: 1, profileId: this.profileId, taskId: input.taskId, generation: 1, state: 'active', originalLocation: location, location, locations: [location], operations: [], createdAt: now, updatedAt: now, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}) }
        this.writeLocationIndexes(record)
        atomicWriteJsonSync(this.recordPath(input.taskId), record)
        return record
      })
    })
  }

  /** Conservative import of an existing legacy trash-index entry; never moves or deletes data. */
  adoptTrashedTask(input: { taskId: string; originalLocation: string; location: string }): TaskLifecycleRecord {
    identity(input.taskId)
    this.assertTaskLocation(input.originalLocation); this.assertTaskLocation(input.location)
    const trashRoot = join(this.profileHome, 'trash', 'threads')
    if (!contains(trashRoot, input.location) || pathsEqual(trashRoot, input.location)) throw new ResourceLifecycleError('ambiguous', 'Legacy trash is outside its owned container')
    return this.withGate('_registry', () => {
      this.initialize()
      return this.withGate(input.taskId, () => {
        const existing = this.get(input.taskId)
        if (existing) {
          if (existing.state !== 'trashed' || !pathsEqual(existing.originalLocation, input.originalLocation) || !pathsEqual(existing.location, input.location)) throw new ResourceLifecycleError('ambiguous', 'Legacy trash conflicts with lifecycle authority')
          return existing
        }
        const indexPath = join(trashRoot, 'index.json')
        assertLifecyclePath(trashRoot, indexPath)
        const index = this.readJson(indexPath)
        if (!Array.isArray(index)) throw new ResourceLifecycleError('ambiguous', 'Legacy trash index is not a collection')
        const matches = index.filter((entry) => entry?.threadId === input.taskId && !entry.restoredAt && !entry.purgedAt)
        const entry = matches[0]
        if (matches.length !== 1 || typeof entry.originalPath !== 'string' || typeof entry.trashPath !== 'string' || !pathsEqual(entry.originalPath, input.originalLocation) || !pathsEqual(entry.trashPath, input.location)) throw new ResourceLifecycleError('ambiguous', 'Legacy trash has no unique source ownership')
        if (existsSync(input.originalLocation) || this.findByLocation(input.originalLocation) || this.findByLocation(input.location)) throw new ResourceLifecycleError('ambiguous', 'Legacy trash original location is occupied or owned')
        this.assertTaskIdentity(input.location, input.taskId)
        const now = new Date().toISOString()
        const record: TaskLifecycleRecord = { schemaVersion: 1, minimumWriterVersion: 1, profileId: this.profileId, taskId: input.taskId, generation: 1, state: 'trashed', originalLocation: resolve(input.originalLocation), location: resolve(input.location), locations: [resolve(input.originalLocation), resolve(input.location)], operations: [], createdAt: now, updatedAt: now }
        this.writeLocationIndexes(record)
        atomicWriteJsonSync(this.recordPath(input.taskId), record)
        return record
      })
    })
  }

  captureAdmission(taskId: string, expectedLocation?: string): LifecycleAdmission {
    return this.withAdmissionGates(taskId, () => {
      const record = this.require(taskId)
      this.checkAvailable(record, 'execution')
      if (expectedLocation && !pathsEqual(record.location, expectedLocation)) throw new ResourceLifecycleError('stale', 'Task location changed')
      return this.admission(record)
    })
  }
  assertAdmission(admission: LifecycleAdmission): void { this.withAdmission(admission, 'execution', () => undefined) }
  withAdmission<T>(admission: LifecycleAdmission, kind: 'execution' | 'write', fn: () => T): T {
    return this.withAdmissionGates(admission.taskId, () => {
      const record = this.require(admission.taskId)
      if (admission.profileId !== this.profileId || record.generation !== admission.generation || !pathsEqual(record.location, admission.location)) throw new ResourceLifecycleError('stale', 'Task lifecycle generation or location changed')
      if (JSON.stringify(admission.ancestors ?? []) !== JSON.stringify(this.ancestorRecords(record).map((item) => ({ taskId: item.taskId, generation: item.generation })))) throw new ResourceLifecycleError('stale', 'Parent task lifecycle generation changed')
      this.checkAvailable(record, kind)
      this.assertTaskLocation(record.location)
      return fn()
    })
  }
  withPathAdmission<T>(path: string, kind: 'execution' | 'write', fn: () => T): T {
    if (contains(this.root, path)) return fn()
    const record = this.findByLocation(path)
    if (!record) {
      if (this.allowedTaskRoots.some((root) => contains(root, path)) || contains(join(this.profileHome, 'trash'), path)) throw new ResourceLifecycleError('unavailable', 'Task must be registered before accessing managed storage')
      return fn()
    }
    if (!contains(record.location, path)) throw new ResourceLifecycleError('stale', 'Task path is no longer current')
    return this.withAdmission(this.admission(record), kind, fn)
  }

  /** Internal completion scope only; no serializable permit is issued to protocol callers. */
  withDrainWrites<T>(taskId: string, operationId: string, fn: () => T): T {
    const record = this.require(taskId)
    const operation = record.operations.at(-1)
    if (record.state !== 'draining' || operation?.id !== operationId || operation.phase !== 'fenced') throw new ResourceLifecycleError('stale', 'Drain operation is no longer current')
    return drainScope.run({ root: this.root, taskId, operationId }, fn)
  }

  /** Only the coordinator's quiescence hook may momentarily acquire movable locks while fenced. */
  withMutationSettlement<T>(taskId: string, operationId: string, fn: () => T): T {
    const record = this.require(taskId)
    const operation = record.operations.at(-1)
    if (operation?.id !== operationId || !['fenced', 'drained', 'move-prepared'].includes(operation.phase)) throw new ResourceLifecycleError('stale', 'Settlement operation is no longer current')
    return drainScope.run({ root: this.root, taskId, operationId, settlement: true }, fn)
  }

  /** Idempotent post-move persistence (for idle restore), while ordinary admission remains fenced. */
  withProjectionWrites<T>(taskId: string, operationId: string, fn: () => T): T {
    const record = this.require(taskId)
    const operation = record.operations.at(-1)
    if (operation?.id !== operationId || !['moved', 'indexed'].includes(operation.phase)) throw new ResourceLifecycleError('stale', 'Projection operation is no longer current')
    return drainScope.run({ root: this.root, taskId, operationId, projection: true }, fn)
  }

  /** Coordinator-only durable compare/update under the same gate as all admissions. */
  update(taskId: string, fn: (record: TaskLifecycleRecord) => void): TaskLifecycleRecord {
    return this.withGate(taskId, () => {
      const record = this.require(taskId)
      const before = JSON.stringify(record)
      fn(record)
      if (before === JSON.stringify(record)) return record
      record.updatedAt = new Date().toISOString()
      this.validateRecord(record, taskId)
      this.writeLocationIndexes(record)
      atomicWriteJsonSync(this.recordPath(taskId), record)
      return record
    })
  }
  require(taskId: string): TaskLifecycleRecord {
    const record = this.get(taskId)
    if (!record) throw new ResourceLifecycleError('unavailable', `Task has no lifecycle owner: ${taskId}`)
    return record
  }
  assertTaskIdentity(location: string, taskId: string): void {
    this.assertTaskLocation(location)
    const metaPath = join(location, 'meta.json')
    assertLifecyclePath(location, metaPath)
    const meta = this.readJson(metaPath) as { id?: string }
    if (meta.id !== taskId) throw new ResourceLifecycleError('ambiguous', 'Task metadata identity does not match lifecycle owner')
  }
  assertTaskLocation(path: string): void {
    const roots = [...this.allowedTaskRoots, join(this.profileHome, 'trash', 'threads')]
    const root = roots.find((candidate) => contains(candidate, path) && !pathsEqual(candidate, path))
    if (!root) throw new ResourceLifecycleError('ambiguous', `Task location is outside registered roots: ${path}`)
    assertLifecyclePath(root, path)
  }

  /** Short, cross-process, reentrant only for synchronous callbacks. Never held while draining. */
  withGate<T>(taskId: string, fn: () => T): T {
    const path = join(this.root, 'gates', identity(taskId), 'gate.lock')
    assertLifecyclePath(this.profileHome, path)
    const depth = gateDepth.get(path) ?? 0
    if (depth) {
      gateDepth.set(path, depth + 1)
      try { return fn() } finally { gateDepth.set(path, depth) }
    }
    mkdirSync(dirname(path), { recursive: true })
    const owner = { pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token: randomUUID() }
    let fd: number
    try { fd = openSync(path, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let old: typeof owner
      try { old = this.readJson(path) as typeof owner } catch { throw new ResourceLifecycleError('busy', 'Lifecycle gate is being published or requires recovery') }
      // Unknown/corrupt owners and every live PID remain protected, without clock-based stealing.
      if (!Number.isInteger(old.pid) || !old.token || !old.processInstanceId || isOwnerLive(old)) throw new ResourceLifecycleError('busy', 'Task lifecycle gate is busy')
      const still = this.readJson(path) as typeof owner
      if (still.token !== old.token) throw new ResourceLifecycleError('busy', 'Task lifecycle gate changed')
      unlinkSync(path)
      try { fd = openSync(path, 'wx') } catch { throw new ResourceLifecycleError('busy', 'Task lifecycle gate is busy') }
    }
    try {
      writeFileSync(fd, JSON.stringify(owner))
      gateDepth.set(path, 1)
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new ResourceLifecycleError('unsupported', 'Lifecycle gate callbacks must be synchronous')
      return result
    } finally {
      gateDepth.delete(path)
      closeSync(fd)
      try { if ((this.readJson(path) as typeof owner).token === owner.token) unlinkSync(path) } catch { /* leave ambiguous gate protected */ }
    }
  }

  private admission(record: TaskLifecycleRecord): LifecycleAdmission { return { profileId: this.profileId, taskId: record.taskId, generation: record.generation, location: record.location, ancestors: this.ancestorRecords(record).map((item) => ({ taskId: item.taskId, generation: item.generation })) } }
  private ancestorRecords(record: TaskLifecycleRecord): TaskLifecycleRecord[] {
    const records: TaskLifecycleRecord[] = [], seen = new Set([record.taskId])
    let parentId = record.parentTaskId
    while (parentId) {
      if (seen.has(parentId)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle ownership graph contains a cycle')
      seen.add(parentId)
      const parent = this.require(parentId)
      records.push(parent); parentId = parent.parentTaskId
    }
    return records.reverse()
  }
  private withAdmissionGates<T>(taskId: string, fn: () => T): T {
    const record = this.require(taskId)
    const ids = [...this.ancestorRecords(record).map((item) => item.taskId), taskId]
    const acquire = (index: number): T => index === ids.length ? fn() : this.withGate(ids[index]!, () => acquire(index + 1))
    return acquire(0)
  }
  private checkAvailable(record: TaskLifecycleRecord, kind: 'execution' | 'write', seen = new Set<string>()): void {
    if (seen.has(record.taskId)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle ownership graph contains a cycle')
    seen.add(record.taskId)
    if (record.state === 'active') {
      if (record.parentTaskId) this.checkAvailable(this.require(record.parentTaskId), kind, seen)
      return
    }
    const scope = drainScope.getStore()
    if (kind === 'write' && scope?.projection && scope.root === this.root && scope.taskId === record.taskId && scope.operationId === record.operations.at(-1)?.id && ['moved', 'indexed'].includes(record.operations.at(-1)!.phase)) return
    if (scope?.settlement && scope.root === this.root && scope.taskId === record.taskId && scope.operationId === record.operations.at(-1)?.id && ['fenced', 'drained', 'move-prepared'].includes(record.operations.at(-1)!.phase)) return
    if (kind === 'write' && record.state === 'draining' && scope?.root === this.root && scope.taskId === record.taskId && scope.operationId === record.operations.at(-1)?.id && record.operations.at(-1)?.phase === 'fenced') return
    throw new ResourceLifecycleError('unavailable', `Task is ${record.state}; admission is fenced`)
  }
  private validateRecord(record: TaskLifecycleRecord, taskId: string): void {
    if (record?.schemaVersion !== 1 || record.minimumWriterVersion !== 1) throw new ResourceLifecycleError('unsupported', 'Unknown task lifecycle schema or writer version')
    if (record.profileId !== this.profileId || record.taskId !== taskId || !Number.isSafeInteger(record.generation) || record.generation < 1 || !Array.isArray(record.locations) || !Array.isArray(record.operations) || !['active', 'draining', 'trash-moving', 'trashed', 'restore-moving', 'blocked', 'purge-started', 'purged'].includes(record.state)) throw new ResourceLifecycleError('ambiguous', 'Invalid task lifecycle owner')
    if (!record.locations.some((path) => pathsEqual(path, record.location))) throw new ResourceLifecycleError('ambiguous', 'Lifecycle location is not registered')
    for (const location of [record.originalLocation, ...record.locations]) this.assertTaskLocation(location)
    if (record.parentTaskId === taskId) throw new ResourceLifecycleError('ambiguous', 'Task cannot own itself')
    const ids = new Set<string>()
    for (const operation of record.operations) {
      if (!operation.id || ids.has(operation.id) || !['trash', 'restore'].includes(operation.kind) || !['fenced', 'drained', 'move-prepared', 'moved', 'indexed', 'completed', 'rejected'].includes(operation.phase) || !Number.isSafeInteger(operation.expectedGeneration)) throw new ResourceLifecycleError('unsupported', 'Unknown lifecycle operation')
      ids.add(operation.id)
      this.assertTaskLocation(operation.from); this.assertTaskLocation(operation.to)
      if (!record.locations.some((path) => pathsEqual(path, operation.from)) || !record.locations.some((path) => pathsEqual(path, operation.to)) || operation.expectedGeneration < 1 || operation.expectedGeneration > record.generation || pathsEqual(operation.from, operation.to)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle operation location or generation is not owned')
      if ((operation.kind === 'trash' && !pathsEqual(operation.from, record.originalLocation)) || (operation.kind === 'restore' && !pathsEqual(operation.to, record.originalLocation))) throw new ResourceLifecycleError('ambiguous', 'Lifecycle operation direction is invalid')
      if (operation.phase === 'completed') {
        const result = operation.result
        if (!result || result.operationId !== operation.id || result.kind !== operation.kind || result.generation !== operation.expectedGeneration + 1 || !pathsEqual(result.location, operation.to) || result.state !== (operation.kind === 'trash' ? 'trashed' : 'active') || result.completedAt !== operation.completedAt || !Number.isFinite(Date.parse(result.completedAt))) throw new ResourceLifecycleError('ambiguous', 'Lifecycle operation result receipt is invalid')
      } else if (operation.result) throw new ResourceLifecycleError('ambiguous', 'Uncompleted lifecycle operation has a result receipt')
      if (operation.inventory) validateResourceInventory(operation.inventory)
    }
  }
  private locationIndexPath(location: string): string {
    const key = process.platform === 'win32' ? resolve(location).toLowerCase() : resolve(location)
    return join(this.root, 'locations', `${createHash('sha256').update(key).digest('hex')}.json`)
  }
  private writeLocationIndexes(record: TaskLifecycleRecord): void {
    for (const location of record.locations) {
      const path = this.locationIndexPath(location)
      assertLifecyclePath(this.root, path)
      const value = { schemaVersion: 1, profileId: this.profileId, taskId: record.taskId, location }
      if (existsSync(path)) {
        const previous = this.readJson(path)
        if (JSON.stringify(previous) !== JSON.stringify(value)) throw new ResourceLifecycleError('ambiguous', 'Lifecycle path index has conflicting ownership')
      } else atomicWriteJsonSync(path, value)
    }
  }
  private readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) { throw new ResourceLifecycleError('ambiguous', `Lifecycle source unreadable: ${path} (${(error as Error).message})`) }
  }
}
