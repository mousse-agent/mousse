import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_RENDERER_STARTUP_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 15000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady(); app.dock?.hide()
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  async function until(code: string) {
    for (let index = 0; index < 100; index++) { if (await execute<boolean>(code)) return; await delay(20) }
    throw new Error(`Startup condition timed out: ${code}; ${JSON.stringify(await execute('({calls:window.qa?.calls,errors:window.qa?.errors,text:document.body.innerText})'))}; ${rendererErrors.join('\n')}`)
  }
  try {
    await window.loadFile(join(directory, 'index.html'))
    await until("!!document.querySelector('.navigation-rail') && qa.calls.filter(row=>row.method==='profiles.status').length>=2")
    // Let mount effects settle with both trusted bootstrap responses held.
    await delay(100)
    const before = await execute('({calls:qa.calls,ready:qa.ready(),profile:qa.profile(),channels:!!document.querySelector(".channels-page"),main:!!document.querySelector(".main-area")})')
    await execute('qa.bind()')
    await until("qa.ready() && qa.calls.some(row=>row.method==='platformRequest.request' && row.params==='browser.access.status') && qa.calls.some(row=>row.method==='channels.getSnapshot')")
    await delay(100)
    const after = await execute('({calls:qa.calls,ready:qa.ready(),profile:qa.profile(),errors:qa.errors,channels:!!document.querySelector(".channels-page"),main:!!document.querySelector(".main-area")})')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ before, after, rendererErrors }))
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
