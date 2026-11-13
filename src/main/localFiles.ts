import { copyFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { clipboard, dialog, nativeImage, shell, type BrowserWindow } from 'electron'

/**
 * A file of this computer that the window names by its path (a bot's file chip or picture): shown selected in its
 * folder, saved as a copy where the person picks, or, for a picture, copied to the clipboard. Each call takes only an
 * existing file by its absolute path, as `editors:open` takes only a folder: never a folder, a device, a relative path
 * or a path with a NUL in it.
 */

/** Pictures the clipboard takes. */
const PICTURE = /\.(?:png|jpe?g|gif|webp)$/i

/** The path when it names an existing file by its absolute path; refused otherwise. */
export async function assertLocalFile(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Choose an absolute file path.')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error('That file does not exist.')
  return path
}

/** Shows the file selected in File Explorer, Finder or the Files app. */
export async function showFileInFolder(path: unknown): Promise<void> {
  shell.showItemInFolder(await assertLocalFile(path))
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

/** Puts a picture file on the clipboard as an image; refused for anything the clipboard can't take as one. */
export async function copyImageFile(path: unknown): Promise<void> {
  const source = await assertLocalFile(path)
  if (!PICTURE.test(source)) throw new Error('Only a picture can be copied as an image.')
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) throw new Error("This picture can't be copied.")
  clipboard.writeImage(image)
}
