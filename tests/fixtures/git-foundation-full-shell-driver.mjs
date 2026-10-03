// This wrapper imports the actual built app. It replaces no renderer, preload,
// protocol handler or model adapter. Only initial durable task data is seeded.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(readFileSync(process.env.MOUSSE_FULL_SHELL_CONFIG, 'utf8'))
// GUI startup can relaunch this same Electron entrypoint in CLI/daemon mode.
// The actual app handles that mode; the UI driver must not stop its daemon.
const isCli = process.argv.includes('--cli')
const timer = isCli ? undefined : setTimeout(() => { console.error('Full application driver timed out'); app.exit(1) }, 55_000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, label) {
  const end = Date.now() + 12_000
  let value
  while (Date.now() < end) {
    value = await read()
    if (predicate(value)) return value
    await delay(50)
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function check() {
  await app.whenReady()
  const win = await until(async () => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html')),
    (item) => Boolean(item), 'Production main window did not load')
  win.webContents.setBackgroundThrottling(false)
  const evaluate = (source) => win.webContents.executeJavaScript(source)
  await until(() => evaluate('Boolean(window.mousse && document.querySelector("#root")?.children.length)'), Boolean, 'Production preload/renderer not ready')
  await evaluate(`window.mousse.threads.select(${JSON.stringify(config.threadId)})`)
  await until(() => evaluate('document.body.innerText'), (text) => text.includes('Task value changed to full application bytes.'), 'Seeded task did not render')
  const click = (label) => evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!button || button.disabled) throw Error('Missing/enabled control: '+${JSON.stringify(label)}); button.click();})()`)
  for (let cycle = 1; cycle <= 2; cycle += 1) {
  await until(() => evaluate(`document.querySelectorAll('button[aria-label="Undo"]:not(:disabled)').length`), count => count === 1, `Undo cycle ${cycle} toolbar control unavailable`)
  await evaluate(`document.querySelector('button[aria-label="Undo"]:not(:disabled)').click()`)
  await until(() => evaluate(`(async()=>({text:document.body.innerText,messages:await window.mousse.orchestrator.getMessages(${JSON.stringify(config.threadId)})}))()`),
    (state) => state.text.includes('Redo last undo') && !state.text.includes('Task value changed to full application bytes.') && !state.text.includes('Seeded task change for full application undo qualification.') && state.messages.length === 0,
    `Undo cycle ${cycle} did not refresh the production transcript`)
  if (readFileSync(config.workspace + '/value.txt', 'utf8') !== 'base\n') throw new Error('Undo did not restore task bytes')
  await click('Redo last undo')
  await until(() => evaluate(`(async()=>({text:document.body.innerText,messages:await window.mousse.orchestrator.getMessages(${JSON.stringify(config.threadId)})}))()`),
    (state) => state.text.includes('Task value changed to full application bytes.') && state.messages.length === 2,
    `Redo cycle ${cycle} did not refresh the production transcript`)
  await until(() => evaluate(`({undo:document.querySelectorAll('button[aria-label="Undo"]:not(:disabled)').length,redo:[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Redo last undo')})`),
    state => state.undo === 1 && !state.redo, `Redo cycle ${cycle} did not restore Undo eligibility or left stale Redo`)
  if (readFileSync(config.workspace + '/value.txt', 'utf8') !== 'full application bytes\n') throw new Error('Redo did not restore task bytes')
  if (readFileSync(config.repo + '/value.txt', 'utf8') !== 'base\n') throw new Error('Primary checkout was modified')
  }
  writeFileSync(config.evidence, JSON.stringify({ actualMain: config.mainEntry, cycles: 2, transcriptUndo: true, transcriptRedo: true, taskBytesUndo: true, taskBytesRedo: true, primaryPreserved: true }))
}

await import(pathToFileURL(config.mainEntry).href)
// Electron delays ready until its ESM entrypoint finishes evaluating.
if (!isCli) void check().then(() => {
  clearTimeout(timer)
  app.quit()
}, (error) => {
  console.error(error)
  clearTimeout(timer)
  app.exit(1)
})
