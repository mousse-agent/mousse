/**
 * The warm start file: what a profile's window showed (its lists, the open thread and that thread's newest messages),
 * written in the background and read once at the next launch.
 */
import { promises as fsp } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WarmStartCache, type WarmStartFs } from '../src/main/warmStartCache'

let dir: string
let file: string
/** The file system as main uses it, counting each write. */
let writes: number
let failRename: boolean
const fs: WarmStartFs = {
  readFile: (path, encoding) => fsp.readFile(path, encoding),
  writeFile: (path, data, encoding) => { writes += 1; return fsp.writeFile(path, data, encoding) },
  rename: (from, to) => failRename ? Promise.reject(new Error('EPERM: file in use')) : fsp.rename(from, to),
  rm: (path, options) => fsp.rm(path, options)
}
const log = vi.fn()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warm-start-'))
  file = join(dir, 'warm-start.json')
  writes = 0
  failRename = false
  log.mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const thread = (id: string) => ({ id, name: `Thread ${id}`, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' })
const message = (id: string, content = id) => ({ id, role: 'assistant', content, timestamp: '2026-11-20T00:00:00Z' })
const profile = { id: 'prf_a', displayName: 'Work', color: '#336699' } as never

/** What main sends a window bound to `profileId` as it opens on thread `t1`. */
function showWindow(cache: WarmStartCache, profileId = 'prf_a', messages = [message('m1'), message('m2')]): void {
  cache.noteProfile(profileId, profileId === 'prf_a' ? profile : undefined)
  cache.observe(profileId, 'projects:updated', [{ id: 'p1', name: 'Mousse' }])
  cache.observe(profileId, 'threads:updated', { threads: [thread('t1'), thread('t2')], version: { epoch: 'e', seq: 1, generation: 1 } })
  cache.observe(profileId, 'thread:selected', { id: 't1' })
  cache.observe(profileId, 'thread:view', { threadId: 't1', messages, agents: [], tasks: [] })
}

describe('the warm start file', () => {
  it('shows at the next launch what the last window showed: its profile, lists, open thread and newest messages', async () => {
    const cache = new WarmStartCache(file, { fs, log })
    showWindow(cache)
    // A reply that lands in the open thread, and one that is still being written.
    cache.observe('prf_a', 'orchestrator:thread-message', { threadId: 't1', message: message('m3', 'Done') })
    cache.observe('prf_a', 'orchestrator:thread-message-updated', { threadId: 't1', message: message('m3', 'Done, all tests pass') })
    // Another thread's messages are not the open thread's.
    cache.observe('prf_a', 'orchestrator:thread-message', { threadId: 't2', message: message('other') })
    await cache.flush()

    const next = new WarmStartCache(file, { fs, log })
    expect(await next.view()).toEqual({
      profileId: 'prf_a',
      profile,
      threads: [thread('t1'), thread('t2')],
      projects: [{ id: 'p1', name: 'Mousse' }],
      activeThreadId: 't1',
      messages: [message('m1'), message('m2'), message('m3', 'Done, all tests pass')]
    })
    expect(next.lastActiveThread('prf_a')).toBe('t1')
  })

  it('keeps the threads\' settled states and the projects\' icons, within their limits', async () => {
    const cache = new WarmStartCache(file, { fs, log })
    showWindow(cache)
    // Done and Input are kept; Working, Waiting and Paused show nothing until the service says so.
    cache.observe('prf_a', 'threads:activity', { t1: 'completed', t2: 'processing', t3: 'awaiting_input', t4: 'waiting', t5: 'paused', t6: 'idle' })
    const icon = (n: number) => ({ dataUrl: `data:image/png;base64,${n}` })
    // A project without an icon is kept as such (its folder shows); one too large is left out (read when connected).
    cache.noteProjectIcon('prf_a', 'none', null)
    cache.noteProjectIcon('prf_a', 'large', { dataUrl: `data:image/png;base64,${'A'.repeat(70 * 1024)}` })
    for (let n = 0; n < 70; n += 1) cache.noteProjectIcon('prf_a', `p${n}`, icon(n))
    cache.noteAppInfo('prf_a', { platform: 'win32', repoRoot: 'C:/code', llmProvider: 'claude-subscription', deviceName: 'PC' })
    await cache.flush()

    const view = await new WarmStartCache(file, { fs, log }).view()
    expect(view?.activity).toEqual({ t1: 'completed', t3: 'awaiting_input' })
    const icons = view?.projectIcons ?? {}
    expect(icons.large).toBeUndefined()
    // At most 64, the most recently read.
    expect(Object.keys(icons)).toHaveLength(64)
    expect(icons.p69).toEqual(icon(69))
    expect(icons.p5).toBeUndefined()
    expect(view?.appInfo).toEqual({ platform: 'win32', repoRoot: 'C:/code', llmProvider: 'claude-subscription', deviceName: 'PC' })
  })

  it('shows the profile a window was bound to last, and forgets a transcript when another thread opens', async () => {
    const cache = new WarmStartCache(file, { fs, log })
    showWindow(cache, 'prf_a')
    showWindow(cache, 'prf_b')
    cache.observe('prf_b', 'thread:selected', { id: 't2' })
    await cache.flush()
    const view = await new WarmStartCache(file, { fs, log }).view()
    expect(view).toMatchObject({ profileId: 'prf_b', activeThreadId: 't2', messages: [] })
  })

  it('forgets a profile that was archived or removed, even when its last updates arrive after', async () => {
    const cache = new WarmStartCache(file, { fs, log })
    showWindow(cache, 'prf_b')
    showWindow(cache, 'prf_a')
    await cache.flush()
    const next = new WarmStartCache(file, { fs, log })
    next.forget('prf_a')
    next.observe('prf_a', 'threads:updated', [thread('late')])
    await next.flush()
    const view = await new WarmStartCache(file, { fs, log }).view()
    expect(view).toBeNull()
    expect(JSON.parse(await readFile(file, 'utf8')).profiles.map(([id]: [string]) => id)).toEqual(['prf_b'])
  })

  it('is written once updates settle, not on each update, and at least every 20 seconds while they keep coming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Writes are counted in memory here, so the count is about timing alone.
    const memory: WarmStartFs = {
      readFile: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      writeFile: async () => { writes += 1 },
      rename: async () => undefined,
      rm: async () => undefined
    }
    const cache = new WarmStartCache(file, { fs: memory, log })
    showWindow(cache)
    // A reply streams for 30 seconds: an update every half second.
    for (let at = 0; at < 30_000; at += 500) {
      cache.observe('prf_a', 'orchestrator:thread-message-updated', { threadId: 't1', message: message('m2', `part ${at}`) })
      await vi.advanceTimersByTimeAsync(500)
    }
    await cache.flush()
    // 60 updates: one write at the 20-second mark, and the rest at the end.
    expect(writes).toBe(2)
    writes = 0
    cache.observe('prf_a', 'threads:updated', [thread('t1')])
    await vi.advanceTimersByTimeAsync(1_900)
    expect(writes).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    await cache.flush()
    expect(writes).toBe(1)
  })

  it('writes a thread that turns Done within 2 seconds, while a reply in another thread keeps streaming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // What each write put on disk, in memory: the app may end without quitting (no flush) right after.
    const written: string[] = []
    const memory: WarmStartFs = {
      readFile: () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      writeFile: async (_path, data) => { written.push(data) },
      rename: async () => undefined,
      rm: async () => undefined
    }
    const cache = new WarmStartCache(file, { fs: memory, log })
    showWindow(cache)
    await cache.flush()
    written.length = 0
    const doneOnDisk = () => written.some((text) => JSON.parse(text).profiles[0][1].activity?.t2 === 'completed')
    for (let at = 0; at < 10_000; at += 500) {
      cache.observe('prf_a', 'orchestrator:thread-message-updated', { threadId: 't1', message: message('m2', `part ${at}`) })
      // Thread t2 finishes 3 seconds in; the service pushes every thread's state with each change.
      if (at >= 3_000) cache.observe('prf_a', 'threads:activity', { t1: 'processing', t2: 'completed' })
      await vi.advanceTimersByTimeAsync(500)
      if (at === 4_500) expect(doneOnDisk()).toBe(true)
    }
    // The same states pushed again are not a change: only the streaming reply is still waiting to be written.
    expect(written).toHaveLength(1)
  })

  it('keeps the newest messages within its size, then the most recent profiles', async () => {
    const big = (id: string) => message(id, 'x'.repeat(2_000))
    const cache = new WarmStartCache(file, { fs, log, maxBytes: 30_000, maxMessages: 40 })
    // More profiles than are kept: the last one shown first.
    for (const id of ['prf_1', 'prf_2', 'prf_3', 'prf_4', 'prf_5']) showWindow(cache, id, [])
    showWindow(cache, 'prf_a', Array.from({ length: 60 }, (_, index) => big(`m${index}`)))
    await cache.flush()

    const text = await readFile(file, 'utf8')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(30_000)
    const parsed = JSON.parse(text) as { profiles: Array<[string, unknown]> }
    expect(parsed.profiles.length).toBeLessThanOrEqual(4)
    expect(parsed.profiles[0]![0]).toBe('prf_a')
    const view = await new WarmStartCache(file, { fs, log }).view()
    const ids = view!.messages.map((entry) => entry.id)
    // Fewer than were sent, and the newest of them, in order.
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(40)
    expect(ids.at(-1)).toBe('m59')
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => `m${60 - ids.length + index}`))
  })

  it('never writes a thread list larger than its limit', async () => {
    const cache = new WarmStartCache(file, { fs, log, maxBytes: 2_000 })
    cache.noteProfile('prf_a')
    cache.observe('prf_a', 'threads:updated', Array.from({ length: 100 }, (_, index) => thread(`t${index}`)))
    await cache.flush()
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces the file whole: a write that fails leaves the last one readable and no partial file', async () => {
    const cache = new WarmStartCache(file, { fs, log })
    showWindow(cache)
    await cache.flush()
    failRename = true
    cache.observe('prf_a', 'thread:selected', { id: 't2' })
    await cache.flush()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be written'))
    expect(await readdir(dir)).toEqual(['warm-start.json'])
    expect(await new WarmStartCache(file, { fs, log }).view()).toMatchObject({ activeThreadId: 't1' })
  })

  it('is read once; a missing or damaged file shows nothing', async () => {
    const read = vi.spyOn(fs, 'readFile')
    const missing = new WarmStartCache(file, { fs, log })
    expect(await missing.view()).toBeNull()
    expect(await missing.view()).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()

    await writeFile(file, '{"version":1,"profiles":[["prf_a",{"thr', 'utf8')
    expect(await new WarmStartCache(file, { fs, log }).view()).toBeNull()
    read.mockRestore()
  })

  it('keeps what was shown while the file was still being read', async () => {
    const first = new WarmStartCache(file, { fs, log })
    showWindow(first)
    await first.flush()
    const cache = new WarmStartCache(file, { fs, log })
    // The window is bound and its list arrives before the startup read has finished.
    void cache.load()
    cache.observe('prf_a', 'threads:updated', [thread('t9')])
    await cache.flush()
    expect((await new WarmStartCache(file, { fs, log }).view())?.threads).toEqual([thread('t9')])
  })
})
