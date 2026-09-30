import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import { resolveElectronUserData, finishElectronCli } from '../src/cli/electronContext'

describe('Electron vault context', () => {
  const appData = resolve('fixture/app-data')
  const globalHome = resolve('fixture/global-home')
  const isolatedHome = resolve('fixture/isolated')
  it('retains the installed vault for implicit and explicit global home', () => {
    expect(resolveElectronUserData(appData, {}, [], globalHome)).toBe(join(appData, 'mousse'))
    expect(resolveElectronUserData(appData, { MOUSSE_HOME: globalHome }, [], globalHome)).toBe(join(appData, 'mousse'))
    expect(resolveElectronUserData(appData, {}, ['service', 'run', '--home', globalHome], globalHome)).toBe(join(appData, 'mousse'))
  })
  it('recognizes Windows case variants of the global home', () => {
    if (process.platform !== 'win32') return
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
