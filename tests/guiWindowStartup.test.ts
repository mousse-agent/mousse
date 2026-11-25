import { expect, it, vi } from 'vitest'
import { readStartupAppearanceArgument } from '../src/shared/startupAppearance'

const startup = vi.hoisted(() => {
  let ready!: (value: unknown) => void
  const pending = new Promise(done => { ready = done })
  // A feature someone passed on the command line, which the app must keep.
  const switches = new Map([['enable-features', 'FeatureFromCommandLine']])
  return {
    pending, ready, ipc: false, chrome: false, windows: [] as Array<any>, controller: null as any, controllers: [] as Array<any>, ipcDeps: null as any, failLoads: 0, switches, featuresWhenReady: undefined as string | undefined,
    // The notification-area icon main makes on Windows.
    tray: { enabled: false, made: [] as Array<{ destroyed: boolean; template: Array<{ label?: string; click?: () => void }> }> },
    stopServiceForQuit: null as any
  }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => { startup.featuresWhenReady ??= startup.switches.get('enable-features'); return Promise.resolve() },
    requestSingleInstanceLock: () => true,
    quit: vi.fn(), isPackaged: false, name: 'Mousse', getVersion: () => 'test',
    // The warm start file's folder: none, so the window opens without one.
    getPath: (name: string) => `${process.env.TMP ?? '/tmp'}/mousse-startup-test-${name}-missing`,
    commandLine: {
      getSwitchValue: (name: string) => startup.switches.get(name) ?? '',
      appendSwitch: (name: string, value = '') => { startup.switches.set(name, value) }
    }
  })
  class BrowserWindow extends EventEmitter {
    readonly #webContents = Object.assign(new EventEmitter(), {
      id: 123, setWindowOpenHandler: vi.fn(), isDestroyed: () => false
    })
    // As in Electron: a destroyed window's webContents cannot be read, also not in its own `closed`.
    get webContents() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
      return this.#webContents
    }
    readonly close = vi.fn(() => {
      setTimeout(() => { this.destroyed = true; this.emit('closed') }, 1)
    })
    readonly loadURL = vi.fn(async (url: string) => {
      if (startup.failLoads > 0) { startup.failLoads--; throw new Error('load failed') }
      expect(startup.ipc).toBe(true)
      expect(startup.chrome).toBe(true)
      expect(url).not.toMatch(/^data:/)
      this.emit('ready-to-show')
    })
    readonly loadFile = vi.fn(async () => {
      if (startup.failLoads > 0) { startup.failLoads--; throw new Error('load failed') }
      expect(startup.ipc).toBe(true)
      expect(startup.chrome).toBe(true)
      this.emit('ready-to-show')
    })
    readonly show = vi.fn()
    readonly focus = vi.fn()
    // Linux window shaping reads bounds and state on attach.
    readonly getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 })
    readonly setShape = vi.fn()
    isMaximized() { return false }
    isFullScreen() { return false }
    constructor(readonly options: unknown) { super(); startup.windows.push(this) }
    destroyed = false
    isDestroyed() { return this.destroyed }
    static getAllWindows() { return startup.windows }
  }
  class Tray {
    destroyed = false
    template: Array<{ label?: string; click?: () => void }> = []
    constructor() { startup.tray.made.push(this) }
    setToolTip() {}
    setContextMenu(menu: { template: Array<{ label?: string; click?: () => void }> }) { this.template = menu.template }
    on() {}
    destroy() { this.destroyed = true }
  }
  return {
    app, BrowserWindow, Tray, Menu: { buildFromTemplate: (template: unknown) => ({ template }) }, ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    nativeTheme: { shouldUseDarkColors: true },
    powerSaveBlocker: { start: () => 0, stop: () => undefined },
    dialog: { showErrorBox: vi.fn() }, shell: { openExternal: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    session: { fromPartition: () => ({ getUserAgent: () => 'test', setUserAgent: vi.fn() }) }
  }
})
vi.mock('../src/cli/cliLaunch', () => ({ detectCliMode: () => false, stripCliModeArgs: (args: unknown) => args }))
vi.mock('../src/cli/electronContext', () => ({ configureElectronContext: vi.fn() }))
vi.mock('../src/mms/config/MousseConfigStore', () => ({ MousseConfigStore: { load: () => ({}) } }))
vi.mock('../src/main/startupAppearance', () => ({ readStartupAppearance: (_home: string, fallback: unknown) => fallback }))
vi.mock('../src/mms/settings/SettingsStore', async () => {
  const { getDefaultSettings } = await import('../src/shared/settings')
  return { SettingsStore: class { get() { return getDefaultSettings() }; set() {} } }
})
vi.mock('../src/main/mms/GuiMmsController', () => ({ GuiMmsController: class {
  start = vi.fn(() => startup.pending)
  prepareWindow = vi.fn(() => startup.pending)
  request = vi.fn(async () => ({ settings: {} }))
  on = vi.fn()
  setAttachedBrowserHost = vi.fn()
  setConnectionLog = vi.fn()
  getWindowBindingForSender = vi.fn(() => null)
  constructor() { startup.controller = this; startup.controllers.push(this) }
} }))
// The real log would write under the home this test resolves, which is not a test folder.
vi.mock(import('../src/main/mms/guiConnectionLog'), async (importOriginal) => ({ ...await importOriginal(), GuiConnectionLog: class {
  write = vi.fn()
  undeliverable = vi.fn()
  flushSync = vi.fn()
} }))
vi.mock('../src/main/ipc/registerGuiIpc', () => ({
  registerGuiIpc: (deps: unknown) => { startup.ipc = true; startup.ipcDeps = deps },
  attachWindowListeners: () => { startup.chrome = true }
}))
vi.mock('../src/main/fonts/registerFontIpc', () => ({ registerFontIpc: vi.fn() }))
vi.mock('../src/main/browser/BrowserViewManager', () => ({ BrowserViewManager: class {} }))
vi.mock('../src/main/browser/AttachedBrowserHost', () => ({ AttachedBrowserHost: class {} }))
vi.mock('../src/main/appIcon', () => ({ applyAppIcon: vi.fn(), getAppIconPath: () => startup.tray.enabled ? 'icon.png' : undefined }))
vi.mock('../src/main/serviceTray', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/serviceTray')>(),
  usesServiceTray: () => startup.tray.enabled
}))
// Never asks a real service to stop: the home this test resolves is not a test folder.
vi.mock('../src/main/mms/stopServiceForQuit', () => ({ stopServiceForQuit: vi.fn(async () => { startup.stopServiceForQuit?.() }) }))
vi.mock('../src/main/windowsChrome', () => ({ refreshWindowChrome: vi.fn() }))
vi.mock('../src/main/windowResume', () => ({
  mainWindowLoadTarget: () => ({}), registerWindowForResumeRecovery: vi.fn(),
  attachWindowResumeRecovery: vi.fn(), attachWindowWebContentsRecovery: vi.fn()
}))
vi.mock('../src/main/contextMenu', () => ({ attachContextMenu: vi.fn() }))
vi.mock('../src/main/applicationMenu', () => ({ setupApplicationMenu: vi.fn() }))
vi.mock('../src/main/zoomShortcuts', () => ({ attachZoomShortcuts: vi.fn() }))
vi.mock('../src/main/devgui/devGuiMain', () => ({ isDevGuiMainEnabled: () => false }))
vi.mock('../src/main/devgui/devGuiPoller', () => ({ startDevGuiPoller: vi.fn() }))
vi.mock('../src/main/linuxRendering', () => ({ configureLinuxGraphics: () => false, configureLinuxVsync: () => false, configureLinuxWindowing: () => false, linuxTransparencyOptions: () => ({}) }))

it('loads and shows only the real main window while MMS readiness remains withheld', async () => {
  await import('../src/main/index')
  await vi.waitFor(() => expect(startup.windows).toHaveLength(1))
  const window = startup.windows[0]
  await vi.waitFor(() => expect(startup.controller.start).toHaveBeenCalledTimes(1))
  expect(window.options).toMatchObject({ width: 1400, height: 900, title: 'Mousse', show: false })
  expect(readStartupAppearanceArgument(window.options.webPreferences.additionalArguments)).toMatchObject({ theme: 'blacksphere-plus' })
  // The local speech models' threads need it; only this window gets it, never its webviews.
  expect(window.options.webPreferences.enableBlinkFeatures).toBe('SharedArrayBuffer')
  if (process.platform === 'win32') {
    expect(window.options).toMatchObject({ backgroundMaterial: 'none' })
    expect(window.options.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  }
  expect(window.show).toHaveBeenCalled()
  expect(window.loadFile.mock.calls.length + window.loadURL.mock.calls.length).toBe(1)
  expect(startup.controller.prepareWindow).not.toHaveBeenCalled()
  expect(startup.controller.request).not.toHaveBeenCalled()
  startup.ready({ instanceId: 'ready' })
  await vi.waitFor(() => expect(startup.controller.request).toHaveBeenCalledWith('settings.get'))
  // Compiled WebGL programs (the bot face shader) are kept on disk. Chromium reads the switch only
  // before `ready`, and a feature already on the command line stays.
  expect(startup.featuresWhenReady).toBe('FeatureFromCommandLine,ANGLEPerContextBlobCache')
})

it('a startup retry after the first window fails keeps the one service connection IPC uses', async () => {
  vi.resetModules()
  startup.windows.length = 0
  startup.controllers.length = 0
  startup.ipcDeps = null
  startup.failLoads = 1
  const { app } = await import('electron') as unknown as { app: import('node:events').EventEmitter }
  await import('../src/main/index')
  await vi.waitFor(() => expect(startup.windows).toHaveLength(1))
  await vi.waitFor(() => expect(startup.failLoads).toBe(0))
  expect(startup.controllers).toHaveLength(1)
  // The failed window is closed; activating the app runs startup again.
  startup.windows[0].destroyed = true
  startup.windows.length = 0
  app.emit('activate')
  await vi.waitFor(() => expect(startup.windows).toHaveLength(1))
  await vi.waitFor(() => expect(startup.controllers.filter(c => c.start.mock.calls.length > 0)).toHaveLength(1))
  expect(startup.controllers).toHaveLength(1)
  expect(startup.ipcDeps.guiMms).toBe(startup.controllers[0])
  expect(startup.ipcDeps.guiMms.start).toHaveBeenCalledTimes(1)
})

it("the tray's Quit closes the window, removes the tray and quits, stopping the background service", async () => {
  vi.resetModules()
  startup.windows.length = 0
  startup.controllers.length = 0
  startup.tray.enabled = true
  const quitStops = vi.fn()
  startup.stopServiceForQuit = quitStops
  const { app } = await import('electron') as unknown as { app: { quit: ReturnType<typeof vi.fn> } }
  app.quit.mockClear()
  await import('../src/main/index')
  await vi.waitFor(() => expect(startup.tray.made).toHaveLength(1))
  const window = startup.windows[0]
  const tray = startup.tray.made[0]
  const quit = tray.template.find((item) => item.label === 'Quit Mousse and stop background work')
  quit!.click!()
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalled())
  expect(window.close).toHaveBeenCalled()
  expect(window.isDestroyed()).toBe(true)
  expect(tray.destroyed).toBe(true)
  expect(quitStops).toHaveBeenCalledTimes(1)
})
