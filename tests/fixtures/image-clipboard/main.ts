import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, protocol, type NativeImage } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { attachContextMenu, writePngToClipboard } from '../../../src/main/contextMenu'

const directory = process.env.MOUSSE_IMAGE_CLIPBOARD_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
protocol.registerSchemesAsPrivileged([{ scheme: 'mousse-test-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

type Placed = { url: string; width: number; height: number; x: number; y: number }
/** What the clipboard held as a picture: its size and the colour of its middle pixel. */
type Held = { width: number; height: number; red: number; green: number; blue: number } | null

function held(): Held {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return { width, height, blue: bitmap[at], green: bitmap[at + 1], red: bitmap[at + 2] }
}

/** The person's clipboard before the test (text, HTML, RTF, a picture), to put back after it. */
function keepClipboard(): () => void {
  const data: Electron.Data = {}
  const text = clipboard.readText()
  const html = clipboard.readHTML()
  const rtf = clipboard.readRTF()
  const image: NativeImage = clipboard.readImage()
  if (text) data.text = text
  if (html) data.html = html
  if (rtf) data.rtf = rtf
  if (!image.isEmpty()) data.image = image
  return () => {
    clipboard.clear()
    if (Object.keys(data).length) clipboard.write(data)
  }
}

async function main() {
  await app.whenReady()
  app.dock?.hide()
  // A 5 by 3 red PNG (the bitmap is BGRA) the app's own protocol serves.
  const red = nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 5 * 3 }, () => [0, 0, 255, 255]).flat()), { width: 5, height: 3 }).toPNG()
  protocol.handle('mousse-test-asset', () => new Response(red, { headers: { 'content-type': 'image/png' } }))
  // What registerGuiIpc registers for the preload's clipboard.writeImage (tests/imageClipboard.test.ts).
  ipcMain.handle('clipboard:writeImage', (_event, png: unknown) => { writePngToClipboard(png) })

  // The window's real right-click menu; the test picks its items instead of a person.
  let shown: Electron.Menu | null = null
  Menu.prototype.popup = function popup(this: Electron.Menu) { shown = this }

  const window = new BrowserWindow({ show: false, width: 400, height: 700, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(directory, 'preload.js') } })
  attachContextMenu(window.webContents, () => window)
  const restore = keepClipboard()
  try {
    await window.loadFile(join(directory, 'page.html'))
    for (let index = 0; index < 150 && !(await window.webContents.executeJavaScript('Boolean(window.qa)')); index++) await delay(20)
    const placed = await window.webContents.executeJavaScript('qa.show()') as Record<string, Placed>
    const contextMenu: Record<string, { items: string[]; held: Held }> = {}
    const copyImage: Record<string, { result: string; held: Held }> = {}
    for (const [name, picture] of Object.entries(placed)) {
      // A right-click on the picture, then its menu's Copy image.
      clipboard.clear()
      shown = null
      const opened = new Promise<void>(done => window.webContents.once('context-menu', () => setImmediate(done)))
      window.webContents.sendInputEvent({ type: 'mouseDown', x: picture.x, y: picture.y, button: 'right', clickCount: 1 })
      window.webContents.sendInputEvent({ type: 'mouseUp', x: picture.x, y: picture.y, button: 'right', clickCount: 1 })
      await Promise.race([opened, delay(5000)])
      const menu = shown as Electron.Menu | null
      const items = menu ? menu.items.filter(item => item.type !== 'separator').map(item => item.label || String(item.role ?? '')) : []
      menu?.items.find(item => item.label === 'Copy image')?.click()
      let after: Held = null
      for (let index = 0; index < 100 && !(after = held()); index++) await delay(20)
      contextMenu[name] = { items, held: after }

      // A bot picture's own Copy image: the window draws the picture and hands over PNG bytes.
      clipboard.clear()
      const result = await window.webContents.executeJavaScript(`qa.copy(${JSON.stringify(picture.url)})`) as string
      copyImage[name] = { result, held: held() }
    }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ placed, contextMenu, copyImage }))
  } finally {
    restore()
    window.destroy()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
