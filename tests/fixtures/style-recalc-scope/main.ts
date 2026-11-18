import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_STYLE_RECALC_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()

/** Turns in the transcript: enough that restyling all of it is thousands of elements. */
const TURNS = 300

// The sidebar's rows in each state its fades read (turning, needs the person, card with Input, a project that needs
// the person), an edit row with its actions, and a transcript of prompts, answers and code.
const PAGE = `
<div class="app">
  <aside class="threads-sidebar"><div class="threads-sidebar-tree" role="tree">
    <div class="threads-sidebar-project-row"><button class="threads-sidebar-project-toggle"><span>Project</span><span class="threads-sidebar-project-status--needs-me">1</span></button></div>
    <div class="threads-sidebar-thread-container"><button class="threads-sidebar-thread"><span>Turning</span><span class="threads-sidebar-thread-trailing"><span class="turning">s</span><span class="threads-sidebar-draft-icon">d</span></span></button></div>
    <div class="threads-sidebar-thread-container"><button class="threads-sidebar-thread"><span>Asks</span><span class="threads-sidebar-thread-trailing"><svg class="threads-sidebar-status-icon threads-sidebar-status-icon--question"></svg></span></button></div>
    <div class="threads-sidebar-thread-container"><button class="threads-sidebar-thread threads-sidebar-card"><span class="threads-sidebar-card-mark">m</span><span class="threads-sidebar-card-body"><span class="threads-sidebar-card-meta"><span class="threads-sidebar-card-project">p</span><span class="threads-sidebar-card-status threads-sidebar-card-status-input">Input</span></span><span class="threads-sidebar-card-title">Card</span></span></button></div>
  </div></aside>
  <div class="chat"><div class="mousse-chat-shell"><div class="an-message-list-wrap"><div class="an-message-list"><div id="turns"></div></div><button class="chat-jump">Go to latest</button></div>
    <div class="chat-composer-stack"><div class="composer"><textarea class="composer-input"></textarea></div></div></div></div>
</div>`

const TURN = `<div data-turn-key="TURN"><div class="chat-prompt-column"><div data-prompt-id="TURN"><p>Question TURN</p></div></div>
  <div class="turn-answer"><div class="group/assistant-turn">
    <div class="an-tool-chrome an-tool-row-line group/edit-line"><button>Edited file.ts</button><span class="an-edit-row-actions"><button>Changes</button></span></div>
    <div class="group/assistant-text"><div class="an-markdown"><p>An answer with <code>code</code> and <strong>words</strong>.</p>
      <div><div data-streamdown="code-block-actions"><button>Copy</button></div><pre><code><span class="an-tok-1">const</span> <span class="an-tok-2">x</span> = 1</code></pre></div>
      <ul><li>one</li><li>two</li></ul></div></div>
  </div></div></div>`

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const server = createServer((request, response) => {
    const asset = request.url === '/styles.css' ? 'css/styles.css' : null
    response.setHeader('Content-Type', asset ? 'text/css' : 'text/html')
    response.end(asset ? readFileSync(join(directory, asset)) : '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><body></body></html>')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const debug = window.webContents.debugger
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    await execute(`document.body.innerHTML = ${JSON.stringify(PAGE)};
      document.getElementById('turns').innerHTML = Array.from({ length: ${TURNS} }, (_, i) => ${JSON.stringify(TURN)}.replaceAll('TURN', String(i))).join('');
      getComputedStyle(document.body).color`)
    debug.attach('1.3')
    /** Elements Chromium restyles after one span is added to a code block in the middle of the transcript. */
    const restyledByOneInsert = async (): Promise<number> => {
      await execute('document.body.offsetHeight')
      const counts: number[] = []
      const onMessage = (_event: unknown, method: string, params: { value?: Array<{ name: string; ph: string; args?: { elementCount?: number } }> }) => {
        if (method !== 'Tracing.dataCollected') return
        for (const event of params.value ?? []) if (event.name === 'UpdateLayoutTree' && event.ph === 'X') counts.push(event.args?.elementCount ?? 0)
      }
      debug.on('message', onMessage)
      const complete = new Promise<void>(done => debug.on('message', (_event, method) => { if (method === 'Tracing.tracingComplete') done() }))
      await debug.sendCommand('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'], excludedCategories: ['*'] } })
      await execute(`(() => { const code = document.querySelectorAll('.an-markdown pre code')[${Math.floor(TURNS / 2)}];
        const span = document.createElement('span'); span.className = 'an-tok-3'; span.textContent = 'y'; code.appendChild(span);
        getComputedStyle(span).color; window.__added = span })()`)
      await debug.sendCommand('Tracing.end')
      await complete
      debug.removeListener('message', onMessage)
      await execute('window.__added.remove(); document.body.offsetHeight')
      return counts.reduce((sum, count) => sum + count, 0)
    }
    const elements = await execute<number>("document.getElementsByTagName('*').length")
    const appCss = await restyledByOneInsert()
    // Control: one rule of the shape that used to ship (a :has() on an ancestor, with any element as its subject).
    await execute(`document.head.insertAdjacentHTML('beforeend', '<style>:where(.group\\\\/edit-line):has(:focus-visible) * { outline-offset: 1px }</style>'); document.body.offsetHeight`)
    const withAncestorHas = await restyledByOneInsert()
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ elements, appCss, withAncestorHas }))
  } finally {
    if (debug.isAttached()) debug.detach()
    window.destroy()
    server.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
