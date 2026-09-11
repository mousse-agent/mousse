import { app, BrowserWindow, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { AttachedBrowserHost } from '../../../../src/main/browser/AttachedBrowserHost'
import { GuiMmsController } from '../../../../src/main/mms/GuiMmsController'
import { profileBrowserPartition } from '../../../../src/main/browser/browserPolicy'

const config = JSON.parse(readFileSync(process.env.MOUSSE_E2E_CONFIG!, 'utf8')) as {
  home: string; endpoint: string; ownerToken: string; profileId: string; threadId: string;
  pageUrl: string; userData: string; evidence: string
}
app.setPath('userData', config.userData)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
const timeout = setTimeout(() => app.exit(2), 90_000)
timeout.unref()

async function run(): Promise<void> {
  await app.whenReady()
  const gui = new GuiMmsController({ homeDir: config.home, endpointOverride: config.endpoint,
    ownerTokenOverride: config.ownerToken, disableAutoStart: true, requestTimeoutMs: 45_000 })
  gui.on('error', () => {})
  const host = new AttachedBrowserHost({
    binding: (senderId) => gui.getWindowBindingForSender(senderId),
    request: (sender, method, params) => gui.requestAttachedBrowser(sender, method, params)
  })
  gui.setAttachedBrowserHost(host)
  const window = new BrowserWindow({ show: false, width: 1000, height: 750,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  let guest: WebContents | undefined
  const ready = new Promise<WebContents>((resolve) => {
    window.webContents.on('did-attach-webview', (_event, attached) => {
      host.observeGuest(window.webContents, attached)
      guest = attached
      attached.once('did-finish-load', () => resolve(attached))
    })
  })
  try {
    await gui.start()
    const prepared = await gui.prepareWindow(window.webContents)
    if (prepared.profileId !== config.profileId) throw new Error('Prepared window bound the wrong profile')
    const partition = profileBrowserPartition(config.profileId)
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Mousse browser pipeline</title><webview style="position:absolute;inset:0;width:100%;height:100%" partition="${partition}" src="${config.pageUrl}" webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"></webview>`))
    guest = await ready
    const guestId = guest.id
    await guest.executeJavaScript("document.cookie='existing=preserved; path=/'; document.querySelector('#name').value='before agent'")
    await host.registerTab(window.webContents, { localTabId: 'fixture-tab', webContentsId: guest.id, threadId: config.threadId })
    await host.selectTab(window.webContents, 'fixture-tab', config.threadId)
    const response = await gui.runWithSender(window.webContents, () => gui.request<{ message: string }>('orchestrator.send', {
      threadId: config.threadId, content: 'Use the selected browser tab to fill Name with Mousse pipeline.', mode: 'build'
    }))
    const value = await guest.executeJavaScript("document.querySelector('#name').value")
    const cookie = await guest.executeJavaScript('document.cookie')
    if (value !== 'Mousse pipeline') throw new Error('Native browser action did not reach the existing input: ' + value + '; ' + response.message)
    if (guest.id !== guestId || !cookie.includes('existing=preserved')) throw new Error('Browser identity or cookies were replaced')
    await host.control(window.webContents, 'fixture-tab', 'takeControl')
    await guest.executeJavaScript("document.querySelector('#name').value='human takeover'")
    await host.control(window.webContents, 'fixture-tab', 'resume')
    await host.releaseWindow(window.webContents)
    if (guest.isDestroyed()) throw new Error('Releasing automation destroyed the human tab')
    writeFileSync(config.evidence, JSON.stringify({ ok: true, sameGuest: true, cookiePreserved: true,
      value, takeover: true, resumed: true, automationReleased: true, finalAnswer: response.message }))
  } finally {
    await gui.stop()
    if (!window.isDestroyed()) window.destroy()
  }
}

void run().then(() => { clearTimeout(timeout); app.exit(0) }, (error) => {
  writeFileSync(config.evidence, JSON.stringify({ ok: false, message: String(error), stack: error?.stack }))
  process.stderr.write(String(error?.stack ?? error) + '\n')
  app.exit(1)
})
