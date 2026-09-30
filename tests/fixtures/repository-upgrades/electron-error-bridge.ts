import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { GuiMmsController } from '../../../src/main/mms/GuiMmsController'
import { registerGuiIpc } from '../../../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../../../src/main/mms/PresentationState'
import { getDefaultSettings } from '../../../src/shared/settings'

const config = JSON.parse(readFileSync(process.env.MOUSSE_ERROR_BRIDGE_CONFIG!, 'utf8')) as {
  home: string; endpoint: string; ownerToken: string; preload: string; evidence: string; userData: string
}
app.setPath('userData', config.userData)
app.disableHardwareAcceleration()
const timer = setTimeout(() => app.exit(2), 30_000)
timer.unref()

async function run() {
  await app.whenReady()
  const guiMms = new GuiMmsController({ homeDir: config.home, endpointOverride: config.endpoint,
    ownerTokenOverride: config.ownerToken, disableAutoStart: true, requestTimeoutMs: 5000 })
  guiMms.on('error', () => {})
  const win = new BrowserWindow({ show: false, webPreferences: { preload: config.preload,
    sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const defaults = getDefaultSettings()
  // Only IPC transport is under test. Local file/browser/window operations are
  // never invoked; their host services remain inert in this disposable app.
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: { get: () => defaults } as never,
    fileService: {} as never, gitService: {} as never, browserView: { init: () => {} } as never, repoRoot: config.home }, () => win)
  try {
    await guiMms.start()
    await guiMms.prepareWindow(win.webContents)
    await win.loadURL('data:text/html,<html><body>Production error bridge fixture</body></html>')
    const results = await win.webContents.executeJavaScript(`(async () => {
      const chat = await window.mousse.orchestrator.sendToThread('missing_fixture_thread', { content: 'fixture send' });
      let platform;
      try { await window.mousse.platformRequest.request('integrations.snapshot', {}) }
      catch (error) { platform = { code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo } }
      const localValidation = [];
      for (const [method, params] of [['fixture.not_allowlisted', {}], ['integrations.snapshot', { value: 'x'.repeat(512 * 1024 + 1) }]]) {
        try { await window.mousse.platformRequest.request(method, params) }
        catch (error) { localValidation.push({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo }) }
      }
      const storageErrors = [];
      try { await window.mousse.threads.configureTrash({ graceDays: 0, automaticPurge: false }) }
      catch (error) { storageErrors.push({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo }) }
      const thread = await window.mousse.threads.create('Disposable stale preview fixture');
      await window.mousse.threads.delete(thread.id);
      const { preview } = await window.mousse.threads.purge(thread.id, { preview: true });
      try { await window.mousse.threads.purge(thread.id, { operationId: 'stale-fixture-purge', expectedGeneration: preview.generation, previewDigest: 'incorrect-fixture-digest' }) }
      catch (error) { storageErrors.push({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo }) }
      const inventory = await window.mousse.threads.inventory();
      return { bridgeExposed: typeof window.mousse.orchestrator.sendToThread === 'function', chat, platform, localValidation, storageErrors,
        storageStateAfterStalePreview: inventory.lifecycles.find(record => record.taskId === thread.id)?.state }
    })()`)
    // Controlled GUI transport injection after the actual daemon requests above:
    // Node-style codes must not make arbitrary native exceptions publicly safe.
    const actualRequest = guiMms.request.bind(guiMms)
    guiMms.request = (async (method: string, params?: unknown) => {
      if (method === 'orchestrator.send' || method === 'integrations.snapshot') {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/privateFixture/secret-auth.json'"), {
          code: 'ENOENT', path: '/Users/privateFixture/secret-auth.json'
        })
      }
      return actualRequest(method, params)
    }) as typeof guiMms.request
    const controlledNativeFailure = await win.webContents.executeJavaScript(`(async () => {
      const chat = await window.mousse.orchestrator.sendToThread('controlled_native_failure', { content: 'fixture send' });
      let platform;
      try { await window.mousse.platformRequest.request('integrations.snapshot', {}) }
      catch (error) { platform = { code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo } }
      return { chat, platform }
    })()`)
    writeFileSync(config.evidence, JSON.stringify({ ok: true, ...results, controlledNativeFailure }))
  } finally {
    await guiMms.stop()
    if (!win.isDestroyed()) win.destroy()
  }
}
void run().then(() => { clearTimeout(timer); app.exit(0) }, (error) => {
  writeFileSync(config.evidence, JSON.stringify({ ok: false, message: String(error), stack: error?.stack }))
  process.stderr.write(String(error?.stack ?? error)); app.exit(1)
})
