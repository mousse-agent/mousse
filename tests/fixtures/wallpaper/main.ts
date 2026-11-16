import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_WALLPAPER_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    if (request.url === '/entry.js') {
      response.setHeader('Content-Type', 'application/javascript')
      response.end(readFileSync(join(directory, 'entry.js')))
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><html><meta charset="utf-8"><body><script src="/entry.js"></script></body></html>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    for (let index = 0; index < 150 && !(await window.webContents.executeJavaScript('Boolean(window.qa)')); index++) await delay(20)
    const evidence = await window.webContents.executeJavaScript('qa.run()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
