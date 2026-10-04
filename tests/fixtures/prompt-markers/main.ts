import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_PROMPT_MARKERS_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 20000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const asset = request.url === '/entry.js' ? 'entry.js' : request.url === '/entry.css' ? 'entry.css' : undefined
    response.setHeader('Content-Type', asset === 'entry.js' ? 'application/javascript' : asset === 'entry.css' ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><link rel="stylesheet" href="/entry.css"><style>:root{--text-primary:#eee;--accent:#aaa}body{margin:0}</style><div id="root"></div><button id="outside">Outside</button><script src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  async function until(code: string) {
    for (let index = 0; index < 150; index++) {
      if (await execute<boolean>(code)) return
      await delay(20)
    }
    throw new Error(`Prompt rail fixture timed out: ${code}; errors=${rendererErrors.join(';')}`)
  }
  const sample = () => execute('qa.sample()')
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await until("window.qa && qa.sample().length===8 && qa.sample().filter(t=>t.visible).map(t=>t.id).join(',')==='one,two'")
    await delay(200)
    const initial = await sample()
    await execute("document.querySelector('[data-prompt-marker-id=three]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))")
    await until("document.querySelector('.chat-prompt-rail').classList.contains('is-previewing')")
    await delay(220)
    const hovered = await sample()
    await execute("document.querySelector('[data-prompt-marker-id=three]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))")
    await until("!document.querySelector('.chat-prompt-rail').classList.contains('is-previewing')")
    await delay(220)
    const settled = await sample()
    await execute("document.getElementById('viewport').scrollTop=100")
    await until("qa.sample().filter(t=>t.visible).map(t=>t.id).join(',')==='two,three,four'")
    const scrolled = await sample()
    await execute("qa.update(['one','two','three','four','five','six','seven','eight'],'three')")
    await until("qa.sample().length===8 && qa.sample().filter(t=>t.visible).map(t=>t.id).join(',')==='two,four'")
    const virtualized = await sample()
    await execute("qa.update(['recycled','two','three','four','five','six','seven','eight']); document.getElementById('viewport').scrollTop=0")
    await until("qa.sample().filter(t=>t.visible).map(t=>t.id).join(',')==='recycled,two'")
    const recycled = await sample()
    // The offscreen window has no native activation; deliver its focus event
    // after assigning DOM focus, as the mounted renderer would receive it.
    await execute("(() => {const tick=document.querySelector('[data-prompt-marker-id=three]'); tick.focus(); tick.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))})()")
    await until("document.querySelector('.chat-prompt-preview')?.textContent.includes('Prompt three')")
    await delay(220)
    const focused = await sample()
    await execute("document.querySelector('.chat-prompt-rail').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))")
    const focusedAfterLeave = await execute("document.querySelector('.chat-prompt-rail').classList.contains('is-previewing')")
    await execute("(() => {const tick=document.activeElement; document.getElementById('outside').focus(); tick.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.getElementById('outside')}))})()")
    await until("!document.querySelector('.chat-prompt-preview')")
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await execute("document.querySelector('[data-prompt-marker-id=four]').click()")
    await until("Math.abs(document.getElementById('viewport').scrollTop-224)<1")
    const click = await execute("({count:qa.navigateCount(),scrollTop:document.getElementById('viewport').scrollTop,transition:getComputedStyle(document.querySelector('.chat-prompt-tick span')).transitionDuration})")
    await execute("qa.update(['recycled','two','three','four','five','six','seven','eight'],'four'); document.getElementById('viewport').scrollTop=0")
    await until("!document.querySelector('#viewport [data-prompt-id=four]') && qa.sample().filter(t=>t.visible).map(t=>t.id).join(',')==='recycled,two'")
    await execute("document.querySelector('[data-prompt-marker-id=four]').click()")
    await until("Math.abs(document.getElementById('viewport').scrollTop-224)<1")
    const cachedClick = await execute("({count:qa.navigateCount(),scrollTop:document.getElementById('viewport').scrollTop})")
    await execute("qa.update(Array.from({length:60},(_,i)=>'long-'+i))")
    await until('qa.sample().length===60')
    const bounded = await execute("({rail:document.querySelector('.chat-prompt-ticks').clientHeight,viewport:document.querySelector('.an-message-list-wrap').clientHeight,scrollHeight:document.querySelector('.chat-prompt-ticks').scrollHeight})")
    await execute('qa.unmount()')
    await delay(50)
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ initial, hovered, settled, scrolled, virtualized, recycled, focused, focusedAfterLeave, click, cachedClick, bounded, rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
