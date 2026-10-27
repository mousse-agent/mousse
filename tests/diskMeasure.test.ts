import { afterEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { measureTree, skipKey } from '../src/mms/lifecycle/diskMeasure'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'mousse-measure-')); roots.push(root); return root }
const posix = process.platform !== 'win32'

describe('measureTree', () => {
  it('reclaim does not count a file that also has a hard link outside the tree', async () => {
    const root = temp(); mkdirSync(join(root, 'tree'))
    writeFileSync(join(root, 'outside.txt'), 'x'.repeat(8192)); linkSync(join(root, 'outside.txt'), join(root, 'tree', 'linked.txt'))
    writeFileSync(join(root, 'tree', 'own.txt'), 'y'.repeat(8192))
    const reclaim = await measureTree(join(root, 'tree'), { mode: 'reclaim', budgetMs: 5000 })
    expect(reclaim.files).toBe(1)
    expect(reclaim.bytes).toBeGreaterThan(0)
    expect((await measureTree(join(root, 'tree'), { mode: 'usage', budgetMs: 5000 })).files).toBe(2)
  })

  it('usage counts two links inside the tree once and records only multi-link inodes', async () => {
    const root = temp(); mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'a', 'one.txt'), 'x'.repeat(8192)); linkSync(join(root, 'a', 'one.txt'), join(root, 'b', 'two.txt'))
    for (const name of ['p', 'q', 'r']) writeFileSync(join(root, 'a', name), name.repeat(4096))
    const seen = new Set<string>()
    const usage = await measureTree(root, { mode: 'usage', budgetMs: 5000, seen })
    expect(usage.files).toBe(4)
    expect(seen.size).toBe(1)
    // The shared set carries across roots: a second root holding the same inode adds nothing.
    mkdirSync(join(root, 'c')); linkSync(join(root, 'a', 'one.txt'), join(root, 'c', 'three.txt'))
    expect((await measureTree(join(root, 'c'), { mode: 'usage', budgetMs: 5000, seen })).files).toBe(0)
    expect((await measureTree(join(root, 'c'), { mode: 'usage', budgetMs: 5000 })).files).toBe(1)
  })

  it.runIf(posix)('counts allocated blocks, so a sparse file with no data reports 0', async () => {
    const root = temp(); writeFileSync(join(root, 'sparse.bin'), ''); truncateSync(join(root, 'sparse.bin'), 64 * 1024 * 1024)
    writeFileSync(join(root, 'real.txt'), 'x')
    const measured = await measureTree(root, { mode: 'reclaim', budgetMs: 5000 })
    expect(measured.estimated).toBe(false)
    expect(measured.bytes).toBeLessThan(1024 * 1024)
  })

  it('does not follow a symlink or junction', async () => {
    const root = temp(); mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside', 'big.txt'), 'x'.repeat(16384))
    mkdirSync(join(root, 'tree')); symlinkSync(join(root, 'outside'), join(root, 'tree', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await measureTree(join(root, 'tree'), { mode: 'reclaim', budgetMs: 5000 })).files).toBe(0)
    expect((await measureTree(join(root, 'tree', 'link'), { mode: 'reclaim', budgetMs: 5000 })).files).toBe(0)
  })

  it('stops at the budget and says the figure is partial', async () => {
    const root = temp()
    for (let index = 0; index < 6; index++) { mkdirSync(join(root, `d${index}`)); writeFileSync(join(root, `d${index}`, 'f.txt'), 'x') }
    let tick = 0
    const measured = await measureTree(root, { mode: 'reclaim', budgetMs: 25, now: () => (tick += 10) })
    expect(measured.partial).toBe(true)
    expect((await measureTree(root, { mode: 'reclaim', budgetMs: 60_000 })).partial).toBe(false)
  })

  it('reports logical size as an estimate on Windows', async () => {
    const root = temp(); writeFileSync(join(root, 'f.txt'), 'x'.repeat(1000))
    expect(await measureTree(root, { mode: 'reclaim', budgetMs: 5000, platform: 'win32' })).toMatchObject({ bytes: 1000, files: 1, estimated: true, partial: false })
  })

  it('measures a missing root as nothing', async () => {
    expect(await measureTree(join(temp(), 'absent'), { mode: 'reclaim', budgetMs: 5000 })).toEqual({ bytes: 0, files: 0, entries: 0, estimated: false, partial: false, unreadable: 0 })
  })

  it('stops at the entry budget even when the clock never advances, and says why', async () => {
    const root = temp()
    for (let index = 0; index < 30; index++) writeFileSync(join(root, `f${index}.txt`), 'x')
    const measured = await measureTree(root, { mode: 'usage', budgetMs: 60_000, maxEntries: 10, now: () => 0 })
    expect(measured).toMatchObject({ partial: true, stopped: 'entries', entries: 10 })
    expect(measured.files).toBeLessThan(30)
    const whole = await measureTree(root, { mode: 'usage', budgetMs: 60_000, maxEntries: 1000 })
    expect(whole).toMatchObject({ partial: false, files: 30 })
    expect(whole.stopped).toBeUndefined()
  })

  it('leaves out folders named in skip, however the path is cased on Windows', async () => {
    const root = temp(); mkdirSync(join(root, 'keep')); mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'keep', 'a.txt'), 'x'); writeFileSync(join(root, 'other', 'b.txt'), 'x')
    const skip = new Set([skipKey(join(root, 'other'))])
    expect((await measureTree(root, { mode: 'usage', budgetMs: 5000, skip })).files).toBe(1)
    expect((await measureTree(root, { mode: 'usage', budgetMs: 5000 })).files).toBe(2)
    if (process.platform === 'win32') expect(skipKey(join(root, 'OTHER'))).toBe(skipKey(join(root, 'other')))
  })

  it('ignores an entry that disappears during the walk and counts one it cannot read', async () => {
    const root = temp(); writeFileSync(join(root, 'ok.txt'), 'x'); writeFileSync(join(root, 'gone.txt'), 'x'); writeFileSync(join(root, 'locked.txt'), 'x')
    const failing = (names: Record<string, string>) => ({
      readdir: (path: string) => readdir(path),
      lstat: (async (path: string) => {
        const error = names[basename(path)]
        if (error) throw Object.assign(new Error(error), { code: error })
        return lstat(path)
      }) as typeof lstat
    })
    const vanished = await measureTree(root, { mode: 'usage', budgetMs: 5000, fs: failing({ 'gone.txt': 'ENOENT' }) })
    expect(vanished).toMatchObject({ files: 2, unreadable: 0, partial: false })
    const locked = await measureTree(root, { mode: 'usage', budgetMs: 5000, fs: failing({ 'locked.txt': 'EBUSY' }) })
    expect(locked).toMatchObject({ files: 2, unreadable: 1, partial: true })
    expect(locked.stopped).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('sizes a tree whose paths are longer than the classic 260 characters', async () => {
    const root = temp(); let deep = root
    for (let level = 0; level < 8; level++) deep = join(deep, 'segment-'.padEnd(40, 'x') + level)
    mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, 'deep.txt'), 'x'.repeat(100))
    expect(deep.length).toBeGreaterThan(300)
    expect(await measureTree(root, { mode: 'usage', budgetMs: 5000 })).toMatchObject({ files: 1, bytes: 100, unreadable: 0, partial: false })
  })
})
