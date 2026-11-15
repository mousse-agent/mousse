import { app, BrowserWindow, type Rectangle } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_DIALOG_SURFACE_DIRECTORY!
/** Optional: a folder for a full-window picture of each case (the PR's screenshots). */
const shots = process.env.MOUSSE_DIALOG_SURFACE_SHOTS
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

/** The owner's appearances: the default theme, dark and light, each with acrylic off and on. */
const CASES = ['blacksphere-plus', 'dark', 'light'].flatMap((theme) => [false, true].map((acrylic) => ({ theme, acrylic })))

type Box = { left: number; top: number; right: number; bottom: number }

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const assets: Record<string, string> = { '/entry.js': 'entry.js', '/entry.css': 'entry.css', '/styles.css': 'css/styles.css' }
    const asset = assets[request.url ?? '']
    response.setHeader('Content-Type', asset?.endsWith('.js') ? 'application/javascript' : asset?.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script src="/entry.js"></script></html>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: 1000, height: 720, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  /** Pixels of `area` that differ between the chat shown behind and hidden: anything of the chat that shows through. */
  const showThrough = async (area: Box) => {
    // Inside the rounded corners and the field borders, so only the surface itself is compared.
    const inset = 16
    const rect: Rectangle = { x: Math.round(area.left + inset), y: Math.round(area.top + inset), width: Math.round(area.right - area.left - 2 * inset), height: Math.round(area.bottom - area.top - 2 * inset) }
    await execute('qa.behind(true)'); await execute('qa.frames(3)')
    const shownImage = await window.webContents.capturePage(rect)
    const shown = shownImage.toBitmap()
    const width = shownImage.getSize().width
    await execute('qa.behind(false)'); await execute('qa.frames(3)')
    const hidden = (await window.webContents.capturePage(rect)).toBitmap()
    await execute('qa.behind(true)'); await execute('qa.frames(3)')
    let differ = 0
    let first: { x: number; y: number } | null = null
    for (let at = 0; at + 3 < Math.min(shown.length, hidden.length); at += 4) {
      if (Math.max(Math.abs(shown[at]! - hidden[at]!), Math.abs(shown[at + 1]! - hidden[at + 1]!), Math.abs(shown[at + 2]! - hidden[at + 2]!)) > 6) { differ++; first ??= { x: (at / 4) % width, y: Math.floor(at / 4 / width) } }
    }
    return { pixels: shown.length / 4, differ, first, sameSize: shown.length === hidden.length && shown.length > 0 }
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)
    await execute('qa.show()')
    for (let index = 0; index < 150 && !(await execute<boolean>('qa.ready()')); index++) await delay(20)
    if (!(await execute<boolean>('qa.ready()'))) throw new Error('New bot never showed What it does')
    const cases: unknown[] = []
    for (const { theme, acrylic } of CASES) {
      await execute(`qa.appearance(${JSON.stringify(theme)}, ${acrylic})`)
      // Let the theme's colour transitions finish before anything is compared.
      await execute('qa.frames(4)'); await delay(300)
      const measured = await execute<{ window: { width: number; height: number }; dialog: Box; name: Box; text: Box }>('qa.measure()')
      cases.push({ theme, acrylic, ...measured, panel: await showThrough(measured.dialog), nameField: await showThrough(measured.name), textField: await showThrough(measured.text) })
      if (shots) {
        mkdirSync(shots, { recursive: true })
        writeFileSync(join(shots, `new-bot-${theme}-${acrylic ? 'acrylic' : 'solid'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await execute('qa.unmount()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ cases, pageErrors: await execute('qa.errors()'), rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
