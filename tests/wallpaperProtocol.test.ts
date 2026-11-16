/**
 * The wallpaper calls through the daemon's dispatcher: only a Mousse window on this computer may make them, a call made
 * for another profile than the window's is refused, and a refused file says the one sentence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WallpaperStore } from '../src/mms/appearance/WallpaperStore'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { WALLPAPER_REFUSED } from '../src/shared/themes/wallpaperImage'
import { pngHeader, webpLossy } from './fixtures/wallpaperBytes'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-wallpaper-protocol-'))
  folders.push(root)
  mkdirSync(join(root, 'profile'))
  const source = join(root, 'wall.png')
  const image = pngHeader(5120, 2880, 32)
  writeFileSync(source, image)
  const wallpapers = new WallpaperStore(join(root, 'profile'))
  const call = (clientType: 'gui' | 'cli' | 'bridge', method: string, params: object) =>
    dispatchMethod({ mms: { wallpapers, profileId: 'p1' } as never, globalSequence: () => 0, connection: { clientType } as never }, method, params)
  return { source, image, call }
}

describe('appearance.wallpaper* protocol methods', () => {
  it('a window stores a picked file, reads it back in pieces and keeps a display copy', async () => {
    const { source, image, call } = setup()
    const { wallpaper } = await call('gui', 'appearance.wallpaperImport', { path: source, expectedProfileId: 'p1' }) as { wallpaper: { id: string } }
    expect(wallpaper).toMatchObject({ type: 'image/png', width: 5120, height: 2880 })
    const piece = await call('gui', 'appearance.wallpaperRead', { id: wallpaper.id, offset: 0 }) as { data: string; size: number; type: string }
    expect(piece).toMatchObject({ type: 'image/png', size: image.length })
    expect(Buffer.from(piece.data, 'base64')).toEqual(image)
    expect(await call('gui', 'appearance.wallpaperRead', { id: wallpaper.id, bucket: 2560 })).toEqual({ missing: true })
    const copy = webpLossy(2560, 1440).toString('base64')
    expect(await call('gui', 'appearance.wallpaperSaveCopy', { id: wallpaper.id, bucket: 2560, dataBase64: copy })).toEqual({ saved: true })
    expect(await call('gui', 'appearance.wallpaperRead', { id: wallpaper.id, bucket: 2560 })).toMatchObject({ type: 'image/webp' })
  })

  it.each(['cli', 'bridge'] as const)('refuses a %s connection: wallpapers are for a window on this computer', async (clientType) => {
    const { source, call } = setup()
    await expect(call(clientType, 'appearance.wallpaperImport', { path: source })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(clientType, 'appearance.wallpaperRead', { id: '0'.repeat(64) })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses a call made for another profile than the window shows now', async () => {
    const { source, call } = setup()
    await expect(call('gui', 'appearance.wallpaperImport', { path: source, expectedProfileId: 'p2' })).rejects.toMatchObject({ code: 'profile_mismatch' })
  })

  it('a file that cannot be used gets the one sentence; malformed uploads and buckets are refused before decoding', async () => {
    const { call } = setup()
    await expect(call('gui', 'appearance.wallpaperImport', { path: join(tmpdir(), 'no-such-wallpaper.png') })).rejects.toMatchObject({ code: 'invalid_params', message: WALLPAPER_REFUSED })
    await expect(call('gui', 'appearance.wallpaperImportBytes', { dataBase64: 'not base64!' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('gui', 'appearance.wallpaperImportBytes', { dataBase64: 'A'.repeat(6_000_000) })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('gui', 'appearance.wallpaperRead', { id: '0'.repeat(64), bucket: 1000 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('gui', 'appearance.wallpaperSaveCopy', { id: '0'.repeat(64), bucket: 2560, dataBase64: webpLossy(2560, 1440).toString('base64') })).resolves.toEqual({ saved: false })
  })
})
