import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electron from 'electron'

if (process.platform !== 'linux' || !process.env.DISPLAY) {
  throw new Error('Run this native window shape check on Linux with an X11/Xwayland display')
}
const directory = await mkdtemp(join(tmpdir(), 'mousse-linux-window-shape-'))
const repo = fileURLToPath(new URL('..', import.meta.url))
try {
  // Query the server-side shape, not BrowserWindow.isVisible(): an empty X11
  // region leaves Electron alive and "visible" while hiding the whole window.
  await writeFile(join(directory, 'shape.py'), `
import ctypes, json, sys
x11 = ctypes.CDLL('libX11.so.6')
xext = ctypes.CDLL('libXext.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XFree.argtypes = [ctypes.c_void_p]
display = x11.XOpenDisplay(None)
if not display: raise RuntimeError('Cannot open X11 display')
class Rectangle(ctypes.Structure):
    _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short), ('width', ctypes.c_ushort), ('height', ctypes.c_ushort)]
xext.XShapeGetRectangles.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xext.XShapeGetRectangles.restype = ctypes.POINTER(Rectangle)
try:
    count, ordering = ctypes.c_int(), ctypes.c_int()
    rectangles = xext.XShapeGetRectangles(display, int(sys.argv[1]), 0, ctypes.byref(count), ctypes.byref(ordering))
    try:
        print(json.dumps([[rectangles[i].x, rectangles[i].y, rectangles[i].width, rectangles[i].height] for i in range(count.value)]))
    finally:
        if rectangles: x11.XFree(rectangles)
finally:
    x11.XCloseDisplay(display)
`)
  await build({
    stdin: { resolveDir: repo, loader: 'ts', contents: `
      import assert from 'node:assert/strict'
      import { execFileSync } from 'node:child_process'
      import { join } from 'node:path'
      import { app, BrowserWindow } from 'electron'
      import { attachLinuxWindowShape } from './src/main/linuxWindowShape'
      const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
      const fixture = process.argv[2]
      app.setPath('userData', join(fixture, 'user-data'))
      app.whenReady().then(async () => {
        let win: BrowserWindow | undefined
        try {
          win = new BrowserWindow({ width: 600, height: 400, frame: false,
            transparent: true, backgroundColor: '#00000000', show: true,
            webPreferences: { sandbox: true, contextIsolation: true } })
          attachLinuxWindowShape(win)
          await win.loadURL('data:text/html,<body style="margin:0;background:rgba(80,40,100,.8);height:100vh">Linux window shape regression</body>')
          const windowId = win.getNativeWindowHandle().readUInt32LE()
          const waitFor = async (ready: () => boolean, label: string) => {
            const deadline = Date.now() + 4000
            while (!ready()) {
              assert(Date.now() < deadline, label + ' timed out')
              await pause(25)
            }
            // Shape changes cross an asynchronous Chromium/X11 boundary.
            await pause(300)
          }
          const checkShape = (label: string, square: boolean) => {
            assert(!win!.isDestroyed() && win!.isVisible(), label + ' stays alive and visible')
            const rectangles: number[][] = JSON.parse(execFileSync('python', [join(fixture, 'shape.py'), String(windowId)], { encoding: 'utf8', timeout: 2000 }))
            assert(rectangles.length > 0, label + ' has a nonempty actual X11 drawable region')
            assert(rectangles.every(([, , width, height]) => width > 0 && height > 0), label + ' contains positive rectangles')
            const coversCorner = rectangles.some(([x, y, width, height]) => x <= 0 && y <= 0 && x + width > 0 && y + height > 0)
            assert.equal(coversCorner, square, label + ' restores the expected corner shape')
            if (square) assert.equal(rectangles.length, 1, label + ' covers the complete rectangular window')
            else assert(rectangles.length > 1, label + ' restores rounded corners')
            console.log(label + ': ' + rectangles.length + ' native shape rectangles')
          }
          await pause(300)
          checkShape('initial rounded window', false)
          for (let cycle = 1; cycle <= 2; cycle++) {
            win.maximize()
            await waitFor(() => win!.isMaximized(), 'maximize')
            checkShape('maximize cycle ' + cycle, true)
            win.unmaximize()
            await waitFor(() => !win!.isMaximized(), 'unmaximize')
            checkShape('restored cycle ' + cycle, false)
            win.setFullScreen(true)
            await waitFor(() => win!.isFullScreen(), 'fullscreen')
            checkShape('fullscreen cycle ' + cycle, true)
            win.setFullScreen(false)
            await waitFor(() => !win!.isFullScreen() && !win!.isMaximized(), 'leave fullscreen')
            checkShape('fullscreen restored cycle ' + cycle, false)
          }
          console.log('Linux native shape passed: transparent frameless maximize/fullscreen/restore remain drawable and restore rounded corners.')
          win.destroy()
          app.quit()
        } catch (error) {
          console.error(error)
          win?.destroy()
          app.exit(1)
        }
      })
    ` },
    outfile: join(directory, 'check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron']
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs'), directory, '--ozone-platform=x11'], { env, stdio: 'inherit' })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Native Linux window shape check timed out'))
      else resolve(code)
    })
  })
  if (code !== 0) throw new Error('Native Linux window shape check failed: ' + code)
} finally {
  await rm(directory, { recursive: true, force: true })
}
