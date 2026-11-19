import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_BOT_CHAT_FIND_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

type View = { count: string | null; message: string | null; inView: boolean; fromEnd: number }

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
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  const until = async (code: string, what: string) => {
    for (let index = 0; index < 300; index++) {
      if (await execute<boolean>(code)) return
      await execute('qa.frames(1)')
    }
    throw new Error(`Never: ${what}`)
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)
    await execute('qa.load()')
    await until('qa.ready()', 'the chat drew its newest message')
    await execute('qa.frames(4)')
    // The reply streams, and the chat follows its end.
    await execute('qa.stream()')
    await until('qa.liveHeight() > 0', 'the reply started streaming')
    await delay(400)
    const following = await execute<View>('qa.view()')
    await until('qa.openFind()', 'Find opened from the bot menu')
    await execute('qa.search("lighthouse")')
    // The search starts at the match on screen, in the newest message.
    await until('(() => { const v = qa.view(); return v.count === "2 of 2" && v.message === "m160" })()', 'Find showed the newest match')
    await execute('qa.frames(4)')
    const before = await execute<View>('qa.view()')
    const liveBefore = await execute<number>('qa.liveHeight()')
    // A real click on Previous: the older match is in the oldest message, which is not loaded or drawn yet.
    window.webContents.debugger.attach('1.3')
    const { x, y } = await execute<{ x: number; y: number }>('qa.point("Previous match")')
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    // Every frame for a while, as the reply keeps streaming below.
    const after: View[] = []
    for (let index = 0; index < 90; index++) {
      after.push(await execute<View>('qa.view()'))
      await execute('qa.frames(1)')
    }
    await delay(500)
    after.push(await execute<View>('qa.view()'))
    const liveAfter = await execute<number>('qa.liveHeight()')
    const pageErrors = await execute<string[]>('qa.errors()')
    await execute('qa.unmount()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ following, before, after, liveBefore, liveAfter, pageErrors, rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
