import { afterEach, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { getExternalResourceClaims, getExternalResourceClaimsFromFacts } from '../src/mms/lifecycle/LifecycleClaims'
import { OwnershipFacts } from '../src/mms/lifecycle/ResourceInventory'
import { ownedHome } from './support/fixtureGit'

// The ownership pass behind hourly storage cleanup read every thread's records in one synchronous stretch: with about
// 1,200 threads that held the service's main thread for 15 s at a time, and under load past the minute after which the
// app replaces a service that does not answer, ending every running turn.

const roots: string[] = []
const undo: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const release of undo.splice(0)) release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profileWithThreads(count: number) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-claims-yield-'))
  roots.push(root)
  const home = join(root, 'profile')
  mkdirSync(home, { recursive: true })
  undo.push(ownedHome(home))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home })
  for (let i = 0; i < count; i++) {
    const id = `task-${i}`
    const location = join(home, 'thread-data', id)
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'meta.json'), JSON.stringify({ id }))
    writeFileSync(join(location, 'messages.json'), '[]')
    store.registerTask({ taskId: id, location })
  }
  return { home, store }
}

/** Counts the event loop's turns until `stop` is called; a pass that never lets it run counts none. */
function loopTurns() {
  let turns = 0
  let stopped = false
  const tick = (): void => { if (stopped) return; turns++; setImmediate(tick) }
  setImmediate(tick)
  return { stop: () => { stopped = true; return turns } }
}

/** Every slice of a yielding pass is used up at once, so it hands the loop a turn at each step it can. */
function everySliceUsedUp(): void {
  const real = performance.now.bind(performance)
  let skew = 0
  vi.spyOn(performance, 'now').mockImplementation(() => real() + (skew += 1_000))
}

test('the pass over every thread lets the service answer between threads, and finds the same claims as the pass that may not wait', async () => {
  const threads = 40
  const { store } = profileWithThreads(threads)
  // Facts already read, as a later round has them: the pass then has nothing of its own to wait for.
  const facts = new OwnershipFacts()
  await getExternalResourceClaims(store, new Set(), facts)
  everySliceUsedUp()
  const turns = loopTurns()
  const claims = await getExternalResourceClaims(store, new Set(), facts)
  // At least one turn per thread inventoried, and more for the folders scanned before.
  expect(turns.stop()).toBeGreaterThanOrEqual(threads)
  const ids = (list: Array<{ id: string }>) => list.map((claim) => claim.id).sort()
  expect(claims.length).toBeGreaterThanOrEqual(threads)
  expect(ids(claims)).toEqual(ids(getExternalResourceClaimsFromFacts(store, new Set(), facts)))
})

test('a thread folder no record owns still refuses when it is found between turns', async () => {
  const { home, store } = profileWithThreads(20)
  const stray = join(home, 'thread-data', 'stray')
  mkdirSync(stray, { recursive: true })
  writeFileSync(join(stray, 'meta.json'), JSON.stringify({ id: 'stray' }))
  everySliceUsedUp()
  const turns = loopTurns()
  await expect(getExternalResourceClaims(store, new Set())).rejects.toThrow(/thread data it does not keep track of/)
  expect(turns.stop()).toBeGreaterThan(0)
  expect(() => getExternalResourceClaimsFromFacts(store, new Set(), new OwnershipFacts())).toThrow(/thread data it does not keep track of/)
})
