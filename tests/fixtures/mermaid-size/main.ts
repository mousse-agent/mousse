import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_MERMAID_SIZE_DIRECTORY!
/** When set, a capture of every case is saved there as `<diagram>-<theme>.png`. */
const shots = process.env.MOUSSE_MERMAID_SIZE_SHOTS
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

const DIAGRAMS = ['tall', 'wide', 'small']
const THEMES = ['dark', 'light', 'acrylic']

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
    const cases: Record<string, unknown> = {}
    for (const diagram of DIAGRAMS) {
      for (const theme of THEMES) {
        const name = `${diagram}-${theme}`
        await execute(`qa.show(${JSON.stringify(diagram)}, ${JSON.stringify(theme)})`)
        let ready = false
        for (let index = 0; index < 250 && !ready; index++) {
          ready = await execute<boolean>('qa.ready()')
          if (!ready) await delay(20)
        }
        if (!ready) throw new Error(`The "${name}" diagram never drew`)
        await execute('qa.frames(3)')
        const measured = await execute<{ expand: boolean }>('qa.measure()')
        if (shots) writeFileSync(join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
        let expanded: unknown = null
        if (measured.expand) {
          await execute('qa.expand()')
          await execute('qa.frames(3)')
          expanded = await execute('qa.measure()')
        }
        cases[name] = { ...measured, expanded }
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
