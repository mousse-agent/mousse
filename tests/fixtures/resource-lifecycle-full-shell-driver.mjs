// Runs the actual built Electron main, production preload, renderer and owned daemon.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const config = JSON.parse(readFileSync(process.env.MOUSSE_FULL_SHELL_CONFIG, 'utf8'))
const isCli = process.argv.includes('--cli')
const timer = isCli ? undefined : setTimeout(() => { console.error('Lifecycle full shell timed out'); app.exit(1) }, 85000)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, predicate, label) {
  const deadline = Date.now() + 18000
  let value
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await delay(70) }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
async function check() {
  await app.whenReady()
  const win = await until(async () => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html')), Boolean, 'Production main window')
  win.webContents.setBackgroundThrottling(false)
  const evaluate = (source) => win.webContents.executeJavaScript(source)
  const text = () => evaluate('document.body.innerText')
  const click = (label) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('Control unavailable: '+${JSON.stringify(label)}); button.click() })()`)
  const screenshot = async (name) => writeFileSync(join(config.evidenceDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  const proof = { actualMain: config.mainEntry }
  await until(() => evaluate('Boolean(window.mousse && document.querySelector("#root")?.children.length)'), Boolean, 'Production preload')
  await evaluate(`window.mousse.threads.select(${JSON.stringify(config.threadId)})`)
  await until(text, (value) => value.includes('Undo expired'), 'Expired Undo state')
  proof.expiredUndoVisible = true; await screenshot('01-expired-undo')
  await evaluate(`document.querySelector('nav[aria-label="Main area view"] button[aria-label="Agents"]').click()`)
  await until(text, (value) => value.includes('Named agents'), 'Named agents surface')
  await click('Named agents')
  await until(text, (value) => value.includes('UI Reviewer'), 'Retained named identity')
  await click('UI Reviewer · dormant')
  await until(text, (value) => value.includes('Recall UI Reviewer') && value.includes('Continue saved context'), 'Recall context controls')
  const policies = await evaluate(`({workspace:document.querySelector('[aria-label="Agent workspace"]').value,access:document.querySelector('[aria-label="Agent access"]').value,context:document.querySelector('[aria-label="Recall context"]').value})`)
  if (policies.workspace !== 'isolated' || policies.access !== 'write' || policies.context !== 'continue') throw Error('Recall did not expose saved policies')
  proof.namedRecallVisible = true; await screenshot('02-named-recall')
  await click('Review integration')
  await until(text, (value) => value.includes('Integrate isolated result') && value.includes('named-ui.txt'), 'Real integration file summary')
  await evaluate(`document.querySelector('[aria-label="Integrate isolated result"] details').open = true`)
  await until(text, (value) => value.includes('+reviewed named result'), 'Real integration diff')
  proof.integrationDiffVisible = true; await screenshot('03-named-integration-diff')
  await click('Integrate result')
  await until(text, (value) => value.includes('· integrated') && !value.includes('Integrate isolated result'), 'Integration completion')
  if (readFileSync(join(config.workspace, 'named-ui.txt'), 'utf8') !== 'reviewed named result\n') throw Error('Integration bytes differ')
  proof.integrationApplied = true
  await click('New agent')
  const defaults = await evaluate(`({workspace:document.querySelector('[aria-label="Agent workspace"]').value,access:document.querySelector('[aria-label="Agent access"]').value})`)
  if (defaults.workspace !== 'shared' || defaults.access !== 'read-only') throw Error('New agent defaults are incorrect')
  proof.newAgentDefaultsVisible = true
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`)
  await until(text, (value) => value.includes('Storage & trash'), 'Settings navigation')
  await click('Storage & trash')
  await until(text, (value) => value.includes('Move to trash'), 'Storage task controls')
  const days = await evaluate(`document.querySelector('[aria-label="Trash grace period in days"]').value`)
  if (days !== '30') throw Error('Trash default grace differs')
  await screenshot('04-storage-policy')
  await click('Move to trash')
  await until(text, (value) => value.includes('Restore idle task'), 'Reversible trash state')
  await click('Restore idle task')
  await until(text, (value) => value.includes('Move to trash'), 'Idle task restore')
  const restored = await evaluate(`window.mousse.threads.inventory()`)
  if (restored.lifecycles.find((record) => record.taskId === config.threadId)?.state !== 'active') throw Error('Restore did not restore active identity')
  proof.restoreIdle = true
  await click('Move to trash')
  await until(text, (value) => value.includes('Review permanent deletion'), 'Trash review control')
  await click('Review permanent deletion')
  await until(text, (value) => value.includes('Review permanent deletion') && value.includes('exclusive resources'), 'Exact permanent preview')
  await screenshot('05-purge-preview')
  await evaluate(`(() => { const dialog=document.querySelector('[aria-label="Permanent deletion preview"]'); const checkbox=dialog.querySelector('input[type="checkbox"]'); if(checkbox) checkbox.click() })()`)
  await click('Permanently delete')
  await until(async () => evaluate(`window.mousse.threads.inventory()`), (value) => value.lifecycles.find((record) => record.taskId === config.threadId)?.state === 'purged', 'Final purge tombstone')
  if (existsSync(config.workspace)) throw Error('Task checkout remains after purge')
  proof.purged = true
  if (readFileSync(join(config.repo, 'value.txt'), 'utf8') !== 'base\n' || existsSync(join(config.repo, 'named-ui.txt'))) throw Error('Primary bytes changed')
  proof.primaryPreserved = true; await screenshot('06-purge-complete')
  writeFileSync(config.evidence, JSON.stringify(proof, null, 2))
}
await import(pathToFileURL(config.mainEntry).href)
if (!isCli) void check().then(() => { clearTimeout(timer); app.quit() }, (error) => { console.error(error); clearTimeout(timer); app.exit(1) })
