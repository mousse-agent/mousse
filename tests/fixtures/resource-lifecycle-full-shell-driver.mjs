// Runs the actual built Electron main, production preload, renderer and owned daemon.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exitWithParent, keepWindowsOffScreen } from './fullShellWindow.mjs'
import { runWithoutGpu } from './electronWithoutGpu.mjs'
const config = JSON.parse(readFileSync(process.env.MOUSSE_FULL_SHELL_CONFIG, 'utf8'))
const isCli = process.argv.includes('--cli')
// Also in the --cli relaunch (the daemon): it opens no window, and the GPU stays off there too.
runWithoutGpu({ app, BrowserWindow })
if (!isCli) { keepWindowsOffScreen(); exitWithParent() }
const timer = isCli ? undefined : setTimeout(() => { console.error('Lifecycle full shell timed out'); app.exit(1) }, 140000)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let stage = 'startup'
async function until(read, predicate, label, ms = 18000) {
  stage = label
  const deadline = Date.now() + ms
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
  const threadRow = `document.querySelector('.threads-sidebar-thread[data-thread-id=${JSON.stringify(config.threadId)}]')`
  const rowAction = (action) => evaluate(`(() => {const button=${threadRow}?.closest('.threads-sidebar-thread-container')?.querySelector('button[data-action=${JSON.stringify(action)}]'); if(!button || button.disabled) throw Error('Row control unavailable: '+${JSON.stringify(action)});button.click()})()`)
  const screenshot = async (name) => {
    win.show(); win.focus(); win.webContents.invalidate()
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(400)
    writeFileSync(join(config.evidenceDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const proof = { actualMain: config.mainEntry }
  // The daemon's own record of the thread, read from disk: the app no longer lists lifecycle records.
  const lifecycleState = async () => { try { return JSON.parse(readFileSync(join(config.home, 'profiles', config.profileId, 'lifecycle', 'tasks', `${config.threadId}.json`), 'utf8')).state } catch { return undefined } }
  const settled = () => evaluate(`window.mousse.threads.listAll().then((threads) => Boolean(threads.find((thread) => thread.id === ${JSON.stringify(config.threadId)})?.settledAt))`)
  // Archive and Unarchive from the thread's context menu in the sidebar, the way a person does.
  const fromMenu = async (item, want, label) => {
    await until(() => evaluate(`Boolean(${threadRow})`), Boolean, `${label}: row`)
    await evaluate(`${threadRow}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`)
    await click(item)
    await until(settled, (value) => value === want, label)
  }
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
  // Threads no longer wait in a trash, so Storage has no trash rule.
  await until(() => evaluate(`Boolean(document.getElementById('storage-worktrees'))`), Boolean, 'Storage rules')
  if (await evaluate(`Boolean(document.getElementById('storage-trash') || document.querySelector('[data-testid="storage-auto-empty-select"]'))`)) throw Error('Storage still shows a trash rule')
  await screenshot('02-storage-policy')
  // Leave Settings, archive the thread, bring it back, archive it again and delete it from Archived.
  await click('Back')
  await click('Threads')
  await until(() => evaluate(`Boolean(${threadRow})`), Boolean, 'Sidebar thread row')
  // A thread that is not archived offers no Delete. "Delete after ›" sets when the thread expires; it deletes nothing now.
  await evaluate(`${threadRow}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`)
  await until(() => evaluate(`document.querySelectorAll('.threads-context-menu button').length`), (count) => count > 0, 'Thread context menu')
  if (await evaluate(`[...document.querySelectorAll('.threads-context-menu button')].some((b) => /^Delete(…|\\.\\.\\.)?$/.test(b.textContent.trim()))`)) throw Error('A thread that is not archived offers Delete')
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  proof.noDeleteBeforeArchive = true
  await fromMenu('Archive', true, 'Archive from the sidebar')
  await evaluate(`(() => { const toggle = document.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle'); if (!toggle) throw Error('Archived heading unavailable'); if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click() })()`)
  await until(() => evaluate(`Boolean(${threadRow}?.classList.contains('settled'))`), Boolean, 'Archived row')
  if ((await lifecycleState()) !== 'active') throw Error('Archiving moved the thread out of place')
  proof.archivedFromSidebar = true
  await screenshot('02b-archived')
  await fromMenu('Unarchive', false, 'Unarchive')
  proof.unarchived = true
  await fromMenu('Archive', true, 'Archive again')
  await until(() => evaluate(`Boolean(${threadRow}?.classList.contains('settled'))`), Boolean, 'Archived row again')
  await rowAction('delete')
  await until(() => evaluate(`Boolean(document.querySelector('[data-testid="archived-delete-confirm"]'))`), Boolean, 'Delete confirmation')
  await screenshot('03-delete-confirm')
  // The daemon refuses a mutation while the app has requests in flight and says why; the dialog stays open with that reason, so press Delete again.
  let pressed = 0
  await until(async () => {
    const state = await lifecycleState()
    if (state !== 'purged' && Date.now() - pressed > 3000) await evaluate(`(() => { const button = document.querySelector('[data-testid="archived-delete-confirm"]'); if (button && !button.disabled) button.click() })()`).then(() => { pressed = Date.now() })
    return state
  // The purge removes the live worktree whole, which takes a while on Windows.
  }, (state) => state === 'purged', 'Permanent delete', 60000)
  await until(() => evaluate(`!${threadRow} && !document.querySelector('[role="dialog"]')`), Boolean, 'Deleted thread leaves the list')
  if (existsSync(config.workspace)) throw Error('Task checkout remains after delete')
  proof.purged = true
  if (readFileSync(join(config.repo, 'value.txt'), 'utf8') !== 'base\n') throw Error('Primary bytes changed')
  proof.primaryPreserved = true; await screenshot('04-delete-complete')
  writeFileSync(config.evidence, JSON.stringify(proof, null, 2))
}
// A main entry that fails to load (no build in out/, a broken bundle) exits here: left alone, Electron shows
// its error dialog, a real window, until the test times out.
try { await import(pathToFileURL(config.mainEntry).href) } catch (error) { console.error(error); app.exit(1) }
if (!isCli) void check().then(() => { clearTimeout(timer); app.quit() }, async (error) => {
  console.error(`Lifecycle stage: ${stage}`, error)
  const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('/renderer/index.html'))
  if (win) {
    const diagnostics = await win.webContents.executeJavaScript(`Promise.allSettled([window.mousse.profiles.removePreview(${JSON.stringify(config.profileId)}),window.mousse.threads.getActivity(),Promise.resolve(document.querySelector('[role="dialog"]')?.innerText ?? null)])`).catch((failure) => ({ error: String(failure) }))
    console.error('Lifecycle activity diagnostics:', JSON.stringify(diagnostics))
    writeFileSync(join(config.evidenceDir, 'failure-activity.json'), JSON.stringify(diagnostics, null, 2))
  }
  clearTimeout(timer); app.exit(1)
})
