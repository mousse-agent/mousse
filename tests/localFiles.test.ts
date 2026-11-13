/**
 * A file of this computer that a bot's chat names (src/main/localFiles.ts): shown selected in its folder, saved as a copy
 * where the person picks, copied to the clipboard as a picture. Each takes only an existing file by its absolute path.
 * Real files on disk; Electron's shell, dialog and clipboard are stand-ins.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  shell: { showItemInFolder: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromPath: vi.fn() }
}))
vi.mock('electron', () => electron)

const { copyImageFile, saveFileCopy, showFileInFolder } = await import('../src/main/localFiles')

let folder: string
let picture: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'mousse-local-files-'))
  picture = join(folder, 'chip-clouds-boy.png')
  writeFileSync(picture, Buffer.from([137, 80, 78, 71, 1, 2, 3]))
  mkdirSync(join(folder, 'pictures.png'))
  for (const mock of [electron.shell.showItemInFolder, electron.dialog.showSaveDialog, electron.clipboard.writeImage, electron.nativeImage.createFromPath]) mock.mockReset()
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

// Everything but an existing file by its absolute path is refused, and nothing is shown, saved or copied.
const refused: Array<[string, () => unknown]> = [
  ['a relative path', () => 'chip-clouds-boy.png'],
  ['a folder', () => join(folder, 'pictures.png')],
  ['a file that is not there', () => join(folder, 'gone.png')],
  ['a path with a NUL', () => `${picture}\0.png`],
  ['not a string', () => ({ path: picture })]
]

describe('showFileInFolder', () => {
  it('selects an existing file in its folder', async () => {
    await showFileInFolder(picture)
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(picture)
  })
  it.each(refused)('refuses %s', async (_what, path) => {
    await expect(showFileInFolder(path())).rejects.toThrow()
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
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
