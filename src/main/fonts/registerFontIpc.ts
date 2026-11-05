import { app, ipcMain, net } from 'electron'
import { join } from 'node:path'
import { isSafeFontFamily, type FontRole, type LoadedGoogleFont } from '../../shared/fontSettings'
import { GoogleFontCache } from './googleFontCache'

let cache: GoogleFontCache | undefined

/**
 * `fonts:loadGoogle(family, role, download)`: a Google Fonts family's files from the cache under
 * the app data folder. Fetches from Google only when `download` is true, which the font picker
 * sets when the user chooses the family; startup reads the cache alone.
 */
export function registerFontIpc(): void {
  ipcMain.removeHandler('fonts:loadGoogle')
  ipcMain.handle('fonts:loadGoogle', async (_event, family: unknown, role: unknown, download: unknown): Promise<LoadedGoogleFont | null> => {
    if (!isSafeFontFamily(family)) throw new Error('Unknown font family.')
    if (role !== 'interface' && role !== 'code') throw new Error('Unknown font role.')
    cache ??= new GoogleFontCache({
      root: join(app.getPath('userData'), 'fonts', 'google'),
      fetch: (url, init) => net.fetch(url, init)
    })
    return cache.load(family, role as FontRole, download === true)
  })
}
