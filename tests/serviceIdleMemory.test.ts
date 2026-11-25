import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdleMemoryTrim, reduceHeap } from '../src/mms/diagnostics/idleMemoryTrim'
import { combineSignals } from '../src/mms/integrations/mcp/abortTimeout'
import { actionsFileCounts, readActions, readActionsCopy, writeActions } from '../src/mms/actions/actionsFile'
import type { ThreadAction } from '../src/shared/threadActions'

const MB = 1024 * 1024

describe('the idle heap trim', () => {
  function trim(state: { turns: number; t: number; totalMb: number; usedMb: number; fails?: boolean }) {
    const reduce = vi.fn(async () => { if (state.fails) throw new Error('no inspector') })
    const subject = new IdleMemoryTrim({
      activeTurns: () => state.turns,
      heap: () => ({ totalBytes: state.totalMb * MB, usedBytes: state.usedMb * MB }),
      reduce,
      now: () => state.t,
      afterMs: 3 * 60_000,
      minGapMs: 15 * 60_000,
      minSlackBytes: 32 * MB,
    })
    return { subject, reduce }
  }

  it('trims a heap with room to give back once no turn has run for a while, and not again soon after', async () => {
    const state = { turns: 0, t: 0, totalMb: 179, usedMb: 112 }
    const { subject, reduce } = trim(state)
    expect(await subject.check()).toBe(false)
    state.t = 2 * 60_000
    expect(await subject.check()).toBe(false)
    state.t = 3 * 60_000
    expect(await subject.check()).toBe(true)
    state.t = 10 * 60_000
    expect(await subject.check()).toBe(false)
    state.t = 18 * 60_000
    expect(await subject.check()).toBe(true)
    expect(reduce).toHaveBeenCalledTimes(2)
  })

  it('waits again for a quiet spell after a turn runs', async () => {
    const state = { turns: 0, t: 0, totalMb: 179, usedMb: 112 }
    const { subject, reduce } = trim(state)
    await subject.check()
    state.t = 2 * 60_000; state.turns = 1
    expect(await subject.check()).toBe(false)
    state.t = 4 * 60_000; state.turns = 0
    expect(await subject.check()).toBe(false)
    state.t = 7 * 60_000
    expect(await subject.check()).toBe(true)
    expect(reduce).toHaveBeenCalledOnce()
  })

  it('leaves a heap with little room alone', async () => {
    const state = { turns: 0, t: 0, totalMb: 140, usedMb: 112 }
    const { subject, reduce } = trim(state)
    await subject.check()
    state.t = 60 * 60_000
    expect(await subject.check()).toBe(false)
    expect(reduce).not.toHaveBeenCalled()
  })

  it('stops trying after a trim fails', async () => {
    const state = { turns: 0, t: 0, totalMb: 179, usedMb: 112, fails: true }
    const { subject, reduce } = trim(state)
    await subject.check()
    state.t = 3 * 60_000
    expect(await subject.check()).toBe(false)
    state.t = 60 * 60_000; state.fails = false
    expect(await subject.check()).toBe(false)
    expect(reduce).toHaveBeenCalledOnce()
    expect(subject.counters).toEqual({ trims: 0, failures: 1 })
  })

  it('runs V8\'s memory-reducing collection in this process', async () => {
    await expect(reduceHeap()).resolves.toBeUndefined()
  })
})

describe('combined abort signals', () => {
  it('aborts with the reason of the source that aborted', () => {
    const lifetime = new AbortController()
    const call = new AbortController()
    const combined = combineSignals([lifetime.signal, undefined, call.signal])
    expect(combined.aborted).toBe(false)
    call.abort('stop')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('stop')
    expect(combineSignals([AbortSignal.abort('gone')]).reason).toBe('gone')
  })

  it('adds nothing to a long-lived source for each call', () => {
    // An MCP connection's lifetime sees one combined signal per tool call and HTTP request for as long as it runs.
    const lifetime = new AbortController()
    for (let call = 0; call < 1000; call++) combineSignals([lifetime.signal, new AbortController().signal])
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0)
  })
})

describe('the actions file', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  function threadDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-actions-'))
    dirs.push(dir)
    return dir
  }
  const actions = [{ id: 'a1', kind: 'turn', text: 'x'.repeat(10_000) }, { id: 'a2', kind: 'turn', text: 'second' }] as unknown as ThreadAction[]

  it('skips a write that leaves the bytes as they are, and makes one that changes them', () => {
    const dir = threadDirectory()
    writeActions(dir, actions)
    readActions(dir)
    const writes = actionsFileCounts.writes
    writeActions(dir, structuredClone(actions))
    expect(actionsFileCounts.writes).toBe(writes)
    writeActions(dir, [...actions, { id: 'a3', kind: 'turn', text: 'third' } as unknown as ThreadAction])
    expect(actionsFileCounts.writes).toBe(writes + 1)
    expect(readActions(dir).map((action) => (action as unknown as { id: string }).id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('gives a copy the caller may change without changing the cached actions', () => {
    const dir = threadDirectory()
    writeActions(dir, actions)
    const shared = readActions(dir)
    const reads = actionsFileCounts.reads
    const copy = readActionsCopy(dir)
    expect(actionsFileCounts.reads).toBe(reads)
    ;(copy[0] as unknown as { text: string }).text = 'changed'
    copy.pop()
    expect(readActions(dir)).toBe(shared)
    expect(readActions(dir)).toEqual(actions)
  })
})
