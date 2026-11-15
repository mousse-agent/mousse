/**
 * A file or folder of this computer that a bot's chat names (src/main/localFiles.ts): shown selected in its folder,
 * opened (a folder), saved as a copy where the person picks, copied to the clipboard as a picture. Each takes only an
 * existing one by its absolute path; a copy and a picture take a file only.
 * Real files on disk; Electron's shell, dialog and clipboard are stand-ins.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromPath: vi.fn() }
}))
vi.mock('electron', () => electron)

const { copyImageFile, openLocalPath, saveFileCopy, showFileInFolder } = await import('../src/main/localFiles')

let folder: string
let picture: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'mousse-local-files-'))
  picture = join(folder, 'chip-clouds-boy.png')
  writeFileSync(picture, Buffer.from([137, 80, 78, 71, 1, 2, 3]))
  mkdirSync(join(folder, 'pictures.png'))
  electron.shell.openPath.mockReset().mockResolvedValue('')
  for (const mock of [electron.shell.showItemInFolder, electron.dialog.showSaveDialog, electron.clipboard.writeImage, electron.nativeImage.createFromPath]) mock.mockReset()
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

// Everything but an existing file or folder by its absolute path is refused, and nothing is shown, opened, saved or copied.
const nowhere: Array<[string, () => unknown]> = [
  ['a relative path', () => 'chip-clouds-boy.png'],
  ['a file that is not there', () => join(folder, 'gone.png')],
  ['a path with a NUL', () => `${picture}\0.png`],
  ['not a string', () => ({ path: picture })]
]
// What takes a file only refuses a folder too.
const refused: Array<[string, () => unknown]> = [...nowhere, ['a folder', () => join(folder, 'pictures.png')]]

describe('showFileInFolder', () => {
  it('selects an existing file, or an existing folder, in the folder it is in', async () => {
    await showFileInFolder(picture)
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(picture)
    await showFileInFolder(join(folder, 'pictures.png'))
    expect(electron.shell.showItemInFolder).toHaveBeenLastCalledWith(join(folder, 'pictures.png'))
  })
  it.each(nowhere)('refuses %s', async (_what, path) => {
    await expect(showFileInFolder(path())).rejects.toThrow()
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
  })
  it('says a path with nothing at it by its name', async () => {
    await expect(showFileInFolder(join(folder, 'gone.png'))).rejects.toThrow("Can't find gone.png. It may have been moved or deleted.")
  })
})

describe('openLocalPath', () => {
  it('leaves a file to the window, and opens nothing', async () => {
    expect(await openLocalPath(picture)).toBe('file')
    expect(electron.shell.openPath).not.toHaveBeenCalled()
  })
  it('opens a folder in the file manager, one with a dot or a space in its name too', async () => {
    const net = join(folder, '.mousse', 'net keys')
    mkdirSync(net, { recursive: true })
    expect(await openLocalPath(net, 'win32')).toBe('folder')
    expect(electron.shell.openPath).toHaveBeenCalledWith(net)
    expect(await openLocalPath(join(folder, '.mousse'), 'darwin')).toBe('folder')
    expect(electron.shell.openPath).toHaveBeenLastCalledWith(join(folder, '.mousse'))
  })
  it('on macOS shows a folder that may be an app selected, and never opens it', async () => {
    const app = join(folder, 'Tool.app')
    mkdirSync(app)
    expect(await openLocalPath(app, 'darwin')).toBe('folder')
    expect(electron.shell.openPath).not.toHaveBeenCalled()
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(app)
  })
  it('says a folder the file manager could not open', async () => {
    electron.shell.openPath.mockResolvedValue('Failed to open path')
    await expect(openLocalPath(join(folder, 'pictures.png'), 'win32')).rejects.toThrow("Can't open pictures.png.")
  })
  it.each(nowhere)('refuses %s', async (_what, path) => {
    await expect(openLocalPath(path())).rejects.toThrow()
    expect(electron.shell.openPath).not.toHaveBeenCalled()
  })
})

describe('saveFileCopy', () => {
  it('copies the file where the person picks, starting in the folder given with its own name', async () => {
    const target = join(folder, 'saved.png')
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await saveFileCopy(picture, null, '/home/me/Downloads')).toBe(target)
    expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toEqual({ defaultPath: join('/home/me/Downloads', 'chip-clouds-boy.png') })
    expect(readFileSync(target)).toEqual(readFileSync(picture))
  })
  it('does nothing when the dialog is closed', async () => {
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await saveFileCopy(picture, null, folder)).toBeNull()
  })
  it.each(refused)('refuses %s, before any dialog', async (_what, path) => {
    await expect(saveFileCopy(path(), null, folder)).rejects.toThrow()
    expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
  })
  it('says a folder is a folder', async () => {
    await expect(saveFileCopy(join(folder, 'pictures.png'), null, folder)).rejects.toThrow('That is a folder, not a file.')
  })
})

describe('copyImageFile', () => {
  it('puts a picture on the clipboard', async () => {
    const image = { isEmpty: () => false }
    electron.nativeImage.createFromPath.mockReturnValue(image)
    await copyImageFile(picture)
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledWith(picture)
    expect(electron.clipboard.writeImage).toHaveBeenCalledWith(image)
  })
  it('refuses a file that is not a picture, and one the clipboard cannot read as one', async () => {
    const notes = join(folder, 'notes.md')
    writeFileSync(notes, '# Notes')
    await expect(copyImageFile(notes)).rejects.toThrow('Only a picture can be copied as an image.')
    electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => true })
    await expect(copyImageFile(picture)).rejects.toThrow("This picture can't be copied.")
    expect(electron.clipboard.writeImage).not.toHaveBeenCalled()
  })
  it.each(refused)('refuses %s', async (_what, path) => {
    await expect(copyImageFile(path())).rejects.toThrow()
    expect(electron.clipboard.writeImage).not.toHaveBeenCalled()
  })
})
