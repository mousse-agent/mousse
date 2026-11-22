/**
 * A thread's `actions.json` is read again only when it changed, by this process or another, and a write that would
 * leave its bytes as they are is skipped, but only while the file is still the one last read.
 */
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import type { ThreadAction } from '../src/shared/threadActions'

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function thread(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-actions-file-')); roots.push(directory)
  return directory
}
const action = (id: string, state: ThreadAction['state'] = 'completed'): ThreadAction => ({
  id, turnId: `turn-${id}`, conversationBranchId: 'main', presentationMessageStart: 0, presentationMessageEnd: 1,
  nativeContextBoundary: { messageIndex: 1, compactionGeneration: 0, fidelity: 'exact' }, startSha: 'a', endSha: 'b',
  commits: [], childIntegrations: [], changedPaths: [], externalEffects: [], reversible: true, state, createdAt: '2026-01-01T00:00:00.000Z'
})
const text = (actions: ThreadAction[]) => `${JSON.stringify(actions, null, 2)}\n`
const onDisk = (directory: string): ThreadAction[] => { try { return JSON.parse(readFileSync(join(directory, 'actions.json'), 'utf8')) as ThreadAction[] } catch { return [] } }
const isActionsFile = (path: unknown) => typeof path === 'string' && basename(path) === 'actions.json'
const reads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => isActionsFile(path)).length
  + vi.mocked(fs.openSync).mock.calls.filter(([path, flags]) => isActionsFile(path) && (flags ?? 'r') === 'r').length
const writes = () => vi.mocked(fs.openSync).mock.calls.filter(([path]) => /^actions\.json\..+\.tmp$/.test(basename(String(path)))).length

// Who changes the file (nobody, this process, another process) and how (replaced by a rename, rewritten in place with
// the same size, removed), and what a write would leave (the same bytes, different ones, the same bytes as this process
// last read after another process changed them). `reads` and `writes`: what the row's own calls cost. `then`: the reads
// of the accessors run after it, which read the file again only when it changed.
const rows: { case: string; act: (directory: string, service: ThreadActionService) => void; reads: number; writes: number; then: number }[] = [
  { case: 'first read', act: (_, service) => service.list(), reads: 1, writes: 0, then: 0 },
  { case: 'unchanged: read again by every accessor', act: (_, service) => { service.list(); service.get('1'); service.latest('main'); service.view() }, reads: 0, writes: 0, then: 0 },
  { case: 'this process writes a change', act: (_, service) => service.replace([...service.view(), action('2')]), reads: 0, writes: 1, then: 1 },
  { case: 'a write that leaves the bytes as they are is skipped', act: (_, service) => service.replace(service.list()), reads: 0, writes: 0, then: 0 },
  { case: 'another process replaces the file', act: (directory) => { writeFileSync(join(directory, 'other.tmp'), text([action('1'), action('2'), action('3')])); renameSync(join(directory, 'other.tmp'), join(directory, 'actions.json')) }, reads: 0, writes: 0, then: 1 },
  { case: 'another process rewrites it in place with the same size', act: (directory) => writeFileSync(join(directory, 'actions.json'), text([action('1'), action('2'), action('4')])), reads: 0, writes: 0, then: 1 },
  { case: 'the bytes this process last read, after another process changed the file, are written', act: (directory, service) => {
    const before = service.view()
    writeFileSync(join(directory, 'actions.json'), text([action('9')]))
    service.replace(before)
  }, reads: 0, writes: 1, then: 1 },
  { case: 'another process removes the file', act: (directory) => unlinkSync(join(directory, 'actions.json')), reads: 0, writes: 0, then: 0 }
]

it('every accessor gives what is on disk after each change, reading and writing only when the file changes', () => {
  const directory = thread(); const service = new ThreadActionService(directory)
  writeFileSync(join(directory, 'actions.json'), text([action('1')]))
  const counted = () => { const found = { reads: reads(), writes: writes() }; vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.openSync).mockClear(); return found }
  for (const row of rows) {
    counted()
    row.act(directory, service)
    expect(counted(), row.case).toEqual({ reads: row.reads, writes: row.writes })
    const disk = onDisk(directory)
    counted()
    expect(service.list(), row.case).toEqual(disk)
    expect(service.view(), row.case).toEqual(disk)
    expect(service.latest('main'), row.case).toEqual(disk.at(-1))
    expect(service.get(disk[0]?.id ?? 'none'), row.case).toEqual(disk[0])
    expect(counted(), row.case).toEqual({ reads: row.then, writes: 0 })
  }
})

it('callers get copies they can change; the shared list cannot be changed', () => {
  const directory = thread(); const service = new ThreadActionService(directory)
  service.replace([action('1', 'running')])
  const listed = service.list(); listed[0]!.state = 'completed'; listed.push(action('2'))
  const got = service.get('1')!; got.state = 'failed'
  const latest = service.latest('main')!; latest.commits.push('c')
  expect(service.view()).toEqual([action('1', 'running')])
  expect(() => { (service.view()[0] as ThreadAction).state = 'completed' }).toThrow(TypeError)
  expect(onDisk(directory)).toEqual([action('1', 'running')])
})
