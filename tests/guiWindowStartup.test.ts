import { expect, it, vi } from 'vitest'
import { readStartupAppearanceArgument } from '../src/shared/startupAppearance'

const startup = vi.hoisted(() => {
  let ready!: (value: unknown) => void
  const pending = new Promise(done => { ready = done })
  return { pending, ready, ipc: false, chrome: false, windows: [] as Array<any>, controller: null as any }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
    quit: vi.fn(), isPackaged: false, name: 'Mousse', getVersion: () => 'test'
  })
  class BrowserWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 123, setWindowOpenHandler: vi.fn(), isDestroyed: () => false
    })
    readonly loadURL = vi.fn(async (url: string) => {
      expect(startup.ipc).toBe(true)
      expect(startup.chrome).toBe(true)
      expect(url).not.toMatch(/^data:/)
      this.emit('ready-to-show')
    })
    readonly loadFile = vi.fn(async () => {
      expect(startup.ipc).toBe(true)
      expect(startup.chrome).toBe(true)
      this.emit('ready-to-show')
    })
    readonly show = vi.fn()
    constructor(readonly options: unknown) { super(); startup.windows.push(this) }
    isDestroyed() { return false }
    static getAllWindows() { return startup.windows }
  }
  return {
    app, BrowserWindow,
    nativeTheme: { shouldUseDarkColors: true },
    dialog: { showErrorBox: vi.fn() }, shell: { openExternal: vi.fn() },
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
  getWindowBindingForSender = vi.fn(() => null)
  constructor() { startup.controller = this }
} }))
vi.mock('../src/main/ipc/registerGuiIpc', () => ({
  registerGuiIpc: () => { startup.ipc = true },
  attachWindowListeners: () => { startup.chrome = true }
}))
vi.mock('../src/main/browser/BrowserViewManager', () => ({ BrowserViewManager: class {} }))
vi.mock('../src/main/browser/AttachedBrowserHost', () => ({ AttachedBrowserHost: class {} }))
vi.mock('../src/main/appIcon', () => ({ applyAppIcon: vi.fn(), getAppIconPath: () => undefined }))
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
vi.mock('../src/main/linuxRendering', () => ({ configureLinuxWindowing: () => false, linuxTransparencyOptions: () => ({}) }))

it('loads and shows only the real main window while MMS readiness remains withheld', async () => {
  await import('../src/main/index')
  await vi.waitFor(() => expect(startup.windows).toHaveLength(1))
  const window = startup.windows[0]
  await vi.waitFor(() => expect(startup.controller.start).toHaveBeenCalledTimes(1))
  expect(window.options).toMatchObject({ width: 1400, height: 900, title: 'Mousse', show: false })
  expect(readStartupAppearanceArgument(window.options.webPreferences.additionalArguments)).toMatchObject({ theme: 'blacksphere-plus' })
  if (process.platform === 'win32') {
    expect(window.options).toMatchObject({ backgroundMaterial: 'acrylic' })
    expect(window.options.backgroundColor).toMatch(/^#00[0-9a-f]{6}$/)
  }
  expect(window.show).toHaveBeenCalled()
  expect(window.loadFile.mock.calls.length + window.loadURL.mock.calls.length).toBe(1)
  expect(startup.controller.prepareWindow).not.toHaveBeenCalled()
  expect(startup.controller.request).not.toHaveBeenCalled()
  startup.ready({ instanceId: 'ready' })
  await vi.waitFor(() => expect(startup.controller.request).toHaveBeenCalledWith('settings.get'))
})
