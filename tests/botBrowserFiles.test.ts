/**
 * A page in a bot's browser asks for files (the app's main process, `bots:chooseBrowserFiles`): this
 * computer's own open-file dialog names the site that asks and whether it takes one file or several;
 * cancelled, nothing goes; over the limits (16 files, 512 MB in all), or anything that is not a file,
 * a plain refusal and nothing goes; otherwise the paths go to the service on the window's connection,
 * and the renderer gets only the one-time token, never a path. A request that is not one is refused.
 */
import { describe, expect, it, vi } from 'vitest'
import { chooseBotBrowserFiles, type BotBrowserFilesDeps } from '../src/main/ipc/botBrowserFiles'
import { BOT_BROWSER_FILES_LIMIT_TEXT, BOT_BROWSER_FILES_METHOD } from '../src/shared/bots/personal/browser'

const REQUEST = { botId: 'bot-aaaaaaaaaaaa', viewId: 'view-1', holdId: 'hold_1', multiple: false, site: 'upload.example.com' }

function deps(picked: { canceled?: boolean; filePaths?: string[] }, sizes: Record<string, number | 'folder'> = {}) {
  const showOpenDialog = vi.fn(async () => ({ canceled: picked.canceled ?? false, filePaths: picked.filePaths ?? [] }))
  const request = vi.fn(async () => ({ token: 'files_0123456789ab', count: (picked.filePaths ?? []).length }))
  const stat = vi.fn(async (path: string) => {
    const size = sizes[path]
    if (size === undefined) throw new Error('missing')
    return { isFile: () => size !== 'folder', size: size === 'folder' ? 0 : size }
  })
  return { showOpenDialog, request, stat, all: { showOpenDialog, request, stat } as unknown as BotBrowserFilesDeps }
}

describe('a page\'s file picker answered from this computer\'s own dialog', () => {
  it('names the site and how many files it takes, and hands the renderer only a token', async () => {
    const fake = deps({ filePaths: ['/Users/me/note.txt'] }, { '/Users/me/note.txt': 12 })
    expect(await chooseBotBrowserFiles(REQUEST, fake.all)).toEqual({ token: 'files_0123456789ab', count: 1 })
    expect(fake.showOpenDialog).toHaveBeenCalledWith({ title: 'upload.example.com asks for a file', message: 'upload.example.com asks for a file. Only what you choose here goes to the page.', buttonLabel: 'Give to the page', properties: ['openFile'] })
    expect(fake.request).toHaveBeenCalledWith(BOT_BROWSER_FILES_METHOD, { botId: REQUEST.botId, viewId: 'view-1', holdId: 'hold_1', paths: ['/Users/me/note.txt'] })
    const several = deps({ filePaths: [] })
    await chooseBotBrowserFiles({ ...REQUEST, multiple: true }, several.all)
    expect(several.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'upload.example.com asks for files', properties: ['openFile', 'multiSelections'] }))
  })

  it('gives nothing when cancelled', async () => {
    const fake = deps({ canceled: true })
    expect(await chooseBotBrowserFiles(REQUEST, fake.all)).toEqual({ cancelled: true })
    expect(fake.request).not.toHaveBeenCalled()
  })

  it('refuses in plain words over the limits, or what is not a file, and gives nothing', async () => {
    const many = Array.from({ length: 17 }, (_, index) => `/f/${index}`)
    const tooMany = deps({ filePaths: many }, Object.fromEntries(many.map((path) => [path, 1])))
    expect(await chooseBotBrowserFiles({ ...REQUEST, multiple: true }, tooMany.all)).toEqual({ refused: BOT_BROWSER_FILES_LIMIT_TEXT })
    const tooLarge = deps({ filePaths: ['/f/a', '/f/b'] }, { '/f/a': 300 * 1024 * 1024, '/f/b': 300 * 1024 * 1024 })
    expect(await chooseBotBrowserFiles({ ...REQUEST, multiple: true }, tooLarge.all)).toEqual({ refused: 'Choose at most 16 files, 512 MB in all.' })
    const folder = deps({ filePaths: ['/f/folder'] }, { '/f/folder': 'folder' })
    expect(await chooseBotBrowserFiles(REQUEST, folder.all)).toEqual({ refused: 'folder is not a file Mousse can give the page.' })
    const two = deps({ filePaths: ['/f/a', '/f/b'] }, { '/f/a': 1, '/f/b': 1 })
    expect(await chooseBotBrowserFiles(REQUEST, two.all)).toEqual({ refused: 'The page takes one file here.' })
    for (const fake of [tooMany, tooLarge, folder, two]) expect(fake.request).not.toHaveBeenCalled()
  })

  it('says what the service refused, and refuses a request that is not one without opening a dialog', async () => {
    const fake = deps({ filePaths: ['/Users/me/note.txt'] }, { '/Users/me/note.txt': 12 })
    fake.request.mockRejectedValueOnce({ code: 'not_actionable', message: 'The page is not asking for a file now.' })
    expect(await chooseBotBrowserFiles(REQUEST, fake.all)).toEqual({ refused: 'The page is not asking for a file now.' })
    const forged = deps({ filePaths: ['/etc/passwd'] }, { '/etc/passwd': 1 })
    expect(await chooseBotBrowserFiles({ ...REQUEST, paths: ['/etc/passwd'] }, forged.all)).toEqual({ refused: 'That file request is not one Mousse can answer.' })
    expect(forged.showOpenDialog).not.toHaveBeenCalled()
    // A site name that is not a host is not shown.
    const odd = deps({ canceled: true })
    await chooseBotBrowserFiles({ ...REQUEST, site: '<b>bank</b>' }, odd.all)
    expect(odd.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'The page asks for a file' }))
  })
})
