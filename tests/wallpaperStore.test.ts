/**
 * The profile's wallpaper store on a real folder: what it keeps, what it refuses, and what it removes.
 *
 * Inputs listed first (test-the-claim §4):
 * - sources: a PNG, the same PNG again, a link (junction or symlink) to it, a folder, a missing file, a text file, a
 *   file over 32 MB, a relative path, a network share, a device path or name;
 * - store states: empty, the image stored, a copy stored, an old unused image, an old temporary file, an unknown file,
 *   the store folder replaced by a link elsewhere, a link planted inside the store;
 * - actors and orders: a re-choice while collection runs, a second copy for the same size, a replacement copy.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync as readdir, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sourcePathRefusal, WallpaperRefused, WallpaperStore, WALLPAPER_UNUSED_KEEP_MS } from '../src/mms/appearance/WallpaperStore'
import { WALLPAPER_REFUSED } from '../src/shared/themes/wallpaperImage'
import { pngHeader, webpLossy } from './fixtures/wallpaperBytes'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-wallpapers-'))
  folders.push(root)
  const home = join(root, 'profile')
  const files = join(root, 'files')
  mkdirSync(home)
  mkdirSync(files)
  const image = pngHeader(5120, 2880, 64)
  const source = join(files, 'goku.png')
  writeFileSync(source, image)
  const id = createHash('sha256').update(image).digest('hex')
  return { root, home, files, image, source, id, store: new WallpaperStore(home) }
}

/** Links a folder: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

const old = (path: string) => {
  const then = new Date(Date.now() - WALLPAPER_UNUSED_KEEP_MS - 60_000)
  utimesSync(path, then, then)
}

describe('WallpaperStore', () => {
  it('keeps its own copy named by the image\'s sha-256, so the source can move; choosing it again keeps one file and makes it young', async () => {
    const { store, source, image, id, home } = setup()
    expect(await store.importFile(source)).toEqual({ id, type: 'image/png', width: 5120, height: 2880 })
    const kept = join(home, 'wallpapers', `${id}.png`)
    expect(readFileSync(kept)).toEqual(image)
    rmSync(source)
    expect((await store.read(id, undefined, 0, 1024 * 1024))?.data).toEqual(image)

    writeFileSync(source, image)
    old(kept)
    await store.importFile(source)
    expect(Date.now() - statSync(kept).mtimeMs).toBeLessThan(60_000)
    expect(await store.collect(new Set())).toBe(0)
    expect(existsSync(kept)).toBe(true)
  })

  it('follows a link to a file on this computer', async () => {
    const { store, files, root, id } = setup()
    const linked = join(root, 'linked')
    linkFolder(files, linked)
    await expect(store.importFile(join(linked, 'goku.png'))).resolves.toMatchObject({ id })
  })

  it.each([
    ['a folder', (files: string) => files],
    ['a missing file', (files: string) => join(files, 'nope.png')],
    ['a text file', (files: string) => { writeFileSync(join(files, 'notes.txt'), 'secret'); return join(files, 'notes.txt') }],
    ['an image renamed from SVG', (files: string) => { writeFileSync(join(files, 'x.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>'); return join(files, 'x.png') }],
    ['a relative path', () => 'goku.png']
  ])('refuses %s with the one sentence, and keeps nothing', async (_name, path) => {
    const { store, files, home } = setup()
    const error = await store.importFile(path(files)).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(WallpaperRefused)
    expect((error as Error).message).toBe(WALLPAPER_REFUSED)
    expect(existsSync(join(home, 'wallpapers')) ? readdir(join(home, 'wallpapers')) : []).toEqual([])
  })

  it('refuses a file over 32 MB before reading it', async () => {
    const { store, files } = setup()
    const big = join(files, 'big.png')
    writeFileSync(big, Buffer.concat([pngHeader(100, 100), Buffer.alloc(32 * 1024 * 1024)]))
    await expect(store.importFile(big)).rejects.toBeInstanceOf(WallpaperRefused)
  })

  it('stores an image sent as bytes up to the upload limit, as a theme file carries it', async () => {
    const { store, image, id } = setup()
    await expect(store.importBytes(image)).resolves.toMatchObject({ id })
    await expect(store.importBytes(Buffer.from('not an image'))).rejects.toBeInstanceOf(WallpaperRefused)
  })

  it('reads a stored image piece by piece and nothing else: an unknown id, a malformed id or bucket answers null', async () => {
    const { store, source, image, id } = setup()
    await store.importFile(source)
    const first = await store.read(id, undefined, 0, 10)
    expect(first).toMatchObject({ type: 'image/png', size: image.length, offset: 0 })
    expect(first?.data).toEqual(image.subarray(0, 10))
    expect((await store.read(id, undefined, 10, 1_000_000))?.data).toEqual(image.subarray(10))
    expect(await store.read('0'.repeat(64), undefined, 0, 10)).toBeNull()
    expect(await store.read('../../secret', undefined, 0, 10)).toBeNull()
    expect(await store.read(id.toUpperCase(), undefined, 0, 10)).toBeNull()
    expect(await store.read(id, 1234 as never, 0, 10)).toBeNull()
  })

  it('never reads through a link planted in the store', async () => {
    const { store, source, id, home, files } = setup()
    await store.importFile(source)
    const secret = join(files, 'secret.webp')
    writeFileSync(secret, webpLossy(2560, 1440))
    try {
      symlinkSync(secret, join(home, 'wallpapers', `${id}.c1.w2560.webp`), 'file')
    } catch {
      return // Creating a file symlink needs a privilege on Windows; the identity check is the same code path below.
    }
    expect(await store.read(id, 2560, 0, 100)).toBeNull()
  })

  it('fails closed when the store folder is a link to somewhere else', async () => {
    const { home, root, image } = setup()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    linkFolder(elsewhere, join(home, 'wallpapers'))
    const store = new WallpaperStore(home)
    await expect(store.importBytes(image)).rejects.toThrow()
    expect(readdir(elsewhere)).toEqual([])
  })

  it('keeps a display copy only when it is a WebP of the right size and shape; the first one stays unless replaced', async () => {
    const { store, source, id, home } = setup()
    await store.importFile(source)
    expect(await store.saveCopy(id, 2560, webpLossy(2560, 1600))).toBe(false)
    expect(await store.saveCopy(id, 2560, pngHeader(2560, 1440))).toBe(false)
    expect(await store.saveCopy('0'.repeat(64), 2560, webpLossy(2560, 1440))).toBe(false)
    const first = webpLossy(2560, 1440)
    expect(await store.saveCopy(id, 2560, first)).toBe(true)
    const path = join(home, 'wallpapers', `${id}.c1.w2560.webp`)
    const second = Buffer.concat([webpLossy(2560, 1440), Buffer.from([1])])
    expect(await store.saveCopy(id, 2560, second)).toBe(true)
    expect(readFileSync(path)).toEqual(first)
    expect(await store.saveCopy(id, 2560, second, { replace: true })).toBe(true)
    expect(readFileSync(path)).toEqual(second)
    expect((await store.read(id, 2560, 0, 100))?.type).toBe('image/webp')
  })

  it('removes, at collection, only images no theme uses that were chosen over a week ago, with their copies and old temporary files', async () => {
    const { store, source, id, home, files } = setup()
    await store.importFile(source)
    await store.saveCopy(id, 2560, webpLossy(2560, 1440))
    const otherSource = join(files, 'other.png')
    writeFileSync(otherSource, pngHeader(800, 600, 3))
    const other = (await store.importFile(otherSource)).id
    const youngSource = join(files, 'young.png')
    writeFileSync(youngSource, pngHeader(640, 480, 5))
    const young = (await store.importFile(youngSource)).id
    const folder = join(home, 'wallpapers')
    for (const name of [`${id}.png`, `${id}.c1.w2560.webp`, `${other}.png`]) old(join(folder, name))
    writeFileSync(join(folder, '.tmp-0a1b'), 'partial')
    old(join(folder, '.tmp-0a1b'))
    writeFileSync(join(folder, 'notes.txt'), 'not ours')
    old(join(folder, 'notes.txt'))

    expect(await store.collect(new Set([other]))).toBe(3)
    expect(readdir(folder).sort()).toEqual([`${other}.png`, `${young}.png`, 'notes.txt'].sort())
  })

  it('a full store first drops images no theme uses, however recent, and refuses only when that is not enough', async () => {
    const { home, files, image } = setup()
    const used = new Set<string>()
    const store = new WallpaperStore(home, { used: () => used, maxBytes: image.length * 2 + 10 })
    const write = (name: string, extra: number) => { const path = join(files, name); writeFileSync(path, pngHeader(640, 480, image.length - 33 + extra)); return path }
    const kept = (await store.importFile(write('a.png', 1))).id
    used.add(kept)
    const dropped = (await store.importFile(write('b.png', 2))).id
    // A third image does not fit: b, which no theme uses, goes; a stays.
    await store.importFile(write('c.png', 3))
    expect(existsSync(join(home, 'wallpapers', `${kept}.png`))).toBe(true)
    expect(existsSync(join(home, 'wallpapers', `${dropped}.png`))).toBe(false)
    used.add(readdir(join(home, 'wallpapers')).find((name) => !name.startsWith(kept))!.slice(0, 64))
    await expect(store.importFile(write('d.png', 4))).rejects.toThrow('Too many wallpapers')
  })

  it('refuses the store folder once it is swapped for a link after it was used', async () => {
    const { store, source, home, root, image, id } = setup()
    await store.importFile(source)
    const folder = join(home, 'wallpapers')
    rmSync(folder, { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, `${id}.png`), image)
    linkFolder(elsewhere, folder)
    await expect(store.read(id, undefined, 0, 10)).rejects.toThrow()
    await expect(store.importBytes(image)).rejects.toThrow()
  })

  it('two windows saving a copy of the same size at once leave one whole copy, the first', async () => {
    const { store, source, id, home } = setup()
    await store.importFile(source)
    const first = Buffer.concat([webpLossy(2560, 1440), Buffer.alloc(4096, 1)])
    const second = Buffer.concat([webpLossy(2560, 1440), Buffer.alloc(4096, 2)])
    expect(await Promise.all([store.saveCopy(id, 2560, first), store.saveCopy(id, 2560, second)])).toEqual([true, true])
    expect(readFileSync(join(home, 'wallpapers', `${id}.c1.w2560.webp`))).toEqual(first)
  })

  it('a choice made while collection is pending is never removed by it', async () => {
    const { store, source, id, home } = setup()
    await store.importFile(source)
    old(join(home, 'wallpapers', `${id}.png`))
    const chosen = store.importFile(source)
    const collected = store.collect(new Set())
    await Promise.all([chosen, collected])
    expect(existsSync(join(home, 'wallpapers', `${id}.png`))).toBe(true)
  })
})

describe('sourcePathRefusal', () => {
  it.each([
    ['C:\\Users\\me\\Pictures\\goku.png', false, null],
    ['C:/Users/me/Pictures/goku.png', false, null],
    ['\\\\host\\share\\x.png', false, 'a network path'],
    ['//host/share/x.png', false, 'a network path'],
    ['\\\\host\\share\\x.png', true, null],
    ['\\\\?\\C:\\x.png', true, 'a device path'],
    ['\\\\.\\pipe\\x', true, 'a device path'],
    ['\\??\\C:\\x.png', true, 'a device path'],
    ['C:\\Users\\me\\CON', false, 'a device name'],
    ['C:\\Users\\me\\nul.png', false, 'a device name'],
    ['C:\\Users\\me\\COM1.jpg', false, 'a device name'],
    ['C:\\Users\\me\\LPT\u00b9.png', false, 'a device name'],
    ['C:\\Users\\me\\CONOUT$', false, 'a device name'],
    ['C:\\aux\\x.png', false, 'a device name'],
    ['C:\\Users\\me\\console.png', false, null],
    ['goku.png', false, 'not an absolute path'],
    ['\\Users\\me\\goku.png', false, 'not an absolute path']
  ])('on Windows, %s (network allowed: %s) → %s', (path, network, refusal) => {
    expect(sourcePathRefusal(path, { network, platform: 'win32' })).toBe(refusal)
  })

  it.each([
    ['/home/me/goku.png', null],
    ['goku.png', 'not an absolute path'],
    ['/home/me/\0x.png', 'not a path']
  ])('elsewhere, %s → %s', (path, refusal) => {
    expect(sourcePathRefusal(path, { network: false, platform: 'linux' })).toBe(refusal)
  })
})
