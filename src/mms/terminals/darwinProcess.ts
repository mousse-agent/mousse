import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapturedProcessTree } from './processLifecycle'

export interface DarwinProcessIdentity { pid: number; parent: number; startedAt: string }
export interface DarwinProcessModule {
  read(pid: number): DarwinProcessIdentity | null
  children(pid: number): number[]
  signal(pid: number, startedAt: string, signal: number): boolean
}
let loaded: DarwinProcessModule | undefined
/** Fixed host-owned resource only. Runtime never compiles or accepts module paths. */
export function loadDarwinProcess(): DarwinProcessModule {
  if (process.platform !== 'darwin') throw new Error('Darwin owned-process adapter unavailable')
  if (loaded) return loaded
  let ancestor = dirname(fileURLToPath(import.meta.url))
  let directory: string | undefined
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(ancestor, 'out/net-native', `${process.platform}-${process.arch}`)
    if (existsSync(join(candidate, 'owned-process-manifest.json'))) { directory = candidate; break }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (!directory) throw new Error('Darwin owned-process addon missing; rebuild the host package')
  const manifestPath = join(directory, 'owned-process-manifest.json')
  if (statSync(manifestPath).size > 8192) throw new Error('Darwin owned-process manifest too large')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const artifact = join(directory, 'owned-process.node')
  if (statSync(artifact).size > 4 * 1024 * 1024) throw new Error('Darwin owned-process artifact too large')
  if (manifest.v !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.napi !== 8 ||
      Number(process.versions.napi) < 8 || manifest.artifact !== 'owned-process.node' ||
      typeof manifest.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.artifactSha256) ||
      createHash('sha256').update(readFileSync(artifact)).digest('hex') !== manifest.artifactSha256) throw new Error('Darwin owned-process artifact verification failed')
  const native = createRequire(import.meta.url)(artifact) as DarwinProcessModule
  if (['read', 'children', 'signal'].some(key => typeof (native as unknown as Record<string, unknown>)[key] !== 'function')) throw new Error('Darwin owned-process addon invalid')
  loaded = native
  return native
}

/** Capture ancestry while still attached, then retain exact birth identities after exit. */
export function captureDarwinProcessTree(rootPid: number, native = loadDarwinProcess()): CapturedProcessTree {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) throw new Error('Invalid owned root PID')
  const deadline = performance.now() + 1000
  const root = native.read(rootPid)
  if (!root) return { isAlive: () => false, signal: () => undefined }
  const identities = [root], edges: Array<{ child: DarwinProcessIdentity; parent: DarwinProcessIdentity }> = []
  const seen = new Set([rootPid, process.pid])
  const members = new Map<number, Set<number>>()
  for (let cursor = 0; cursor < identities.length; cursor += 1) {
    if (performance.now() > deadline) throw new Error('Owned process inventory deadline exceeded')
    const parent = identities[cursor]
    if (native.read(parent.pid)?.startedAt !== parent.startedAt) throw new Error('Owned parent changed during capture')
    const direct = new Set<number>(); members.set(parent.pid, direct)
    for (const pid of native.children(parent.pid)) {
      if (seen.has(pid)) throw new Error('Owned child inventory contains a cycle')
      const child = native.read(pid)
      if (!child) continue
      if (child.parent !== parent.pid) throw new Error('Owned child ancestry changed during capture')
      if (identities.length >= 256) throw new Error('Owned descendant inventory exceeded 256 processes')
      seen.add(pid); direct.add(pid); identities.push(child); edges.push({ child, parent })
    }
  }
  // No signals occur until every still-live edge and the root have been checked.
  for (const { child, parent } of edges) {
    const current = native.read(child.pid)
    if (current && (current.startedAt !== child.startedAt || current.parent !== parent.pid || native.read(parent.pid)?.startedAt !== parent.startedAt)) throw new Error('Owned ancestry changed before capture completed')
  }
  for (const parent of identities) {
    if (!native.read(parent.pid)) continue
    for (const pid of native.children(parent.pid)) {
      if (!members.get(parent.pid)?.has(pid) && native.read(pid)) throw new Error('Owned child inventory changed before capture completed')
    }
  }
  if (native.read(rootPid)?.startedAt !== root.startedAt || performance.now() > deadline) throw new Error('Owned root changed before capture completed')
  identities.reverse()
  return {
    isAlive: () => {
      const deadline = performance.now() + 1000
      return identities.some(identity => {
        if (performance.now() > deadline) return true
        try { return native.read(identity.pid)?.startedAt === identity.startedAt } catch { return true }
      })
    },
    signal: mode => {
      const deadline = performance.now() + 1000
      for (const identity of identities) {
        if (performance.now() > deadline) throw new Error('Owned process signaling deadline exceeded')
        native.signal(identity.pid, identity.startedAt, mode === 'kill' ? 9 : 15)
      }
    }
  }
}
