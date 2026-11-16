import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerAppletIpc } from '../../../src/main/applets/registerAppletIpc'
import { AppletRuntimeManager } from '../../../src/main/applets/AppletRuntimeManager'
import type { GuiMmsController } from '../../../src/main/mms/GuiMmsController'

const directory = process.env.MOUSSE_APPLET_CACHED_FRAME_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** A see-through page with one block on it; the block is green like the cached frame (green reads the same in RGBA and BGRA). */
const source = {
  schemaVersion: 1,
  title: 'Cached frame',
  description: 'A block on a see-through page',
  stateVersion: 1,
  html: '<div id="block"></div>',
  css: 'body{margin:0}#block{width:200px;height:120px;background:rgb(0,255,0)}',
  js: ''
}

// The cached frame is a solid green picture, so the host page shows green wherever it draws the frame. Capturing a
// hidden window's guest is slow and can time out; what this checks is where the frame is drawn, not how it is captured.
AppletRuntimeManager.prototype.snapshot = async function () {
  const size = 8
  return nativeImage.createFromBitmap(Buffer.alloc(size * size * 4, Buffer.from([0, 255, 0, 255])), { width: size, height: size }).toDataURL()
}

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const window = new BrowserWindow({
    show: false,
    width: 700,
    height: 600,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { preload: join(directory, 'preload.cjs'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const bundle = { schemaVersion: 1, appletId: 'applet', revisionId: 'revision', sourceHash: 'hash', title: source.title, description: source.description, threadId: 'thread', messageId: 'message', turnId: 'turn', createdAt: new Date().toISOString(), runtimePolicyVersion: 1, source }
  const gui = {
    on: () => {},
    getWindowBindingForSender: () => ({ profileId: 'profile', epoch: 1 }),
    runWithSender: (_sender: unknown, callback: () => unknown) => callback(),
    request: async (method: string) => {
      if (method === 'applets.get') return bundle
      if (method === 'applets.state.get') return { state: null }
      if (method === 'applets.state.save') return { ok: true }
      throw new Error(`Unexpected request ${method}`)
    }
  } as unknown as GuiMmsController
  registerAppletIpc((channel, handler) => ipcMain.handle(channel, handler), gui, () => [window])
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  /** Whether the host page itself (not the applet's view over it) shows the cached frame at the block. */
  const hostGreenAtBlock = async () => {
    const point = await execute<{ x: number; y: number }>('qa.blockPoint()')
    const pixel = (await window.webContents.capturePage({ x: point.x, y: point.y, width: 1, height: 1 })).toBitmap()
    return pixel[1] > 200 && pixel[0] < 60 && pixel[2] < 60
  }
  try {
    await window.loadFile(join(directory, 'index.html'))
    let framed = false
    for (let index = 0; index < 200 && !framed; index++) {
      framed = await execute<boolean>('Boolean(window.qa) && qa.framed()')
      if (!framed) await delay(25)
    }
    if (!framed) throw new Error('The applet never left a cached frame in the host page')
    await delay(200)
    await execute('qa.frames()')
    const live = await hostGreenAtBlock()
    await execute('qa.scroll()')
    await execute('qa.frames()')
    const scrolling = await hostGreenAtBlock()
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ live, scrolling }))
  } finally {
    window.destroy()
  }
}
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
