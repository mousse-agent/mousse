import { app, nativeImage, type NativeImage, type WebContents } from 'electron'
import { getAppIconPath } from '../appIcon'
import { dragFilePath, FileDragRefused, type FileDragDeps } from '../fileDrag'
import type { FileDragAnswer } from '../../shared/fileDrag'

/** How long the system's own icon for the file may take; past it, the app's icon is dragged. */
const ICON_WAIT_MS = 150

let fallbackIcon: NativeImage | undefined

/** The app's icon at drag size; macOS refuses a drag with an empty image. */
function appDragIcon(): NativeImage {
  if (fallbackIcon) return fallbackIcon
  const path = getAppIconPath()
  const icon = path ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
  fallbackIcon = icon.isEmpty()
    ? nativeImage.createFromBuffer(Buffer.alloc(32 * 32 * 4, 0x80), { width: 32, height: 32 })
    : icon.resize({ width: 32, height: 32 })
  return fallbackIcon
}

/** The system's icon for the file (Finder's, Explorer's), or the app's when it is slow or missing. */
async function dragIcon(path: string): Promise<NativeImage> {
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), ICON_WAIT_MS))
  const icon = await Promise.race([app.getFileIcon(path, { size: 'normal' }).catch(() => null), timeout])
  return icon && !icon.isEmpty() ? icon : appDragIcon()
}

/**
 * Starts the system's drag of a file for the window that asked, while its mouse button is still down. The window
 * cancels its own drag first; a refused request starts nothing.
 */
export async function startFileDrag(sender: WebContents, request: unknown, deps: FileDragDeps): Promise<FileDragAnswer> {
  let path: string
  try {
    path = await dragFilePath(request, deps)
  } catch (error) {
    if (error instanceof FileDragRefused) return { refused: error.message }
    throw error
  }
  if (sender.isDestroyed()) return { refused: 'The window closed.' }
  sender.startDrag({ file: path, icon: await dragIcon(path) })
  return { path }
}
