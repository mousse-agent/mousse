import { homedir } from 'os'
import { join, resolve } from 'path'
import { parseArgs } from './parseArgs'

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

export function configureElectronContext(
  app: { getPath(name: 'appData' | 'userData'): string; setPath(name: 'userData', value: string): void },
  argv: string[] = []
): void {
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
 * for a daemon on Windows). This runs both inside the main process and turns GPU use off. Call before
 * `app` is ready.
 */
export function configureWindowlessElectron(app: {
  disableHardwareAcceleration(): void
  commandLine: { getSwitchValue(name: string): string; appendSwitch(name: string, value?: string): void }
}): void {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  const features = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean)
  if (!features.includes(NETWORK_SERVICE_IN_PROCESS)) {
    app.commandLine.appendSwitch('enable-features', [...features, NETWORK_SERVICE_IN_PROCESS].join(','))
  }
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
