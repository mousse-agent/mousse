// Runs the actual built Electron main, production preload, renderer and owned daemon.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const config = JSON.parse(readFileSync(process.env.MOUSSE_FULL_SHELL_CONFIG, 'utf8'))
const isCli = process.argv.includes('--cli')
const timer = isCli ? undefined : setTimeout(() => { console.error('Lifecycle full shell timed out'); app.exit(1) }, 85000)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let stage = 'startup'
async function until(read, predicate, label) {
  stage = label
  const deadline = Date.now() + 18000
  let value
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; if (typeof value === 'string' && value.includes('Error invoking remote method')) throw new Error(`${label}: ${value}`); await delay(70) }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
async function check() {
  await app.whenReady()
  const win = await until(async () => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html')), Boolean, 'Production main window')
  win.webContents.setBackgroundThrottling(false)
  win.show(); win.focus()
  const evaluate = (source) => win.webContents.executeJavaScript(source).catch((error) => { throw new Error(`${stage}: ${error.message}`, { cause: error }) })
  const text = () => evaluate('document.body.innerText')
  const click = (label) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => (b.getAttribute("aria-label") ?? b.textContent.trim()) === ${JSON.stringify(label)} && b.checkVisibility()); if (!button || button.disabled) throw Error('Visible control unavailable: '+${JSON.stringify(label)}); button.click() })()`)
  const taskRow = `([...document.querySelectorAll('[data-testid="storage-thread-row"]')].find(row=>row.dataset.taskId===${JSON.stringify(config.threadId)}))`
  const clickTask = (label) => evaluate(`(() => {const row=${taskRow}; const button=[...row.querySelectorAll('button')].find(button=>(button.getAttribute("aria-label") ?? button.textContent.trim())===${JSON.stringify(label)} && button.checkVisibility()); if(!button || button.disabled) throw Error('Visible task control unavailable: '+${JSON.stringify(label)});button.click()})()`)
  const screenshot = async (name) => {
    win.show(); win.focus(); win.webContents.invalidate()
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(400)
    writeFileSync(join(config.evidenceDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const proof = { actualMain: config.mainEntry }
  await until(() => evaluate('Boolean(window.mousse && document.querySelector("#root")?.children.length)'), Boolean, 'Production preload')
  await evaluate(`window.mousse.threads.select(${JSON.stringify(config.threadId)})`)
  await until(text, value => value.includes('Task value changed to full application bytes.'), 'Expired task transcript')
  const expiredHistory = await evaluate(`window.mousse.actions.list(${JSON.stringify(config.threadId)})`)
  if (expiredHistory.undoTarget || expiredHistory.actions.at(-1)?.retention?.state !== 'expired') throw Error('Seeded task does not have expired Undo history')
  if (await evaluate(`document.querySelectorAll('button[aria-label="Undo"]').length`)) throw Error('Expired prompt incorrectly exposes Undo')
  proof.expiredUndoUnavailable = true; await screenshot('01-expired-undo')
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`)
  const storageNav = `[...document.querySelectorAll('.settings-nav-item')].find(item => ['Storage', 'Storage & trash'].includes(item.textContent.trim()) && item.checkVisibility())`
  await until(() => evaluate(`Boolean(${storageNav})`), Boolean, 'Settings navigation')
  await evaluate(`${storageNav}.click()`)
  await until(() => evaluate(`document.querySelector('[data-testid="storage-auto-empty-select"]')?.dataset.value`), (value) => value === 'never', 'Storage trash policy')
  const policy = await evaluate(`window.mousse.threads.inventory().then(result => result.trashPolicy)`)
  if (policy.graceDays !== 30 || policy.automaticPurge !== false) throw Error('Trash default policy differs')
  await screenshot('02-storage-policy')
  await evaluate(`document.querySelector('[data-testid="storage-review-trash-button"]').click()`)
  await until(() => evaluate(`Boolean(${taskRow})`), Boolean, 'Storage task controls')
  await clickTask('Move to trash')
  await until(() => evaluate(`Boolean(${taskRow}?.querySelector('button[aria-label="Restore"]'))`), Boolean, 'Reversible trash state')
  await clickTask('Restore')
  await until(async () => evaluate(`window.mousse.threads.inventory()`), (value) => value.lifecycles.find((record) => record.taskId === config.threadId)?.state === 'active', 'Idle task restore')
  await until(() => evaluate(`(() => {const row=${taskRow};return [...row.querySelectorAll('button')].some(button=>(button.getAttribute("aria-label") ?? button.textContent.trim())==='Move to trash' && !button.disabled && button.checkVisibility())})()`), Boolean, 'Restored task control')
  proof.restoreIdle = true
  await clickTask('Move to trash')
  await until(() => evaluate(`Boolean(${taskRow}?.querySelector('button[aria-label="Delete…"]'))`), Boolean, 'Trash review control')
  await clickTask('Delete…')
  await until(() => evaluate(`document.querySelector('[data-testid="storage-deletion-preview"]')?.textContent ?? ''`), (value) => value.includes('freed'), 'Exact permanent preview')
  await screenshot('03-purge-preview')
  await evaluate(`(() => { const dialog=document.querySelector('[aria-label="Permanent deletion preview"]'); const checkbox=dialog.querySelector('input[type="checkbox"]'); if(checkbox) checkbox.click() })()`)
  await click('Delete permanently')
  await until(async () => evaluate(`window.mousse.threads.inventory()`), (value) => value.lifecycles.find((record) => record.taskId === config.threadId)?.state === 'purged', 'Final purge tombstone')
  if (existsSync(config.workspace)) throw Error('Task checkout remains after purge')
  proof.purged = true
  if (readFileSync(join(config.repo, 'value.txt'), 'utf8') !== 'base\n') throw Error('Primary bytes changed')
  proof.primaryPreserved = true; await screenshot('04-purge-complete')
  writeFileSync(config.evidence, JSON.stringify(proof, null, 2))
}
await import(pathToFileURL(config.mainEntry).href)
if (!isCli) void check().then(() => { clearTimeout(timer); app.quit() }, async (error) => {
  console.error(`Lifecycle stage: ${stage}`, error)
  const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html'))
  if (win) {
    const diagnostics = await win.webContents.executeJavaScript(`Promise.allSettled([window.mousse.profiles.removePreview(${JSON.stringify(config.profileId)}),window.mousse.threads.getActivity()])`).catch((failure) => ({ error: String(failure) }))
    console.error('Lifecycle activity diagnostics:', JSON.stringify(diagnostics))
    writeFileSync(join(config.evidenceDir, 'failure-activity.json'), JSON.stringify(diagnostics, null, 2))
  }
  clearTimeout(timer); app.exit(1)
})
