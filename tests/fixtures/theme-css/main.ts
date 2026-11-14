import { app, BrowserWindow, session } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_THEME_CSS_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 40000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

/** Hostile rules, each one a way theme CSS could load a URL, aimed at the leak server. */
function hostile(leak: string): string {
  return [
    // First, or a browser ignores it.
    `@import url(${leak}/import.css);`,
    `#h1 { background-image: url(${leak}/plain) }`,
    `#h2 { background-image: \\75 rl(${leak}/escaped) }`,
    `:root { --leak: url(${leak}/var) } #h3 { background-image: var(--leak) }`,
    `#h4 { background-image: image-set("${leak}/image-set" 1x) }`,
    `#h5 { background-image: -webkit-image-set("${leak}/webkit-image-set" 1x) }`,
    `@font-face { font-family: leakfont; src: url(${leak}/font.woff2) } #h6 { font-family: leakfont }`,
    `@property --p { syntax: '<url>'; inherits: false; initial-value: url(${leak}/property) } #h7 { background-image: var(--p) }`,
    `@keyframes leak { from { background-image: url(${leak}/keyframes) } to { background-image: url(${leak}/keyframes-to) } } #h8 { animation: leak 1s infinite }`,
    `#h9 { & .inner { background-image: url(${leak}/nested) } }`,
    `@media all { #h10 { background-image: url(${leak}/media) } }`,
    `#h11 { cursor: url(${leak}/cursor), auto }`,
    `#h12 { list-style-image: url(${leak}/list) }`,
    `#h13::before { content: url(${leak}/content) }`,
    `#h14 { mask-image: url(${leak}/mask); -webkit-mask-image: url(${leak}/webkit-mask) }`,
    `#h15 { border: 10px solid; border-image: url(${leak}/border) 30 }`,
    `#h16 { --u: no-repeat; background: var(--u) url(${leak}/shorthand) }`,
    `#secret[value^="a"] { background-image: url(${leak}/attr-a) }`,
    `#h17 { background-image: src("${leak}/src") }`,
    `#h18 { background-image: url(${leak.replace('http:', 'HTTP:')}/case) }`
  ].join('\n')
}

/** Safe rules mixed in with the hostile ones: they must still apply. */
const SAFE = [
  '[data-mousse="sidebar"] { background-color: rgb(1, 2, 3) }',
  // One rule with a safe and a hostile declaration: the safe one stays.
  '#mixed { color: rgb(7, 8, 9); background-image: url(LEAK/mixed) }',
  // Invalid CSS is dropped by the browser rule by rule (or declaration by declaration), not the whole theme.
  '#broken { color: ; width: 10px }',
  '#bad:not-a-pseudo-class { color: red }',
  '#after-bad { color: rgb(13, 14, 15) }',
  '@media (min-width: 1px) { #in-media { color: rgb(16, 17, 18) } }',
  `#keep-data { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E") }`,
  '@keyframes fine { from { opacity: 0.5 } to { opacity: 0.6 } } #keep-anim { animation: fine 1s infinite }',
  '#keep-nest { & .inner { color: rgb(19, 20, 21) } }'
].join('\n')

const ELEMENTS = [
  '<div data-mousse="sidebar">sidebar</div>',
  '<div id="mixed">mixed</div><div id="broken">broken</div><div id="after-bad">after</div><div id="in-media">media</div>',
  '<div id="keep-data">data</div><div id="keep-anim">anim</div><div id="keep-nest"><span class="inner">nest</span></div>',
  ...Array.from({ length: 18 }, (_, index) => `<div id="h${index + 1}">hostile ${index + 1} <span class="inner">inner</span></div>`).filter((html) => !html.includes('id="h12"')),
  '<ul><li id="h12">list</li></ul>',
  '<input id="secret" value="abc">'
].join('')

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const leakHits: string[] = []
  const leakServer = createServer((request, response) => { leakHits.push(request.url ?? ''); response.statusCode = 404; response.end() })
  await new Promise<void>(done => leakServer.listen(0, '127.0.0.1', done))
  const leak = `http://127.0.0.1:${(leakServer.address() as { port: number }).port}/leak`
  const server = createServer((request, response) => {
    if (request.url === '/entry.js') {
      response.setHeader('Content-Type', 'application/javascript')
      response.end(readFileSync(join(directory, 'entry.js')))
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><meta charset="utf-8"><body>${ELEMENTS}<script src="/entry.js"></script></body></html>`)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  // Every request the page makes once it has loaded: none may come from the theme.
  let recording = false
  const requested: string[] = []
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (recording) requested.push(details.url)
    callback({})
  })
  const window = new BrowserWindow({ show: false, width: 800, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const execute = async <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  try {
    await window.loadURL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    for (let index = 0; index < 150 && !(await execute<boolean>('Boolean(window.qa)')); index++) await delay(20)
    recording = true
    const css = `${hostile(leak)}\n${SAFE.replaceAll('LEAK', leak)}`
    const dropped = await execute<number>(`qa.apply(${JSON.stringify(css)})`)
    await execute('qa.frames(5)')
    await delay(800)
    const measured = await execute('qa.measure()')
    const theme = { requested: [...requested], leakHits: [...leakHits], dropped, measured }
    // The control: the same CSS unchecked must reach the leak server, or the test could not see a leak.
    await execute('qa.clear()')
    requested.length = 0
    leakHits.length = 0
    await execute(`qa.raw(${JSON.stringify(css)})`)
    await execute('qa.frames(5)')
    await delay(800)
    const control = { requested: [...requested], leakHits: [...leakHits] }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ theme, control, pageErrors: await execute('qa.errors()') }))
  } finally {
    window.destroy()
    server.close()
    leakServer.close()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
