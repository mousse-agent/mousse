import { copyFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'

/**
 * A file or folder of this computer that the window names by its path (a bot's file chip or picture): shown selected
 * in its folder, opened (a folder, in the file manager), or saved as a copy where the person picks. Each call takes
 * only an existing file or folder by its absolute path: never a device, a relative path or a path with a NUL in it.
 * Saving a copy takes a file only.
 */

/** What a path names on this computer. */
export type LocalPathKind = 'file' | 'folder'

/** What is said when nothing is at a path: its name, and why it may be gone. */
function missing(path: string): Error {
  return new Error(`Can't find ${basename(path) || path}. It may have been moved or deleted.`)
}

/** The path and what it names, when it is an existing file or folder by its absolute path; refused otherwise. */
async function localPath(path: unknown): Promise<{ path: string; kind: LocalPathKind }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Choose an absolute file path.')
  const info = await stat(path).catch(() => null)
  if (info?.isFile()) return { path, kind: 'file' }
  if (info?.isDirectory()) return { path, kind: 'folder' }
  throw missing(path)
}

/** The path when it names an existing file by its absolute path; refused otherwise, a folder in its own words. */
export async function assertLocalFile(path: unknown): Promise<string> {
  const found = await localPath(path)
  if (found.kind !== 'file') throw new Error('That is a folder, not a file.')
  return found.path
}

/** Shows the file or folder selected in File Explorer, Finder or the Files app. */
export async function showFileInFolder(path: unknown): Promise<void> {
  shell.showItemInFolder((await localPath(path)).path)
}

/** A folder macOS may run when opened (an app or another bundle): its name has an extension. */
const BUNDLE = /[^.]\.[A-Za-z0-9]+$/

/**
 * What a path a chip opens names. A folder is opened in the file manager here; a file is left to the window, which
 * shows it. Nothing is ever run: on macOS a folder that may be a bundle is shown selected in its folder instead.
 */
export async function openLocalPath(path: unknown, platform: NodeJS.Platform = process.platform): Promise<LocalPathKind> {
  const found = await localPath(path)
  if (found.kind === 'file') return 'file'
  if (platform === 'darwin' && BUNDLE.test(basename(found.path))) shell.showItemInFolder(found.path)
  else {
    const failure = await shell.openPath(found.path)
    if (failure) throw new Error(`Can't open ${basename(found.path) || found.path}.`)
  }
  return 'folder'
}

/**
 * Saves a copy of the file where the person picks in the system's save dialog, which starts in `folder` with the
 * file's own name. The path it was saved to, or null when the dialog was closed.
 */
export async function saveFileCopy(path: unknown, window: BrowserWindow | null, folder: string): Promise<string | null> {
  const source = await assertLocalFile(path)
  const options: Electron.SaveDialogOptions = { defaultPath: join(folder, basename(source)) }
  const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  // Saving over the file itself leaves it as it is.
  if (resolve(picked.filePath) !== resolve(source)) await copyFile(source, picked.filePath)
  return picked.filePath
}
