import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_GUI_MOUNTED_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 20000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))
async function main() {
  await app.whenReady(); app.dock?.hide()
  const server = createServer((request, response) => {
    const script = request.url === '/entry.js'
    response.setHeader('Content-Type', script ? 'application/javascript' : 'text/html')
    response.end(script ? readFileSync(join(directory, 'entry.js')) : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const observations: unknown[] = [], rendererErrors: string[] = []
  try {
    for (const mode of ['aside', 'permission', 'work', 'aside-retry', 'permission-retry', 'remote']) {
      const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
      window.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error(event.message) } })
      async function until(code: string) {
        for (let index = 0; index < 100; index++) { if (await execute<boolean>(code)) return; await delay(20) }
        throw new Error(`Mounted fixture condition timed out: ${code}`)
      }
      const click = async (text: string) => {
        await until(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)} && !b.disabled)`)
        await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`)
      }
      try {
        await window.loadURL(url); await until('!!window.qa')
        if (mode === 'remote') {
          await execute("qa.mountRemote('open')")
          await until("document.querySelector('select')?.options.length===2")
          await execute("document.querySelector('select').value='nod_00000000000000000000000001';document.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))")
          await until("document.querySelectorAll('select')[1]?.options.length===2")
          await execute("document.querySelectorAll('select')[1].value='thread';document.querySelectorAll('select')[1].dispatchEvent(new Event('change',{bubbles:true}))")
          await until("qa.calls.filter(row=>row.method==='bridge.hub.attach').length===1 && qa.listenerCount()===1")
          await execute('qa.publish(qa.remoteSnapshot())'); await until("qa.text().includes('Working')")
          const online = await execute('qa.text()')
          await execute("qa.mountRemote('closed')")
          await until("qa.listenerCount()===0 && qa.calls.filter(row=>row.method==='bridge.hub.detach').length===1")
          const offline = await execute('qa.text()')
          // A frame from the departed carrier has no listener and cannot refresh the display.
          await execute('qa.publish(qa.remoteSnapshot())')
          await execute("qa.mountRemote('open')")
          await until("qa.calls.filter(row=>row.method==='bridge.hub.attach').length===2 && qa.listenerCount()===1")
          const awaiting = await execute('qa.text()')
          await execute('qa.publish(qa.remoteIncremental())'); await delay(100)
          const incremental = await execute('qa.text()')
          await execute('(async () => { window.qaParts = await qa.remoteSnapshotParts(); for (const part of qaParts.slice(0,-1)) qa.publish(part) })()')
          await delay(100)
          const partial = await execute('qa.text()')
          await execute('qa.publish(qaParts.at(-1))')
          await until("qa.text().includes('Fresh verified body') && qa.text().includes('Working')")
          const fresh = await execute('qa.text()')
          await execute('qa.unmount()')
          await until("qa.listenerCount()===0 && qa.calls.filter(row=>row.method==='bridge.hub.detach').length===2")
          observations.push({ mode, online, offline, awaiting, incremental, partial, fresh, calls: await execute('qa.calls') })
          continue
        }
        await execute(`qa.mount(${JSON.stringify(mode.startsWith('aside') ? 'aside' : mode === 'work' ? 'work' : 'permission')})`)
        if (mode === 'work') await click('Private aside')
        await click(mode.startsWith('aside') ? 'Create private aside' : 'Approve exact request')
        await until(`qa.calls.some(row=>row.method===${JSON.stringify(mode.startsWith('aside') ? 'chats.aside.create' : 'bots.grant')})`)
        const before = await execute<unknown[]>('qa.calls')
        if (mode.endsWith('retry')) {
          await execute('qa.reject()')
          await click(mode.startsWith('aside') ? 'Check original private opening' : 'Retry original approval')
          await until(`qa.calls.filter(row=>row.method===${JSON.stringify(mode.startsWith('aside') ? 'chats.aside.create' : 'bots.grant')}).length===2`)
          await execute('qa.resolve()'); await delay(100)
          observations.push({ mode, before, after: await execute('({calls:qa.calls,callbacks:qa.callbacks,text:qa.text()})') })
          await execute('qa.unmount()')
        } else {
          await execute('qa.unmount()'); await execute('qa.resolve()'); await delay(100)
          observations.push({ mode, before, after: await execute('({calls:qa.calls,callbacks:qa.callbacks})') })
        }
      } finally { window.destroy() }
    }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ observations, rendererErrors }, null, 2))
  } finally { await new Promise<void>(done => server.close(() => done())) }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
