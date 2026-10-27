import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { buildMenuTemplate } from '../../../src/main/menu/menuTemplate'
import { attachMenuShortcutGate } from '../../../src/main/menu/menuShortcutGate'
import { attachGuestShortcuts, setGuestShortcuts } from '../../../src/main/menu/guestShortcutForward'
import type { CommandId, ShortcutOverrides } from '../../../src/shared/commands'

const directory = process.env.MOUSSE_MENU_SHORTCUTS_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()

const RECORDER = `<textarea id="field"></textarea><script>
  window.keys = []
  document.getElementById('field').addEventListener('keydown', (event) => {
    window.keys.push({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey })
  })
</script>`

// A chord no registry command uses: proves the native menu path is live in this environment.
const PROBE_ACCELERATOR = 'CommandOrControl+Alt+Shift+9'

void (async () => {
  await app.whenReady()
  writeFileSync(join(directory, 'guest.html'), `<!doctype html><meta charset="utf-8">${RECORDER}`)
  writeFileSync(
    join(directory, 'host.html'),
    `<!doctype html><meta charset="utf-8">${RECORDER}<webview id="guest" src="${pathToFileURL(join(directory, 'guest.html')).href}" style="width:300px;height:200px"></webview>`
  )

  let shortcuts: ShortcutOverrides = {}
  const menuClicks: string[] = []
  let probeClicks = 0
  const rebuildMenu = () => {
    const template = buildMenuTemplate({
      isMac: process.platform === 'darwin',
      isDev: false,
      platform: process.platform,
      shortcuts,
      onRun: (id: CommandId) => menuClicks.push(id)
    })
    template.push({ label: 'Probe', submenu: [{ label: 'Probe', accelerator: PROBE_ACCELERATOR, click: () => (probeClicks += 1) }] })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }
  rebuildMenu()

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true, backgroundThrottling: false }
  })
  const sent: unknown[] = []
  const originalSend = window.webContents.send.bind(window.webContents)
  window.webContents.send = ((channel: string, ...args: unknown[]) => {
    if (channel === 'commands:run') sent.push(args[0])
    return originalSend(channel, ...args)
  }) as typeof window.webContents.send

  attachMenuShortcutGate(window.webContents, () => shortcuts)
  const attached = new Promise<Electron.WebContents>((resolve) => {
    window.webContents.on('did-attach-webview', (_event, guest) => {
      attachGuestShortcuts(guest, window.webContents)
      guest.once('did-finish-load', () => resolve(guest))
    })
  })

  const pause = (ms = 150) => new Promise((done) => setTimeout(done, ms))
  const press = async (target: Electron.WebContents, keyCode: string, modifiers: Electron.InputEvent['modifiers']) => {
    target.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    target.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await pause()
  }
  const keysOf = (target: Electron.WebContents): Promise<{ key: string }[]> => target.executeJavaScript('window.keys')
  const reset = async (...targets: Electron.WebContents[]) => {
    for (const target of targets) await target.executeJavaScript('window.keys.length = 0')
    sent.length = 0
    menuClicks.length = 0
  }
  const control = process.platform === 'darwin' ? 'meta' : 'control'

  try {
    await window.loadFile(join(directory, 'host.html'))
    const guest = await attached
    await window.webContents.executeJavaScript('document.getElementById("field").focus()')
    await guest.executeJavaScript('document.getElementById("field").focus()')

    // 1. A registry chord typed in the window reaches the page and does not also fire the menu item.
    await press(window.webContents, 'N', [control])
    const hostChord = { keys: await keysOf(window.webContents), menuClicks: [...menuClicks] }

    // 2. A chord that is not a registry binding still reaches the native menu (the probe), proving the path is live.
    await reset(window.webContents)
    await press(window.webContents, '9', [control, 'alt', 'shift'])
    const probe = { clicks: probeClicks }

    // 3. Select all is a role chord: it keeps working.
    await window.webContents.executeJavaScript('document.getElementById("field").value = "abc"; document.getElementById("field").focus()')
    await press(window.webContents, 'A', [control])
    const selection = await window.webContents.executeJavaScript(
      '[document.getElementById("field").selectionStart, document.getElementById("field").selectionEnd]'
    )

    // 4. In the browser surface a forwarded chord goes to the window's renderer and not to the page.
    setGuestShortcuts(window.webContents.id, [
      { binding: 'CommandOrControl+K', id: 'palette.open' },
      { binding: 'CommandOrControl+F', id: 'thread.new' }
    ])
    await reset(window.webContents, guest)
    await press(guest, 'K', [control])
    const guestForwarded = { sent: [...sent], keys: await keysOf(guest), menuClicks: [...menuClicks] }

    // 5. New thread rebound to Find: the page keeps the key, nothing is sent and the menu does not fire.
    shortcuts = { 'thread.new': 'CommandOrControl+F' }
    rebuildMenu()
    await reset(window.webContents, guest)
    await press(guest, 'F', [control])
    const guestReserved = { sent: [...sent], keys: await keysOf(guest), menuClicks: [...menuClicks] }

    writeFileSync(
      join(directory, 'evidence.json'),
      JSON.stringify({ ok: true, hostChord, probe, selection, guestForwarded, guestReserved })
    )
    window.destroy()
    app.exit(0)
  } catch (error) {
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error) }))
    window.destroy()
    app.exit(1)
  }
})().catch((error) => {
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error) }))
  app.exit(1)
})
