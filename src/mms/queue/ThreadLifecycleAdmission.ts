import type { LifecycleAdmission } from '../../shared/resourceLifecycle'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/** Structural port keeps low-level filesystem helpers independent of the lifecycle store. */
export interface ThreadLifecycleGate {
  enableCleanupWriter?(): void
  findByLocation(path: string): { taskId: string; location: string } | undefined
  captureAdmission(taskId: string, expectedLocation?: string): LifecycleAdmission
  assertAdmission(admission: LifecycleAdmission): void
  withPathAdmission<T>(path: string, kind: 'execution' | 'write', work: () => T): T
}

/** Raise the durable minimum writer before adding contracts that Phase 1 binaries cannot honor. */
export function enableVersionedLifecycleWriter(path: string): void {
  const gate = gateFor(path)
  if (!gate) return // Explicit unmanaged library/test storage has no older managed writer.
  const record = gate.findByLocation(path)
  if (!record) { gate.withPathAdmission(path, 'write', () => undefined); return }
  if (!gate.enableCleanupWriter) throw new Error('Lifecycle admission cannot establish the required writer version.')
  gate.enableCleanupWriter()
}

const gates = new Map<string, ThreadLifecycleGate>()

export function registerThreadLifecycleGate(profileHome: string, gate: ThreadLifecycleGate): void {
  gates.set(resolve(profileHome), gate)
}

function gateFor(path: string): ThreadLifecycleGate | undefined {
  const absolute = resolve(path)
  // Personal profile roots can be nested beneath the installation home.
  const roots = [...gates.keys()].sort((a, b) => b.length - a.length)
  const registeredRoot = roots.find((root) => {
    const child = relative(root, absolute)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  })
  // Supported low-level clients must initialize the profile authority before
  // opening managed paths. Never treat a durable managed home as legacy storage.
  let ancestor = absolute
  while (true) {
    if (ancestor === registeredRoot) return gates.get(registeredRoot)
    if (existsSync(join(ancestor, 'lifecycle', 'manifest.json'))) {
      const child = relative(ancestor, absolute).split(/[\\/]/)[0]
      if (child === 'thread-data' || child === 'trash') {
        throw new Error('Lifecycle-managed storage requires initialized profile admission')
      }
      return undefined
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return undefined
}

/** The gate is held only for synchronous filesystem work, never across an await. */
export function withThreadLifecyclePath<T>(path: string, kind: 'execution' | 'write', work: () => T): T {
  const gate = gateFor(path)
  return gate ? gate.withPathAdmission(path, kind, work) : work()
}

/** Capture once before waiting, so trash/restore cannot revive an old queued writer. */
export function captureThreadLifecyclePath(path: string): () => void {
  const gate = gateFor(path)
  const record = gate?.findByLocation(path)
  if (!gate || !record) return () => undefined
  const admission = gate.captureAdmission(record.taskId, record.location)
  return () => gate.assertAdmission(admission)
}

/** Read-only access to the registered authority; callers must retain its admission checks. */
export function getThreadLifecycleGate(path: string): ThreadLifecycleGate | undefined { return gateFor(path) }
