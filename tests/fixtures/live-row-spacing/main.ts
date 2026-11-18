import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_LIVE_ROW_SPACING_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

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
  const window = new BrowserWindow({ show: false, width: 900, height: 760, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)
    await execute('qa.show()')
    let ready = false
    for (let index = 0; index < 250 && !ready; index++) {
      ready = await execute<boolean>('qa.ready()')
      if (!ready) await delay(20)
    }
    if (!ready) throw new Error('The live row never showed a thought and a call')
    await execute('qa.frames(3)')
    const live = await execute('qa.live()')
    if (process.env.MOUSSE_LIVE_ROW_SPACING_CAPTURE) writeFileSync(process.env.MOUSSE_LIVE_ROW_SPACING_CAPTURE, (await window.webContents.capturePage()).toPNG())
    const open = await execute('qa.open()')
    await execute('qa.unmount()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ live, open, pageErrors: await execute('qa.errors()'), rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
