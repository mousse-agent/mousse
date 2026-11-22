import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_WARM_START_COLUMN_DIRECTORY!
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
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  // Wide enough that the thread details card docks beside the conversation and the column gives up room for it.
  const window = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  async function until(code: string) {
    for (let index = 0; index < 300; index++) { if (await execute<boolean>(code)) return; await delay(20) }
    throw new Error(`Condition timed out: ${code}; ${rendererErrors.join('\n')}`)
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await until('Boolean(window.qa?.warm())')
    // The warm view on screen for a while, as before a service that takes a few seconds.
    await delay(500)
    await execute('qa.bind()')
    await until('qa.live()')
    await delay(500)
    const { frames, errors } = await execute<{ frames: unknown[]; errors: string[] }>('qa.stop()')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ frames, pageErrors: errors, rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
