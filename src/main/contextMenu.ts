import { clipboard, Menu, nativeImage, type BrowserWindow, type WebContents } from 'electron'

/**
 * The window's right-click menu. A picture under the pointer (a thread's attachment, screenshot or markdown image, a
 * bot's picture, the preview) offers Copy image, which puts the picture itself on the clipboard, whatever its address
 * (`data:`, `blob:`, a file or the app's own protocol) or format (a GIF gives its frame on screen). Selected or
 * editable text adds Cut, Copy, Paste and Select all.
 */
export function attachContextMenu(
  webContents: WebContents,
  getWindow?: () => BrowserWindow | null
): void {
  webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []

    if (params.mediaType === 'image' && params.hasImageContents) {
      const { x, y } = params
      template.push({ label: 'Copy image', click: () => webContents.copyImageAt(x, y) })
    }

    const text: Electron.MenuItemConstructorOptions[] = []
    if (params.editFlags.canCut) {
      text.push({ role: 'cut' })
    }
    if (params.editFlags.canCopy) {
      text.push({ role: 'copy' })
    }
    if (params.editFlags.canPaste) {
      text.push({ role: 'paste' })
    }
    if (params.editFlags.canSelectAll) {
      if (text.length > 0) {
        text.push({ type: 'separator' })
      }
      text.push({ role: 'selectAll' })
    }
    if (template.length > 0 && text.length > 0) template.push({ type: 'separator' })
    template.push(...text)

    if (template.length === 0) return

    Menu.buildFromTemplate(template).popup({ window: getWindow?.() ?? undefined })
  })
}

/** The largest picture the window may hand the clipboard: 64 MiB of PNG. */
const MAX_PNG_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Puts a picture the window has drawn as PNG bytes on the clipboard as an image, so other apps paste the picture
 * itself. Anything but PNG bytes, or a PNG that can't be read, is refused and the clipboard is left as it was.
 */
export function writePngToClipboard(png: unknown): void {
  if (!(png instanceof Uint8Array) || png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES ||
    !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) throw new Error("This picture can't be copied.")
  const image = nativeImage.createFromBuffer(Buffer.from(png.buffer, png.byteOffset, png.byteLength))
  if (image.isEmpty()) throw new Error("This picture can't be copied.")
  clipboard.writeImage(image)
}

export function showCopyMenu(
  getWindow: () => BrowserWindow | null,
  x: number,
  y: number,
  text: string
): void {
  Menu.buildFromTemplate([
    {
      label: 'Copy',
      click: () => {
        clipboard.writeText(text)
      }
    }
  ]).popup({ window: getWindow() ?? undefined, x: Math.round(x), y: Math.round(y) })
}
