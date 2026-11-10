import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_PROMPT_RAIL_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 60000).unref()

type Rail = { ticks: number; textLeft: number; railRight: number | null; paneLeft: number; railLeft: number | null; scrolls: boolean }

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const assets: Record<string, string> = { '/entry.js': 'entry.js', '/entry.css': 'entry.css', '/styles.css': 'css/styles.css' }
    const asset = assets[request.url ?? '']
    response.setHeader('Content-Type', asset?.endsWith('.js') ? 'application/javascript' : asset?.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/entry.css"><style>body{margin:0}*{animation-play-state:paused!important}.chat-jump{display:none}</style><div id="root"></div><script src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true, backgroundColor: '#000000', webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = async <T,>(code: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer script failed: ${code}; ${String(error)}; ${rendererErrors.join(';')}`, { cause: error }) }
  }
  // Shows a thread, lets every observer and the rail's half-second growth timer run, and reads the rail.
  const open = async (shown: Record<string, unknown>): Promise<Rail> => {
    await execute(`qa.show(${JSON.stringify(shown)})`)
    await execute('qa.frames(4)')
    await new Promise(done => setTimeout(done, 700))
    await execute('qa.frames(2)')
    return execute<Rail>('qa.rail()')
  }
  const shot = async (name: string) => {
    const image = await window.webContents.capturePage()
    writeFileSync(join(directory, `${name}.png`), image.toPNG())
  }
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await new Promise(done => setTimeout(done, 20))
    const evidence: Record<string, unknown> = {}
    // Six prompts with short replies: a conversation that scrolls but is under three screens tall.
    evidence.shortThread = await open({ name: 'short', prompts: 6, replyChars: 300 })
    await shot('short-thread')
    // Two prompts that fit on the screen.
    evidence.fits = await open({ name: 'fits', prompts: 2, replyChars: 200 })
    // One prompt, however long its reply: nothing to move between.
    evidence.single = await open({ name: 'single', prompts: 1, replyChars: 20000 })
    evidence.longThread = await open({ name: 'long', prompts: 12, replyChars: 2400 })
    // A pane too narrow to keep the rail clear of the text.
    evidence.narrow = await open({ width: 720 })
    evidence.wide = await open({ width: 1000 })
    // Switching threads, and a thread whose messages arrive after the list mounted.
    evidence.switched = await open({ name: 'short2', prompts: 6, replyChars: 300 })
    await open({ name: 'opening', messages: [] })
    evidence.arrived = await open({ messages: await execute("qa.thread('opening', 12, 2400)") })
    // A thread opened while the chat is hidden, then shown.
    await open({ name: 'hidden', prompts: 12, replyChars: 2400, hidden: true })
    evidence.unhidden = await open({ hidden: false })
    // The side card docks beside a 1000px pane and reserves 272px: the column moves left, too far for the rail.
    evidence.docked = await open({ name: 'docked', prompts: 12, replyChars: 2400, reserved: 272 })
    // The card goes (Chats, Settings, the card's button): the column moves back and nothing resizes.
    evidence.undocked = await open({ reserved: 0 })
    await shot('side-card-closed')
    // A wider pane: the card moves the column 86px left, and the rail goes with it.
    await open({ name: 'docked-wide', prompts: 12, replyChars: 2400, width: 1100, reserved: 0 })
    evidence.dockedWide = await open({ reserved: 172 })
    await shot('side-card-docked')
    // A windowed thread (over the render-all threshold).
    evidence.windowed = await open({ name: 'windowed', prompts: 80, replyChars: 600, width: 1000, reserved: 0 })
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ...evidence, rendererErrors }))
  } finally {
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
