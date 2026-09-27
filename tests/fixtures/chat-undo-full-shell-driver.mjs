import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(readFileSync(process.env.MOUSSE_CHAT_UNDO_CONFIG, 'utf8'))
const cli = process.argv.includes('--cli')
const timer = cli ? undefined : setTimeout(() => { console.error('Chat Undo driver timed out'); app.exit(1) }, 55_000)
async function until(read, accept, label) {
  let value
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 50))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
function nativeMessages() {
  const manifestPath = join(config.threadDirectory, 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return JSON.parse(readFileSync(join(config.threadDirectory, 'generations', manifest.currentGenerationId, 'llm-context.json'), 'utf8')).messages
  }
  const statePath = join(config.threadDirectory, 'conversation-state.json')
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8')).llmContext.messages
  return JSON.parse(readFileSync(join(config.threadDirectory, 'llm-context.json'), 'utf8')).messages
}
async function run() {
  await app.whenReady()
  const win = await until(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/renderer/index.html')), Boolean, 'Actual app window missing')
  win.webContents.setBackgroundThrottling(false)
  const evaluate = source => win.webContents.executeJavaScript(source)
  await until(() => evaluate('Boolean(window.mousse && document.querySelector("#root")?.children.length)'), Boolean, 'Actual app not ready')
  await evaluate(`window.mousse.threads.select(${JSON.stringify(config.threadId)})`)
  const verify = async undone => {
    await until(() => evaluate(`(async()=>({text:document.body.innerText,messages:await window.mousse.orchestrator.getMessages(${JSON.stringify(config.threadId)})}))()`), state => {
      return state.text.includes(config.replies[0]) && state.messages.length === (undone ? 2 : 4)
        && state.text.includes(config.replies[1]) === !undone && state.text.includes(config.prompts[1]) === !undone
    }, undone ? 'Undo did not rewind actual chat transcript' : 'Redo did not restore actual chat transcript')
    const expected = undone ? config.firstNativeMessages : config.fullNativeMessages
    await until(() => nativeMessages(), value => JSON.stringify(value) === JSON.stringify(expected), 'Durable native context mismatch')
    if (readFileSync(config.sentinel, 'utf8') !== 'No chat turn may change this file.\n') throw new Error('Chat Undo changed unrelated file bytes')
  }
  const undo = async () => {
    await until(() => evaluate(`(() => { const buttons=[...document.querySelectorAll('button[aria-label="Undo"]')]; return buttons.filter(button=>!button.disabled).length })()`), count => count === 1, 'Actual message toolbar Undo not enabled')
    await evaluate(`document.querySelector('button[aria-label="Undo"]:not(:disabled)').click()`)
    await verify(true)
  }
  const redo = async () => {
    await until(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Redo last undo' && !button.disabled))`), Boolean, 'Projectless Redo unavailable')
    await evaluate(`([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Redo last undo' && !button.disabled)).click()`)
    await verify(false)
  }
  if (config.phase === 'restart') {
    await verify(true)
    await redo()
  } else {
    await verify(false)
    for (let index = 0; index < 2; index++) { await undo(); await redo() }
    await undo()
    await evaluate(`window.mousse.threads.select(${JSON.stringify(config.legacyThreadId)})`)
    await until(() => evaluate('document.body.innerText'), text => text.includes('Legacy ordinary prompt.'), 'Legacy thread did not render')
    const legacy = await evaluate(`[...document.querySelectorAll('button[aria-label="Undo"]')].map(button=>({disabled:button.disabled,title:button.title}))`)
    if (!legacy.length || legacy.some(button => !button.disabled || !button.title)) throw new Error(`Legacy Undo must be visibly unavailable: ${JSON.stringify(legacy)}`)
  }
  writeFileSync(config.evidence, JSON.stringify({ phase: config.phase, actualMessageToolbar: true, nativeContextExact: true, unchangedFiles: true, restartRedo: config.phase === 'restart' }))
}
await import(pathToFileURL(config.mainEntry).href)
if (!cli) void run().then(() => { clearTimeout(timer); app.quit() }, error => { console.error(error); clearTimeout(timer); app.exit(1) })
