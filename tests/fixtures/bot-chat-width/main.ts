import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_BOT_CHAT_WIDTH_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

/** The two replies whose bubbles fill their width, and the pane widths: narrow, and wide enough for the tools. */
const WIDE = ['m2', 'm4']
const NARROW = 600
const ROOMY = 1000

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const assets: Record<string, string> = { '/entry.js': 'entry.js', '/entry.css': 'entry.css', '/styles.css': 'css/styles.css' }
    const asset = assets[request.url ?? '']
    response.setHeader('Content-Type', asset?.endsWith('.js') ? 'application/javascript' : asset?.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/entry.css"><style>body{margin:0}</style><div id="root"></div><script src="/entry.js"></script></html>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: ROOMY, height: 760, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  // A few frames, and the tools' fade (.12s) done.
  const settle = async () => { await execute('qa.frames(4)'); await delay(150) }
  const pointer = (x: number, y: number) => window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)
    await execute('qa.load()')
    await execute(`qa.render(${NARROW})`)
    let ready = false
    for (let index = 0; index < 250 && !ready; index++) {
      ready = await execute<boolean>('qa.ready()')
      if (!ready) await delay(20)
    }
    if (!ready) throw new Error('The bot chat never rendered its messages')
    await settle()
    // A hidden offscreen page never has focus, so focus moves without its events: let it behave as a focused window.
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    // Nothing hovered or focused: every reply's tools hidden.
    const hidden = await execute('qa.measure()')
    // A real pointer on each wide reply, then off it.
    const hover: Record<string, unknown> = {}
    for (const id of WIDE) {
      const { x, y } = await execute<{ x: number; y: number }>(`qa.point(${JSON.stringify(id)})`)
      pointer(x, y)
      await settle()
      hover[id] = await execute(`qa.measure(${JSON.stringify(id)})`)
      pointer(ROOMY - 4, 4)
      await settle()
    }
    const afterHover = await execute('qa.measure()')
    // The keyboard: Tab into each wide reply, in a fresh chat, through its tools to Copy and Reply.
    const keyboard: Record<string, { focused: boolean; reached: string[]; measured: Record<string, unknown> }> = {}
    for (const id of WIDE) {
      await execute(`qa.remount(${NARROW})`)
      await settle()
      const focused = await execute<boolean>(`qa.focusBefore(${JSON.stringify(id)})`)
      const reached: string[] = []
      const measured: Record<string, unknown> = {}
      for (let index = 0; index < 20 && !reached.includes('Reply'); index++) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await settle()
        const label = await execute<string | null>(`qa.focusedIn(${JSON.stringify(id)})`)
        if (label === null) break
        reached.push(label)
        if (label === 'Copy' || label === 'Reply') measured[label] = await execute(`qa.measure(${JSON.stringify(id)})`)
      }
      keyboard[id] = { focused, reached, measured }
    }
    // Tools left open (the focus in them) while the pane narrows. Focused in a fresh chat at the roomy width, where they need no move.
    await execute(`qa.remount(${ROOMY})`)
    await settle()
    await execute(`qa.focusCopy(${JSON.stringify(WIDE[1])})`)
    await settle()
    const roomy = await execute(`qa.measure(${JSON.stringify(WIDE[1])})`)
    await execute(`qa.render(${NARROW})`)
    await settle()
    const narrowed = await execute(`qa.measure(${JSON.stringify(WIDE[1])})`)
    if (process.env.MOUSSE_BOT_CHAT_WIDTH_CAPTURE) writeFileSync(join(directory, 'narrowed.png'), (await window.webContents.capturePage()).toPNG())
    // A reply with an applet, in a fresh chat at each width.
    await execute('qa.addApplet()')
    await execute(`qa.remount(${NARROW})`)
    await settle()
    const appletNarrow = await execute('qa.applet()')
    await execute(`qa.remount(${ROOMY})`)
    await settle()
    const appletRoomy = await execute('qa.applet()')
    await execute('qa.unmount()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ hidden, appletNarrow, appletRoomy, hover, afterHover, keyboard, roomy, narrowed, pageErrors: await execute('qa.errors()'), rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
