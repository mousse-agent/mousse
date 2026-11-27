import { homedir } from 'os'
import { join, resolve } from 'path'
import { parseArgs } from './parseArgs'
import { addToSwitchList, type SwitchCommandLine } from '../shared/chromiumSwitches'
import { MAC_KEYCHAIN_NAME, signedMacApp } from '../mms/providers/secretCodec'

/** Resolve before app.ready: safeStorage and Chromium share this vault context. */
export function resolveElectronUserData(
  appData: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = [],
  defaultHome = join(homedir(), '.mousse')
): string {
  if (env.MOUSSE_ELECTRON_USER_DATA) return resolve(env.MOUSSE_ELECTRON_USER_DATA)
  const home = parseArgs(argv).globals.homeDir || env.MOUSSE_HOME
  // Explicit global home must use the same vault as a normal installed launch.
  const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  if (!home || canonical(home) === canonical(defaultHome)) return join(appData, 'mousse')
  return join(resolve(home), 'electron-user-data')
}

interface NamedApp {
  name: string
  once(event: 'will-finish-launching', listener: () => void): unknown
}

/**
 * A signed macOS build keeps secrets in a keychain item of its own, which it creates itself and so
 * opens without asking. Electron names the item after the app when it starts, and the item named after
 * "mousse" was made by earlier unsigned builds: it trusts only them, so every process of a signed build
 * that opened it asked for the login password. The app runs under `MAC_KEYCHAIN_NAME` until Electron has
 * read the name, then gets its own name back. Data saved through the old item is set aside by each store
 * (`savedElsewhere`). Call before `app` is ready, in every process that uses the keychain.
 */
export function useOwnMacKeychainItem(app: NamedApp, signed: () => boolean = () => process.platform === 'darwin' && signedMacApp()): void {
  if (!signed()) return
  const name = app.name
  app.name = MAC_KEYCHAIN_NAME
  app.once('will-finish-launching', () => {
    app.name = name
  })
}

export function configureElectronContext(
  app: NamedApp & { getPath(name: 'appData' | 'userData'): string; setPath(name: 'userData', value: string): void },
  argv: string[] = []
): void {
  useOwnMacKeychainItem(app)
  const userData = resolveElectronUserData(app.getPath('appData'), process.env, argv)
  app.setPath('userData', userData)
  // GUI bootstrap and service start normalize MOUSSE_HOME later. Preserve the
  // already selected vault when spawning their headless Electron child.
  process.env.MOUSSE_ELECTRON_USER_DATA = userData
}

const NETWORK_SERVICE_IN_PROCESS = 'NetworkServiceInProcess2'

/**
 * The CLI and the daemon run in Electron for safeStorage only: they open no window and make no request
 * through Chromium's network stack. Left to its defaults, Electron still starts a GPU process and a
 * network service process for them (together about 70 MB of private memory and 230 MB of working set
 * for a daemon on Windows). This runs both inside the main process and turns GPU use off. On macOS each
 * would also show a second Mousse icon in the Dock beside the app's, so it hides that. Call before
 * `app` is ready.
 */
export function configureWindowlessElectron(app: {
  disableHardwareAcceleration(): void
  commandLine: SwitchCommandLine
  dock?: { hide(): void }
}): void {
  app.dock?.hide()
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  addToSwitchList(app.commandLine, 'enable-features', NETWORK_SERVICE_IN_PROCESS)
}

/** Graceful success flushes Local State; Electron quit otherwise discards exitCode. */
export function finishElectronCli(
  app: { quit(): void; exit(code: number): void },
  exitCode: string | number | null | undefined = process.exitCode
): void {
  const code = Number(exitCode) || 0
  if (code !== 0) app.exit(code)
  else app.quit()
}
