/**
 * Places for single requests (`src/mms/harness/oneShot/places.ts`): a record before anything exists, positive proof
 * that the process tree drained before anything is removed, removal that never follows links or junctions and
 * rechecks the folder's identity, and a sweep that cleans what a killed daemon left from the records alone.
 *
 * Real processes (Node scripts started through the job supervisor on Windows, in their own process group on POSIX)
 * and real folders. A killed daemon is simulated by the ledger records it would leave: the inputs are listed as table
 * rows below (killed before spawn, during spawn, after the session started, after the answer; a surviving grandchild;
 * PID reuse; malformed records; a junction inside the place; unrelated folders and sessions as negative controls).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addLeftover, PLACE_LEFTOVER_AGE_MS, placesFs, releasePlace, reservePlace, spawnInPlace, sweepPlaces,
  type LeftoverRule, type Place, type PlaceRecord
} from '../../src/mms/harness/oneShot/places'
import { PLACE_WATCHER } from '../../src/mms/harness/oneShot/placeWatcher'

const win = process.platform === 'win32'
const originalFs = { ...placesFs }
const dirs: string[] = []
const processes: ChildProcess[] = []
const strayPids: number[] = []

afterEach(() => {
  Object.assign(placesFs, originalFs)
  delete process.env.MOUSSE_PLACES_TEST_SECRET
  for (const child of processes.splice(0)) try { child.kill('SIGKILL') } catch { /* gone */ }
  for (const pid of strayPids.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-places-'))
  dirs.push(dir)
  return dir
}

const META = { route: 'test:route', instanceId: 'test-instance' }
const later = () => Date.now() + PLACE_LEFTOVER_AGE_MS + 60_000
const ledgerOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as PlaceRecord

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

/** The environment an agent gets: nothing from the test process but what starts Node (and, on Windows, the supervisor). */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? process.env.Path ?? '', ELECTRON_RUN_AS_NODE: '1' }
  if (win) {
    const scratch = tempDir()
    Object.assign(env, { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: scratch, TMP: scratch })
  }
  return env
}

function script(source: string): string {
  const path = join(tempDir(), 'agent.cjs')
  writeFileSync(path, source)
  return path
}

function launch(path: string) {
  return { command: process.execPath, args: [path], env: agentEnv(), purpose: 'one-shot', instanceId: META.instanceId }
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    let errors = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end >= 0) resolve(text.slice(0, end))
    })
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    child.once('exit', (code) => reject(new Error(`the agent exited (${code}) before answering: ${errors}`)))
  })
}

/** An agent that starts a grandchild which outlives it, both ignoring SIGTERM, and prints both pids. */
const AGENT_WITH_GRANDCHILD = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => {})
// Detached on Windows to leave the agent's console and libuv's job; on POSIX it stays in the agent's group.
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: process.platform === 'win32', stdio: 'ignore' })
grandchild.unref()
process.stdout.write(JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }) + '\\n')
setInterval(() => {}, 1000)
`

/** A process that is not ours (a stand-in for a reused pid), in a group of its own on POSIX. */
function unrelatedProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: !win })
  processes.push(child)
  return child.pid!
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

const treeOf = (pid: number): PlaceRecord['tree'] => win ? { kind: 'win_job', supervisorPid: pid } : { kind: 'posix_group', pgid: pid }

/** What a killed daemon leaves: a place folder (with `file` written in it) and its ledger record. */
function leftBehind(profile: string, patch: Partial<PlaceRecord>, options: { file?: string; folder?: boolean } = {}) {
  const id = randomUUID()
  const dir = join(profile, 'one-shot', id)
  let identity: PlaceRecord['dir']
  if (options.folder !== false) {
    mkdirSync(dir, { recursive: true })
    if (options.file) writeFileSync(join(dir, options.file), 'x')
    const stats = lstatSync(dir, { bigint: true })
    identity = { dev: String(stats.dev), ino: String(stats.ino) }
  }
  const ledger = join(profile, 'one-shot-ledger', `${id}.json`)
  mkdirSync(join(profile, 'one-shot-ledger'), { recursive: true })
  const now = Date.now()
  const record: PlaceRecord = { v: 1, id, state: 'reserved', ...META, createdAt: now, updatedAt: now, ...(identity ? { dir: identity } : {}), ...patch }
  writeFileSync(ledger, JSON.stringify(record))
  return { id, dir, ledger }
}

describe('reservePlace', () => {
  it('writes the record before the place folder exists, and leaves no folder when the folder cannot be made', () => {
    const profile = tempDir()
    const seen: (string | undefined)[] = []
    placesFs.mkdir = (path) => {
      const ledger = join(profile, 'one-shot-ledger', `${basename(path)}.json`)
      seen.push(existsSync(ledger) ? ledgerOf(ledger).state : undefined)
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    expect(() => reservePlace(profile, META)).toThrow('denied')
    expect(seen).toEqual(['reserved'])
    expect(readdirSync(join(profile, 'one-shot'))).toEqual([])
    expect(readdirSync(join(profile, 'one-shot-ledger'))).toEqual([])
  })

  it('records the folder it made, by identity, holding no request text', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    const record = ledgerOf(place.ledgerPath)
    const stats = lstatSync(place.dir, { bigint: true })
    expect(record).toMatchObject({ v: 1, id: place.id, state: 'reserved', dir: { dev: String(stats.dev), ino: String(stats.ino) } })
    expect(Object.keys(record).sort()).toEqual(['createdAt', 'dir', 'id', 'instanceId', 'route', 'state', 'updatedAt', 'v'])
    await releasePlace(place, undefined)
  })
})

describe('spawnInPlace', () => {
  it('runs the agent in its place with exactly the given environment, recording its tree before returning', async () => {
    const profile = tempDir()
    process.env.MOUSSE_PLACES_TEST_SECRET = 'leaked'
    const place = reservePlace(profile, META)
    const proc = spawnInPlace(place, launch(script(`
      process.stdout.write(JSON.stringify({ cwd: process.cwd(), secret: process.env.MOUSSE_PLACES_TEST_SECRET ?? null }) + '\\n')
      setInterval(() => {}, 1000)
    `)))
    processes.push(proc.child)
    expect(ledgerOf(place.ledgerPath)).toMatchObject({ state: 'running', tree: win ? { kind: 'win_job', supervisorPid: proc.child.pid } : { kind: 'posix_group', pgid: proc.child.pid } })
    const answer = JSON.parse(await firstLine(proc.child)) as { cwd: string; secret: string | null }
    expect(realpathSync(answer.cwd)).toBe(realpathSync(place.dir))
    expect(answer.secret).toBeNull()
    expect(await releasePlace(place, proc)).toMatchObject({ reaped: true, removed: true })
  }, 60_000)

  it('stop() resolves drained only once the agent and its surviving grandchild are gone', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    const proc = spawnInPlace(place, launch(script(AGENT_WITH_GRANDCHILD)))
    processes.push(proc.child)
    const pids = JSON.parse(await firstLine(proc.child)) as { agent: number; grandchild: number }
    strayPids.push(pids.agent, pids.grandchild)
    expect(alive(pids.agent) && alive(pids.grandchild)).toBe(true)
    const stopping = proc.stop()
    expect(ledgerOf(place.ledgerPath).state).toBe('stopping')
    expect(await stopping).toBe('drained')
    expect({ agent: alive(pids.agent), grandchild: alive(pids.grandchild) }).toEqual({ agent: false, grandchild: false })
    expect(await proc.stop()).toBe('drained')
    expect(await releasePlace(place, proc)).toMatchObject({ reaped: true, removed: true })
    expect(existsSync(place.dir) || existsSync(place.ledgerPath)).toBe(false)
  }, 60_000)
})

describe('releasePlace', () => {
  it('reports what the agent wrote, and nothing for empty folders', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    const proc = spawnInPlace(place, launch(script(`
      require('node:fs').writeFileSync('answer.txt', 'hello')
      process.stdout.write('done\\n')
      setInterval(() => {}, 1000)
    `)))
    processes.push(proc.child)
    await firstLine(proc.child)
    expect(await releasePlace(place, proc)).toEqual({ reaped: true, written: 'answer.txt', removed: true })
    expect(existsSync(place.dir)).toBe(false)

    const empty = reservePlace(profile, META)
    mkdirSync(join(empty.dir, 'cache', 'deeper'), { recursive: true })
    expect(await releasePlace(empty, undefined)).toEqual({ reaped: true, removed: true })
    expect(existsSync(empty.dir) || existsSync(empty.ledgerPath)).toBe(false)
  }, 60_000)

  it('runs the agent in a subfolder of its place when asked, and refuses a folder outside it', async () => {
    const profile = tempDir()
    const outside = tempDir()
    const place = reservePlace(profile, META)
    const work = join(place.dir, 'work')
    mkdirSync(work)
    symlinkSync(outside, join(place.dir, 'escape'), 'junction')
    const agent = script(`
      require('node:fs').writeFileSync('answer.txt', 'hello')
      process.stdout.write(JSON.stringify({ cwd: process.cwd() }) + '\\n')
      setInterval(() => {}, 1000)
    `)
    for (const cwd of [outside, join(place.dir, '..'), join(place.dir, 'escape')])
      expect(() => spawnInPlace(place, { ...launch(agent), cwd })).toThrow('inside the place')
    expect(ledgerOf(place.ledgerPath).state).toBe('reserved')
    const proc = spawnInPlace(place, { ...launch(agent), cwd: work })
    processes.push(proc.child)
    expect(realpathSync((JSON.parse(await firstLine(proc.child)) as { cwd: string }).cwd)).toBe(realpathSync(work))
    expect(await releasePlace(place, proc, [], { written: 'work' })).toEqual({ reaped: true, written: join('work', 'answer.txt'), removed: true })
    expect(existsSync(place.dir)).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  }, 60_000)

  it('looks for what was written only in the given subfolder, and still removes the whole place', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    mkdirSync(join(place.dir, 'home', '.cache'), { recursive: true })
    writeFileSync(join(place.dir, 'home', '.cache', 'vendor.db'), 'cache')
    mkdirSync(join(place.dir, 'work', 'empty'), { recursive: true })
    await expect(releasePlace(place, undefined, [], { written: join('..', 'elsewhere') })).rejects.toThrow('inside the place')
    expect(await releasePlace(place, undefined, [], { written: 'work' })).toEqual({ reaped: true, removed: true })
    expect(existsSync(place.dir) || existsSync(place.ledgerPath)).toBe(false)

    const unscoped = reservePlace(profile, META)
    mkdirSync(join(unscoped.dir, 'home'))
    writeFileSync(join(unscoped.dir, 'home', 'vendor.db'), 'cache')
    expect(await releasePlace(unscoped, undefined)).toMatchObject({ written: join('home', 'vendor.db'), removed: true })
  })

  it('removes a link or junction inside the place without touching what it points at', async () => {
    const profile = tempDir()
    const outside = join(tempDir(), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const place = reservePlace(profile, META)
    mkdirSync(join(place.dir, 'nested'))
    symlinkSync(outside, join(place.dir, 'nested', 'link'), 'junction')
    expect(await releasePlace(place, undefined)).toMatchObject({ reaped: true, removed: true })
    expect(existsSync(place.dir)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')

    const left = leftBehind(profile, { state: 'stopping' })
    symlinkSync(outside, join(left.dir, 'link'), 'junction')
    expect((await sweepPlaces(profile, [], later())).removed).toEqual([left.id])
    expect(existsSync(left.dir)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.each([
    ['another folder', (dir: string, _outside: string) => mkdirSync(dir)],
    ['a junction to an outside folder', (dir: string, outside: string) => symlinkSync(outside, dir, 'junction')]
  ])('keeps a place folder swapped for %s', async (_name, swap) => {
    const profile = tempDir()
    const outside = join(tempDir(), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const place = reservePlace(profile, META)
    rmSync(place.dir, { recursive: true })
    swap(place.dir, outside)
    writeFileSync(join(place.dir, 'other.txt'), 'other')
    expect(await releasePlace(place, undefined)).toMatchObject({ reaped: true, removed: false })
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: place.id, reason: 'not_owned' }] })
    expect(readFileSync(join(place.dir, 'other.txt'), 'utf8')).toBe('other')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(place.ledgerPath)).toBe(true)
  })

  it('keeps the record when the place cannot be removed, and the sweep finishes the job', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    writeFileSync(join(place.dir, 'answer.txt'), 'x')
    placesFs.rmdir = (path) => { throw Object.assign(new Error(`busy: ${path}`), { code: 'EBUSY' }) }
    expect(await releasePlace(place, undefined)).toEqual({ reaped: true, written: 'answer.txt', removed: false })
    expect(ledgerOf(place.ledgerPath).state).toBe('reaped')
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: place.id, reason: 'remove_failed' }] })
    Object.assign(placesFs, originalFs)
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [place.id], kept: [] })
    expect(existsSync(place.dir) || existsSync(place.ledgerPath)).toBe(false)
  })

  it('refuses a place whose paths are not the ones its profile and id give', async () => {
    const profile = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const place = reservePlace(profile, META)
    const forged: Place[] = [{ ...place, dir: outside }, { ...place, id: 'not-a-uuid', dir: join(profile, 'one-shot', 'not-a-uuid') }]
    for (const bad of forged) await expect(releasePlace(bad, undefined)).rejects.toThrow('Not a place')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    await releasePlace(place, undefined)
  })

  it('removes only leftovers that still prove to be the place\'s, never through a link', async () => {
    const profile = tempDir()
    const sessions = join(tempDir(), 'sessions')
    const target = join(tempDir(), 'target')
    mkdirSync(sessions)
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const place = reservePlace(profile, META)
    const session = (name: string, text: string) => {
      writeFileSync(join(sessions, name), text)
      return join(sessions, name)
    }
    const rule: LeftoverRule = {
      kind: 'vendor-session',
      allows: (path) => path.startsWith(sessions),
      owns: (path, proof) => lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8').includes(proof)
    }
    const owned = session('owned.db', `cwd=${place.dir}`)
    const unrelated = session('unrelated.db', 'cwd=somewhere else')
    const link = join(sessions, 'linked')
    symlinkSync(target, link, 'junction')
    for (const path of [owned, unrelated, link]) addLeftover(place, { kind: 'vendor-session', path, proof: place.dir })
    expect(ledgerOf(place.ledgerPath).leftovers).toHaveLength(3)
    expect(await releasePlace(place, undefined, [rule])).toMatchObject({ removed: true })
    expect({ owned: existsSync(owned), unrelated: existsSync(unrelated), link: existsSync(link) }).toEqual({ owned: false, unrelated: true, link: false })
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('keeps a record whose leftover the rules do not allow, deleting nothing', async () => {
    const profile = tempDir()
    const elsewhere = join(tempDir(), 'important.txt')
    writeFileSync(elsewhere, 'keep')
    const place = reservePlace(profile, META)
    addLeftover(place, { kind: 'vendor-session', path: elsewhere, proof: place.dir })
    const rule: LeftoverRule = { kind: 'vendor-session', allows: () => false, owns: () => true }
    expect(await releasePlace(place, undefined, [rule])).toMatchObject({ reaped: true, removed: false })
    expect(await releasePlace(place, undefined, [])).toMatchObject({ removed: false })
    expect(existsSync(elsewhere) && existsSync(place.dir) && existsSync(place.ledgerPath)).toBe(true)
    expect((await sweepPlaces(profile, [rule], later())).kept).toEqual([{ id: place.id, reason: 'malformed' }])
    expect((await sweepPlaces(profile, [], later())).kept).toEqual([{ id: place.id, reason: 'not_owned' }])
  })
})

describe('sweepPlaces', () => {
  it('runs on a profile with leftovers alone, no request needed', async () => {
    const profile = tempDir()
    const ended = leftBehind(profile, { state: 'stopping', tree: treeOf(await deadPid()) }, { file: 'answer.txt' })
    const orphan = join(profile, 'one-shot', randomUUID())
    mkdirSync(orphan)
    const report = await sweepPlaces(profile, [], later())
    expect(report.removed.sort()).toEqual([ended.id, basename(orphan)].sort())
    expect(readdirSync(join(profile, 'one-shot'))).toEqual([])
    expect(readdirSync(join(profile, 'one-shot-ledger'))).toEqual([])
  })

  // What a daemon killed at each step leaves; `now` is right after, `later` is past the leftover age.
  const killedDaemon: { name: string; record: (dead: number) => Partial<PlaceRecord>; options?: { file?: string; folder?: boolean }; now: 'young' | 'removed' }[] = [
    { name: 'killed before spawn', record: () => ({ state: 'reserved' }), now: 'young' },
    { name: 'killed during spawn (no tree recorded yet)', record: () => ({ state: 'reserved' }), options: { file: 'partial.json' }, now: 'young' },
    { name: 'killed after the folder was made but before its identity was recorded', record: () => ({ state: 'reserved', dir: undefined }), now: 'young' },
    { name: 'killed after the answer (stopping, tree gone)', record: (dead) => ({ state: 'stopping', tree: treeOf(dead) }), options: { file: 'answer.txt' }, now: 'removed' },
    { name: 'killed after reaping', record: (dead) => ({ state: 'reaped', tree: treeOf(dead) }), now: 'removed' },
    { name: 'killed after removing the place', record: (dead) => ({ state: 'removed', tree: treeOf(dead) }), options: { folder: false }, now: 'removed' }
  ]
  it.each(killedDaemon)('$name', async ({ record, options, now }) => {
    const profile = tempDir()
    const left = leftBehind(profile, record(await deadPid()), options)
    expect(await sweepPlaces(profile)).toEqual(now === 'young' ? { removed: [], kept: [{ id: left.id, reason: 'young' }] } : { removed: [left.id], kept: [] })
    if (now === 'young') {
      expect(existsSync(left.dir) && existsSync(left.ledger)).toBe(true)
      expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [left.id], kept: [] })
    }
    expect(existsSync(left.dir) || existsSync(left.ledger)).toBe(false)
  })

  it('keeps a place whose recorded tree still runs, and never signals that pid (it may be reused)', async () => {
    const profile = tempDir()
    const pid = unrelatedProcess()
    const left = leftBehind(profile, { state: 'running', tree: treeOf(pid) }, { file: 'answer.txt' })
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: left.id, reason: 'running' }] })
    expect(alive(pid)).toBe(true)
    expect(existsSync(join(left.dir, 'answer.txt'))).toBe(true)
  })

  it.runIf(win)('after a daemon dies mid-request the kernel ends the tree with the supervisor, and the sweep then removes the place', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    const proc = spawnInPlace(place, launch(script(AGENT_WITH_GRANDCHILD)))
    processes.push(proc.child)
    const pids = JSON.parse(await firstLine(proc.child)) as { agent: number; grandchild: number }
    strayPids.push(pids.agent, pids.grandchild)
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: place.id, reason: 'live' }] })

    // Another Mousse's view: the same record, not live there.
    const other = tempDir()
    const supervisorPid = proc.child.pid!
    const left = leftBehind(other, { state: 'running', tree: { kind: 'win_job', supervisorPid } }, { file: 'session.json' })
    expect(await sweepPlaces(other, [], later())).toEqual({ removed: [], kept: [{ id: left.id, reason: 'running' }] })

    process.kill(supervisorPid, 'SIGKILL')
    expect(await waitFor(() => !alive(supervisorPid))).toBe(true)
    expect(await waitFor(() => !alive(pids.agent) && !alive(pids.grandchild))).toBe(true)
    expect(await sweepPlaces(other, [], later())).toEqual({ removed: [left.id], kept: [] })
    expect(existsSync(left.dir) || existsSync(left.ledger)).toBe(false)
    await releasePlace(place, proc)
  }, 60_000)

  const malformed: [string, (id: string, good: PlaceRecord) => string][] = [
    ['not JSON', () => '{"v":1,'],
    ['an unknown field (a title)', (_id, good) => JSON.stringify({ ...good, title: 'Fix the login bug' })],
    ['an id that is not the file name', (_id, good) => JSON.stringify({ ...good, id: randomUUID() })],
    ['another version', (_id, good) => JSON.stringify({ ...good, v: 2 })],
    ['an unknown state', (_id, good) => JSON.stringify({ ...good, state: 'gone' })],
    ['process group 1', (_id, good) => JSON.stringify({ ...good, tree: { kind: 'posix_group', pgid: 1 } })],
    ['a relative leftover path', (_id, good) => JSON.stringify({ ...good, leftovers: [{ kind: 'vendor-session', path: '../../x', proof: 'p' }] })]
  ]
  it.each(malformed)('keeps and reports a record with %s, deleting nothing', async (_name, text) => {
    const profile = tempDir()
    const left = leftBehind(profile, { state: 'stopping' }, { file: 'answer.txt' })
    writeFileSync(left.ledger, text(left.id, ledgerOf(left.ledger)))
    for (let pass = 0; pass < 2; pass++) expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: left.id, reason: 'malformed' }] })
    expect(existsSync(join(left.dir, 'answer.txt')) && existsSync(left.ledger)).toBe(true)
  })

  it('removes a uuid-named folder with no record only once old, and leaves unrelated folders and files alone', async () => {
    const profile = tempDir()
    const root = join(profile, 'one-shot')
    const orphan = join(root, randomUUID())
    const unrelated = join(root, 'session-from-another-tool')
    const upper = join(root, randomUUID().toUpperCase())
    for (const dir of [orphan, unrelated, upper]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'file.txt'), 'x')
    }
    mkdirSync(join(profile, 'one-shot-ledger'))
    writeFileSync(join(profile, 'one-shot-ledger', 'notes.json'), '{}')
    expect(await sweepPlaces(profile)).toEqual({ removed: [], kept: [{ id: basename(orphan), reason: 'young' }] })
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [basename(orphan)], kept: [] })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(unrelated, 'file.txt')) && existsSync(join(upper, 'file.txt'))).toBe(true)
    expect(existsSync(join(profile, 'one-shot-ledger', 'notes.json'))).toBe(true)
  })

  it('skips a place live in this process', async () => {
    const profile = tempDir()
    const place = reservePlace(profile, META)
    expect(await sweepPlaces(profile, [], later())).toEqual({ removed: [], kept: [{ id: place.id, reason: 'live' }] })
    expect(existsSync(place.dir)).toBe(true)
    await releasePlace(place, undefined)
  })
})

describe.skipIf(win)('the POSIX watcher', () => {
  it('kills the whole group once its pipe closes, then reports it empty', async () => {
    const leader = spawn(process.execPath, [script(AGENT_WITH_GRANDCHILD)], { stdio: ['ignore', 'pipe', 'pipe'], detached: !win })
    processes.push(leader)
    const pids = JSON.parse(await firstLine(leader)) as { agent: number; grandchild: number }
    strayPids.push(pids.grandchild)
    const watcher = spawn(process.execPath, ['-e', PLACE_WATCHER, String(leader.pid)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', detached: !win })
    processes.push(watcher)
    let said = ''
    watcher.stdout.on('data', (chunk: Buffer) => { said += chunk.toString() })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(pids.grandchild)).toBe(true)
    watcher.stdin.destroy()
    expect(await waitFor(() => said.includes('empty'))).toBe(true)
    expect(alive(pids.grandchild)).toBe(false)
    let probe = 'alive'
    try { process.kill(-leader.pid!, 0) } catch (error) { probe = (error as NodeJS.ErrnoException).code ?? 'error' }
    expect(probe).toBe('ESRCH')
  })
})
