import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const directory = process.env.MOUSSE_RECENTLY_DELETED_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

void (async () => {
  await app.whenReady()
  const window = new BrowserWindow({ width: 420, height: 720, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source)
  const wait = async (source: string, label: string) => {
    const end = Date.now() + 6000
    while (!await run(source)) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}: ${source}`)
      await sleep(15)
    }
  }
  // Trusted key events, so the browser's own focus movement and button activation run.
  const press = async (key: 'Tab' | 'Enter' | 'Escape' | 'Space', shift = false) => {
    const modifiers = shift ? ['shift' as const] : []
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    if (key === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    if (key === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ', modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    await sleep(80)
  }
  const active = () => run('window.trashFixture.active()')
  const rows = () => run('window.trashFixture.rows()')
  const dialog = () => run('window.trashFixture.dialog()')
  const count = () => run(`document.querySelector('[data-testid=sidebar-trash-count]').textContent`)
  const evidence: Record<string, any> = {}
  try {
    await window.loadFile(join(directory, 'index.html'))
    window.focus(); window.webContents.focus()
    await wait('!!window.trashFixture && !!document.querySelector("[data-testid=sidebar-trash-count]")', 'section')
    await wait('document.querySelector("[data-testid=sidebar-trash-count]").textContent === "3"', 'count')
    evidence.collapsed = await run(`(() => { const toggle = document.querySelector('.threads-sidebar-heading-toggle'); return { expanded: toggle.getAttribute('aria-expanded'), label: toggle.getAttribute('aria-label'), rows: document.querySelectorAll('[data-testid=sidebar-trash-row]').length, count: document.querySelector('[data-testid=sidebar-trash-count]').textContent } })()`)

    // Heading toggle: Enter opens the list.
    await run(`document.querySelector('.threads-sidebar-heading-toggle').focus()`)
    await press('Enter')
    await wait('document.querySelectorAll("[data-testid=sidebar-trash-row]").length === 3', 'rows')
    evidence.opened = { expanded: await run(`document.querySelector('.threads-sidebar-heading-toggle').getAttribute('aria-expanded')`), rows: await rows() }

    // Tab walks the actions row by row; Shift+Tab walks back.
    const tabs: any[] = []
    for (let i = 0; i < 3; i++) { await press('Tab'); tabs.push(await active()) }
    evidence.tabs = tabs
    const back: any[] = []
    for (let i = 0; i < 2; i++) { await press('Tab', true); back.push(await active()) }
    evidence.back = back

    // Space on Restore restores the thread; focus moves on to the next row instead of falling to the page.
    await press('Space')
    await wait('window.trashFixture.rows().length === 2', 'restore refresh')
    await wait('window.trashFixture.active().action !== null', 'focus after restore')
    evidence.restore = { calls: await run('window.trashFixture.calls.restore'), rows: await rows(), active: await active(), count: await count() }

    // Delete permanently... opens the confirmation; Escape closes it and returns to the button; nothing is deleted.
    await press('Tab')
    evidence.beforeDelete = await active()
    await press('Enter')
    await wait('!!window.trashFixture.dialog()', 'dialog')
    await wait('window.trashFixture.active().inDialog', 'dialog focus')
    evidence.dialogOpened = { dialog: await dialog(), active: await active() }
    await press('Escape')
    await wait('!window.trashFixture.dialog()', 'dialog closed')
    await wait('window.trashFixture.active().action === "delete"', 'focus back on delete')
    evidence.escaped = { active: await active(), purges: await run('window.trashFixture.calls.purge'), rows: await rows() }

    // Open again, accept the unpublished work with Space, and reach the confirm button by Tab. The daemon refuses once.
    await press('Enter')
    await wait('!!window.trashFixture.dialog() && window.trashFixture.active().inDialog', 'dialog again')
    await press('Space')
    evidence.accepted = await dialog()
    await run(`window.trashFixture.failPurge('middle', { code: 'resource_purge_io_error', message: 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.', errorInfo: { category: 'conflict', retryable: false } })`)
    const dialogTabs: any[] = []
    for (let i = 0; i < 3; i++) { await press('Tab'); dialogTabs.push(await active()) }
    evidence.dialogTabs = dialogTabs
    await press('Enter')
    await wait('window.trashFixture.dialog()?.error', 'refusal reason')
    evidence.refused = { dialog: await dialog(), purges: await run('window.trashFixture.calls.purge'), rows: await rows() }
    await press('Escape')
    await wait('!window.trashFixture.dialog()', 'dialog closed after refusal')
    await wait('window.trashFixture.active().action === "delete"', 'focus back after refusal')
    evidence.afterRefusal = { active: await active(), rows: await rows() }

    // The lock is gone: the same keys finish the deletion and focus lands on the remaining thread.
    await run(`window.trashFixture.failPurge('middle', null)`)
    await press('Enter')
    await wait('!!window.trashFixture.dialog() && window.trashFixture.active().inDialog', 'dialog third time')
    evidence.reopened = await dialog()
    await press('Space')
    for (let i = 0; i < 3; i++) await press('Tab')
    await press('Enter')
    await wait('window.trashFixture.rows().length === 1', 'purge refresh')
    await wait('!window.trashFixture.dialog()', 'dialog closed after purge')
    await wait('window.trashFixture.active().action !== null', 'focus after purge')
    evidence.purged = { rows: await rows(), active: await active(), purges: await run('window.trashFixture.calls.purge'), count: await count() }

    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: true, errors, ...evidence }))
    window.destroy()
    app.exit(0)
  } catch (error) {
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error), errors, ...evidence }))
    window.destroy()
    app.exit(1)
  }
})().catch((error) => { writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error) })); app.exit(1) })
