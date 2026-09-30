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

/** Graceful success flushes Local State; Electron quit otherwise discards exitCode. */
export function finishElectronCli(
  app: { quit(): void; exit(code: number): void },
  exitCode: string | number | null | undefined = process.exitCode
): void {
  const code = Number(exitCode) || 0
  if (code !== 0) app.exit(code)
  else app.quit()
}
