import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import { resolveElectronUserData, finishElectronCli, configureWindowlessElectron, useOwnMacKeychainItem } from '../src/cli/electronContext'

describe('Electron vault context', () => {
  const appData = resolve('fixture/app-data')
  const globalHome = resolve('fixture/global-home')
  const isolatedHome = resolve('fixture/isolated')
  it('retains the installed vault for implicit and explicit global home', () => {
    expect(resolveElectronUserData(appData, {}, [], globalHome)).toBe(join(appData, 'mousse'))
    expect(resolveElectronUserData(appData, { MOUSSE_HOME: globalHome }, [], globalHome)).toBe(join(appData, 'mousse'))
    expect(resolveElectronUserData(appData, {}, ['service', 'run', '--home', globalHome], globalHome)).toBe(join(appData, 'mousse'))
  })
  it.runIf(process.platform === 'win32')('recognizes Windows case variants of the global home', () => {
    expect(resolveElectronUserData(appData, { MOUSSE_HOME: globalHome.toUpperCase() }, [], globalHome)).toBe(join(appData, 'mousse'))
  })
  it('uses the same custom-home context for GUI and dual-mode service commands', () => {
    const expected = join(isolatedHome, 'electron-user-data')
    expect(resolveElectronUserData(appData, { MOUSSE_HOME: isolatedHome }, [], globalHome)).toBe(expected)
    for (const command of ['run', 'start']) {
      expect(resolveElectronUserData(appData, {}, ['service', command, `--home=${isolatedHome}`], globalHome)).toBe(expected)
    }
  })
  it('honors an explicit vault override in both modes', () => {
    const env = { MOUSSE_HOME: isolatedHome, MOUSSE_ELECTRON_USER_DATA: resolve('fixture/vault') }
    expect(resolveElectronUserData(appData, env, [], globalHome)).toBe(env.MOUSSE_ELECTRON_USER_DATA)
    expect(resolveElectronUserData(appData, env, ['service', 'run', '--home', isolatedHome], globalHome)).toBe(env.MOUSSE_ELECTRON_USER_DATA)
  })
  it('lets CLI home override the environment before selecting its vault', () => {
    expect(resolveElectronUserData(appData, { MOUSSE_HOME: globalHome }, ['--home', isolatedHome], globalHome)).toBe(join(isolatedHome, 'electron-user-data'))
  })
})

describe('Electron CLI completion', () => {
  it('quits gracefully after success so Chromium can flush its vault key', () => {
    const app = { quit: vi.fn(), exit: vi.fn() }
    finishElectronCli(app, 0)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
  })
  it('preserves a service failure code when the command resolves without throwing', () => {
    const app = { quit: vi.fn(), exit: vi.fn() }
    finishElectronCli(app, 1)
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(app.quit).not.toHaveBeenCalled()
  })
})

describe('a windowless Electron run (the CLI and the daemon)', () => {
  function fakeApp(enableFeatures = '') {
    const switches = new Map<string, string>(enableFeatures ? [['enable-features', enableFeatures]] : [])
    return {
      switches,
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        getSwitchValue: (name: string) => switches.get(name) ?? '',
        appendSwitch: (name: string, value = '') => { switches.set(name, value) }
      }
    }
  }

  it('starts no GPU process and keeps the network service in the main process', () => {
    const app = fakeApp()
    configureWindowlessElectron(app)
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(app.switches.has('in-process-gpu')).toBe(true)
    expect(app.switches.get('enable-features')).toBe('NetworkServiceInProcess2')
  })

  it('hides the Dock icon, so the daemon is not a second Mousse in the Dock', () => {
    const hide = vi.fn()
    configureWindowlessElectron({ ...fakeApp(), dock: { hide } })
    expect(hide).toHaveBeenCalledOnce()
  })

  it('keeps features already enabled on the command line', () => {
    const app = fakeApp('SomeFeature')
    configureWindowlessElectron(app)
    configureWindowlessElectron(app)
    expect(app.switches.get('enable-features')).toBe('SomeFeature,NetworkServiceInProcess2')
  })
})

describe('the keychain item of a signed macOS build', () => {
  function fakeApp() {
    const listeners = new Map<string, () => void>()
    return {
      name: 'mousse',
      once: (event: string, listener: () => void) => listeners.set(event, listener),
      launch: () => listeners.get('will-finish-launching')?.()
    }
  }

  it('starts under a name of its own, which Electron gives its keychain item, then gets its name back', () => {
    const app = fakeApp()
    useOwnMacKeychainItem(app, () => true)
    expect(app.name).toBe('Mousse')
    app.launch()
    expect(app.name).toBe('mousse')
  })

  it('leaves unsigned builds and other systems under their name', () => {
    const app = fakeApp()
    useOwnMacKeychainItem(app, () => false)
    expect(app.name).toBe('mousse')
  })
})
