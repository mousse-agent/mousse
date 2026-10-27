import { afterEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { groupUsage, type MachineUsageEntry, type StorageUsageEntry, type StorageUsageSnapshot } from '../src/shared/storage'
import { measureTree } from '../src/mms/lifecycle/diskMeasure'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { condenseUsage, StorageUsageService, type StorageUsageDeps } from '../src/mms/lifecycle/StorageUsageService'
import type { Project, Thread } from '../src/shared/types'

const KB = 1024
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'mousse-usage-')); dirs.push(dir); return dir }
const at = '2026-10-21T10:00:00.000Z'

function file(path: string, kib: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(kib * KB, 7))
}
const thread = (id: string, name: string, extra: Partial<Thread> = {}): Thread => ({ id, name, createdAt: at, updatedAt: at, order: 0, ...extra })

interface World {
  root: string
  outside: string
  store: ResourceLifecycleStore
  threads: Thread[]
  projects: Project[]
  service(overrides?: Partial<StorageUsageDeps>): StorageUsageService
  location(id: string): string
}

/** A profile under `<root>/profile` in an installation at `<root>`, with data the scan has to attribute. */
function world(options: { link?: boolean; sameHome?: boolean; minimal?: boolean } = {}): World {
  const root = temp()
  const outside = temp()
  const profile = options.sameHome ? root : join(root, 'profile')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: profile })
  const location = (id: string): string => join(profile, 'thread-data', id)
  const register = (id: string, parentTaskId?: string): void => {
    mkdirSync(location(id), { recursive: true })
    writeFileSync(join(location(id), 'meta.json'), JSON.stringify({ id }))
    store.registerTask({ taskId: id, location: location(id), ...(parentTaskId ? { parentTaskId } : {}) })
  }
  register('t1'); register('t2'); register('t3', 't1'); register('t4')
  file(join(location('t1'), 'messages.json'), 64)
  file(join(location('t2'), 'messages.json'), 128)
  file(join(location('t3'), 'messages.json'), 192)
  file(join(location('t4'), 'messages.json'), 96)
  if (!options.minimal) {
    // t1's worktree, and a subagent's (t3) that rolls up to t1.
    const worktrees = join(root, 'repositories', 'r1', 'worktrees')
    file(join(worktrees, 'threads', 't1', 'src.bin'), 256)
    writeFileSync(join(location('t1'), 'workspace.json'), JSON.stringify({ worktreePath: join(worktrees, 'threads', 't1') }))
    file(join(worktrees, 'agents', 'a1', 'work.bin'), 80)
    writeFileSync(join(location('t3'), 'agents.json'), JSON.stringify([{ agentId: 'a1', worktreePath: join(worktrees, 'agents', 'a1') }]))
    // A checkout nothing names.
    file(join(worktrees, 'threads', 'orphan', 'x.bin'), 320)
    // A record that names a folder outside Mousse's data: never measured.
    file(join(outside, 'wt', 'big.bin'), 1024)
    writeFileSync(join(location('t2'), 'workspace.json'), JSON.stringify({ worktreePath: join(outside, 'wt') }))
    // A link out of a thread folder: never followed.
    file(join(outside, 'linked', 'big.bin'), 1024)
    symlinkSync(join(outside, 'linked'), join(location('t2'), 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    // Browser data: an indexed session and artifact (thread t2), an unindexed session, the browser profile.
    const artifactId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    mkdirSync(join(profile, 'browser', 'artifact-index'), { recursive: true })
    writeFileSync(join(profile, 'browser', 'artifact-index', 'i1.json'), JSON.stringify({ version: 1, scope: { profileId: 'test', threadId: 't2', sessionId: 'sessA' }, ref: { id: artifactId } }))
    file(join(profile, 'artifacts', artifactId, 'blob.bin'), 448)
    file(join(profile, 'browser', 'worker-artifacts', 'test', 'sessA', 'art_1.png'), 384)
    file(join(profile, 'browser', 'worker-artifacts', 'test', 'sessB', 'art_2.png'), 512)
    file(join(profile, 'browser', 'user-data', 'profile.bin'), 576)
    file(join(root, 'logs', 'daemon.log'), 640)
    file(join(profile, 'misc', 'other.bin'), 704)
  }
  if (options.link) {
    file(join(location('t1'), 'shared.bin'), 256)
    linkSync(join(location('t1'), 'shared.bin'), join(location('t2'), 'shared.bin'))
  }
  const threads = [
    thread('t1', 'First', { projectId: 'p1' }),
    thread('t2', 'Second', { projectId: 'p2' }),
    thread('t3', 'Helper', { projectId: 'p1', lineage: { parentThreadId: 't1', rootThreadId: 't1', relationship: 'subagent' } })
    // t4 is not listed: its record exists but the profile does not show it.
  ]
  const projects: Project[] = [
    { id: 'p1', name: 'Alpha', path: join(outside, 'alpha'), createdAt: at, order: 0 },
    { id: 'p2', name: 'Beta', path: join(outside, 'beta'), createdAt: at, order: 1 }
  ]
  let tick = 0
  return {
    root, outside, store, threads, projects, location,
    service: (overrides = {}) => new StorageUsageService({
      store, threads: { listAllThreads: () => threads }, projects: { listProjects: () => projects },
      installationHome: root, now: () => (tick += 1000), autoContinue: false, ...overrides
    })
  }
}

const only = (snapshot: StorageUsageSnapshot, kind: StorageUsageEntry['kind'], threadId?: string): StorageUsageEntry | undefined =>
  snapshot.entries.find((entry) => entry.kind === kind && entry.threadId === threadId)
/** Payload size plus a little for the small files beside it. */
const about = (entry: StorageUsageEntry | undefined, kib: number, slackKib = 48): void => {
  expect(entry, `expected an entry of about ${kib} KiB`).toBeDefined()
  expect(entry!.bytes).toBeGreaterThanOrEqual(kib * KB)
  expect(entry!.bytes).toBeLessThan((kib + slackKib) * KB)
}

describe('StorageUsageService', () => {
  it('attributes bytes to the right kind, project and thread, rolling subagents up to their root thread', async () => {
    const w = world()
    const snapshot = await w.service().measure()
    about(only(snapshot, 'threads', 't1'), 64 + 192) // t3 is a subagent of t1
    about(only(snapshot, 'threads', 't2'), 128)
    about(only(snapshot, 'threads', undefined), 96) // t4 is not a listed thread
    about(only(snapshot, 'worktrees', 't1'), 256 + 80) // its own checkout and its subagent's
    about(only(snapshot, 'worktrees', undefined), 320) // the checkout nothing names
    about(only(snapshot, 'browser', 't2'), 448 + 384) // indexed artifact and session
    about(only(snapshot, 'browser', undefined), 512 + 576) // unindexed session and the browser profile
    about(only(snapshot, 'logs', undefined), 640)
    about(only(snapshot, 'other', undefined), 704, 400)
    expect(only(snapshot, 'threads', 't1')).toMatchObject({ projectId: 'p1' })
    expect(only(snapshot, 'browser', 't2')).toMatchObject({ projectId: 'p2' })
    expect(only(snapshot, 'logs', undefined)).not.toHaveProperty('projectId')
    // Nothing a link or a record pointed outside Mousse's data at is in the total.
    const total = snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    expect(total).toBeGreaterThanOrEqual(4400 * KB)
    expect(total).toBeLessThan(4400 * KB + 400 * KB)
    expect(snapshot.partial).toBe(false)
    expect(snapshot.names).toEqual({ projects: { p1: 'Alpha', p2: 'Beta' }, threads: { t1: 'First', t2: 'Second' } })
  })

  it('does not follow a link out of a thread folder and does not trust a worktree path outside the data', async () => {
    const w = world()
    const snapshot = await w.service().measure()
    about(only(snapshot, 'threads', 't2'), 128) // the 1 MiB behind the link is not counted
    expect(snapshot.entries.some((entry) => entry.kind === 'worktrees' && entry.threadId === 't2')).toBe(false)
    expect(snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThan(5 * 1024 * KB)
  })

  it('counts a hard-linked file once across roots', async () => {
    const w = world({ link: true })
    const snapshot = await w.service().measure()
    const threads = snapshot.entries.filter((entry) => entry.kind === 'threads').reduce((sum, entry) => sum + entry.bytes, 0)
    // 64 + 128 + 192 + 96 plus the shared 256 once; counting it twice would be another 256 KiB.
    expect(threads).toBeGreaterThanOrEqual((64 + 128 + 192 + 96 + 256) * KB)
    expect(threads).toBeLessThan((64 + 128 + 192 + 96 + 256 + 128) * KB)
  })

  it('says a snapshot is partial when the budget ends a root early, and the entry is marked', async () => {
    const root = temp()
    const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: root })
    const location = join(root, 'thread-data', 't1')
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 't1' }))
    store.registerTask({ taskId: 't1', location })
    for (let index = 0; index < 60; index++) file(join(location, 'many', `f${index}.bin`), 4)
    const service = new StorageUsageService({
      store, threads: { listAllThreads: () => [thread('t1', 'Many')] }, projects: { listProjects: () => [] }, installationHome: root,
      scanEntryBudget: 20, autoContinue: false
    })
    const snapshot = await service.measure({ refresh: true })
    expect(snapshot.partial).toBe(true)
    const entry = only(snapshot, 'threads', 't1')!
    expect(entry.partial).toBe(true)
    expect(entry.bytes).toBeLessThan(60 * 4 * KB)
    expect(service.isComplete()).toBe(false)
  })

  it('serves the cache until asked to refresh, and writes it without any path', async () => {
    const w = world()
    const calls: string[] = []
    const measure: typeof measureTree = (path, options) => { calls.push(path); return measureTree(path, options) }
    const service = w.service({ measure })
    const first = await service.measure()
    const scanned = calls.length
    expect(scanned).toBeGreaterThan(0)
    const again = await service.measure()
    expect(calls.length).toBe(scanned)
    expect(again).toEqual(first)
    const refreshed = await service.measure({ refresh: true })
    expect(calls.length).toBe(scanned * 2)
    expect(refreshed.measuredAt).not.toBe(first.measuredAt)
    const cache = readFileSync(join(w.store.root, 'storage-usage.json'), 'utf8')
    expect(cache).not.toContain(w.root.replaceAll('\\', '\\\\'))
    expect(cache).not.toContain(w.root)
    // A new service on the same profile starts from the file and does not scan.
    const calls2: string[] = []
    const restarted = w.service({ measure: (path, options) => { calls2.push(path); return measureTree(path, options) } })
    const loaded = await restarted.measure()
    expect(calls2).toEqual([])
    expect(loaded.entries).toEqual(refreshed.entries)
    expect(loaded.measuredAt).toBe(refreshed.measuredAt)
  })

  it('names only listed threads and projects, and gives a trashed or unlisted thread no id', async () => {
    const w = world()
    w.store.update('t2', (record) => { record.state = 'trashed' })
    const snapshot = await w.service().measure()
    expect(snapshot.entries.some((entry) => entry.threadId === 't2')).toBe(false)
    about(only(snapshot, 'threads', undefined), 96 + 128, 100) // t4, and t2 now that it is trashed
    expect(Object.keys(snapshot.names.threads)).not.toContain('t2')
    expect(JSON.stringify(snapshot)).not.toContain(w.root)
  })

  describe('continuation across scans', () => {
    /** Each root costs 10 entries and the scan allows 10, so one root fits per scan. */
    function stepped(w: World, started: string[]) {
      const measure: typeof measureTree = async (path, options) => {
        if ((options.maxEntries ?? Infinity) < 10) return { bytes: 0, files: 0, entries: options.maxEntries ?? 0, estimated: false, partial: true, unreadable: 0, stopped: 'entries' }
        started.push(path)
        return { ...(await measureTree(path, { ...options, maxEntries: undefined })), entries: 10 }
      }
      return w.service({ measure, scanEntryBudget: 10 })
    }

    it('measures every root exactly once over consecutive scans, counts a shared hard link once, and reports partial until the last', async () => {
      // Five roots: four thread folders, then the rest of the profile, which holds a third link to the same file.
      const w = world({ sameHome: true, link: true, minimal: true })
      linkSync(join(w.location('t1'), 'shared.bin'), join(w.root, 'rest-link.bin'))
      const started: string[] = []
      const service = stepped(w, started)
      const snapshots: StorageUsageSnapshot[] = [await service.measure({ refresh: true })]
      for (let scan = 0; scan < 3; scan++) snapshots.push(await service.continueScan())
      expect(snapshots.map((snapshot) => snapshot.partial)).toEqual([true, true, true, true])
      expect(started.length).toBe(4)
      const last = await service.continueScan()
      expect(last.partial).toBe(false)
      expect(service.isComplete()).toBe(true)
      expect(started.length).toBe(5)
      expect(new Set(started).size).toBe(5)
      // The snapshot reports the oldest measurement, which is the first root's.
      expect(last.measuredAt).toBe(snapshots[0].measuredAt)
      // Counting the link in each root would add its size again (256 KiB); the cache file itself changes a little between scans.
      const total = last.entries.reduce((sum, entry) => sum + entry.bytes, 0)
      const whole = (await measureTree(w.root, { mode: 'usage', budgetMs: 60_000 })).bytes
      expect(Math.abs(total - whole)).toBeLessThan(16 * KB)
    })

    it('starts a new generation from the first root after a complete one', async () => {
      const w = world({ sameHome: true, minimal: true })
      const started: string[] = []
      const service = stepped(w, started)
      await service.measure({ refresh: true })
      for (let scan = 0; scan < 4; scan++) await service.continueScan()
      expect(service.isComplete()).toBe(true)
      const firstRoot = started[0]
      const before = started.length
      const next = await service.continueScan()
      expect(started[before]).toBe(firstRoot)
      expect(service.isComplete()).toBe(false)
      expect(next.partial).toBe(true) // older numbers beside the one fresh root
    })
  })

  it('skips a root a cleanup run removed during the scan', async () => {
    const w = world()
    let removed = false
    const measure: typeof measureTree = async (path, options) => {
      if (!removed) { removed = true; rmSync(w.location('t2'), { recursive: true, force: true }) }
      return measureTree(path, options)
    }
    const snapshot = await w.service({ measure }).measure()
    expect(only(snapshot, 'threads', 't2')).toBeUndefined()
    about(only(snapshot, 'threads', 't1'), 64 + 192)
  })

  it('waits while a cleanup run is busy and rescans afterwards', async () => {
    const w = world()
    const calls: string[] = []
    let busy = true
    const service = w.service({
      busy: () => busy, restMs: 5, autoContinue: true,
      measure: (path, options) => { calls.push(path); return measureTree(path, options) }
    })
    service.rescanSoon()
    await new Promise((done) => setTimeout(done, 120))
    expect(calls).toEqual([])
    busy = false
    for (let waited = 0; waited < 4000 && !service.isComplete(); waited += 20) await new Promise((done) => setTimeout(done, 20))
    expect(calls.length).toBeGreaterThan(0)
    await service.stop()
  })

  it('keeps the answer small enough for a remote reply by folding the smallest threads into their kind', () => {
    const entries: StorageUsageEntry[] = Array.from({ length: 800 }, (_, index) => ({
      kind: index % 2 ? 'worktrees' : 'threads', projectId: `project-${index % 7}`, threadId: `thread-${String(index).padStart(36, '0')}`, bytes: 1_000_000 - index, files: 3
    }))
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    const result = condenseUsage(entries, 20_000)
    expect(result.condensed).toBe(true)
    expect(JSON.stringify(result.entries).length).toBeLessThanOrEqual(20_000)
    expect(result.entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(total)
    expect(result.entries.reduce((sum, entry) => sum + entry.files, 0)).toBe(800 * 3)
    // The biggest threads keep their ids.
    expect(result.entries.some((entry) => entry.threadId === entries[0].threadId)).toBe(true)
    expect(condenseUsage(entries.slice(0, 3), 20_000)).toEqual({ entries: entries.slice(0, 3), condensed: false })
  })
})

describe('groupUsage', () => {
  const self = { node: 'self', name: 'This computer' }
  const laptop = { node: 'node_laptop', name: 'Laptop' }
  const row = (machine: MachineUsageEntry['machine'], entry: StorageUsageEntry): MachineUsageEntry => ({ ...entry, machine })
  const names = { self: { projects: { p1: 'Alpha' }, threads: { t1: 'First', t2: 'Second' } }, node_laptop: { projects: { p1: 'Other Alpha' }, threads: { t1: 'Laptop thread' } } }
  const rows: MachineUsageEntry[] = [
    row(self, { kind: 'threads', projectId: 'p1', threadId: 't1', bytes: 600, files: 1 }),
    row(self, { kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 200, files: 1 }),
    row(self, { kind: 'threads', projectId: 'p1', threadId: 't2', bytes: 100, files: 1 }),
    row(self, { kind: 'logs', bytes: 50, files: 1 }),
    row(laptop, { kind: 'threads', projectId: 'p1', threadId: 't1', bytes: 40, files: 1 }),
    row(laptop, { kind: 'other', bytes: 10, files: 1 })
  ]

  it('groups by project: one row per machine, so the same id on two machines stays separate', () => {
    const groups = groupUsage(rows, 'project', names)
    expect(groups.map((group) => [group.machine!.name, group.label, group.bytes])).toEqual([
      ['This computer', 'Alpha', 900], ['Laptop', 'Other Alpha', 40], ['This computer', 'Other', 50], ['Laptop', 'Other', 10]
    ])
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length)
    expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1)
  })

  it('groups by kind, summing across machines', () => {
    const groups = groupUsage(rows, 'kind', names)
    expect(groups.map((group) => [group.label, group.bytes])).toEqual([['Threads', 740], ['Worktrees', 200], ['Logs', 50], ['Other', 10]])
    expect(groups.every((group) => group.machine === undefined)).toBe(true)
    expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1)
  })

  it('groups by thread: the top ten, then the rest and the unattributed as Other per machine', () => {
    const many: MachineUsageEntry[] = Array.from({ length: 14 }, (_, index) => row(self, { kind: 'threads', threadId: `x${index}`, bytes: 1000 - index, files: 1 }))
    const groups = groupUsage([...many, ...rows], 'thread', { self: { projects: {}, threads: { ...names.self.threads, ...Object.fromEntries(many.map((entry) => [entry.threadId!, `Thread ${entry.threadId}`])) } }, node_laptop: names.node_laptop })
    const named = groups.filter((group) => group.id)
    expect(named).toHaveLength(10)
    expect(named[0].label).toBe('Thread x0')
    const others = groups.filter((group) => !group.id)
    expect(others.map((group) => group.machine!.name).sort()).toEqual(['Laptop', 'This computer'])
    expect(groups.at(-1)!.label).toBe('Other')
    expect(groups.reduce((sum, group) => sum + group.bytes, 0)).toBe([...many, ...rows].reduce((sum, entry) => sum + entry.bytes, 0))
    expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1)
    // The same thread id on two machines is two rows.
    const both = groupUsage(rows, 'thread', names).filter((group) => group.id === 't1')
    expect(both.map((group) => [group.machine!.name, group.label, group.bytes])).toEqual([['This computer', 'First', 800], ['Laptop', 'Laptop thread', 40]])
  })

  it('has no rows and no shares for no usage', () => {
    expect(groupUsage([], 'kind')).toEqual([])
    expect(groupUsage([row(self, { kind: 'logs', bytes: 0, files: 0 })], 'project')).toEqual([])
  })
})
