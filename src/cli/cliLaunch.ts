import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'

/** True when this process should run headless mousse-cli (not the GUI). */
export function detectCliMode(argv: string[] = process.argv): boolean {
  if (process.env.MOUSSE_CLI === '1' || process.env.MOUSSE_CLI === 'true') {
    return true
  }
  if (argv.includes('--cli')) {
    return true
  }
  const base = basename(process.execPath).toLowerCase()
  return base === 'mousse-cli' || base === 'mousse-cli.exe'
}

/** Strip the dual-mode flag so parseArgs only sees CLI arguments. */
export function stripCliModeArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== '--cli')
}

/**
 * Whether we are running inside Electron's main process (not ELECTRON_RUN_AS_NODE).
 * Packaged desktop CLI uses dual-mode: Mousse.exe --cli …
 */
export function isElectronMainProcess(): boolean {
  return Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE !== '1'
}

/**
 * Packaged launcher next to the app binary (mousse-cli.cmd / mousse-cli).
 * Preferred for PATH, Task Scheduler, and service install.
 */
export function resolvePackagedCliLauncher(): string | null {
  const dir = dirname(process.execPath)
  const name = process.platform === 'win32' ? 'mousse-cli.cmd' : 'mousse-cli'
  const candidate = join(dir, name)
  return existsSync(candidate) ? candidate : null
}

/**
 * Path suitable for startup install / documentation (single executable path).
 * Prefer the packaged launcher; fall back to the current script or execPath.
 */
export function resolveCliPathForInstall(scriptPath?: string): string {
  const launcher = resolvePackagedCliLauncher()
  if (launcher) return launcher

  if (scriptPath && existsSync(scriptPath) && !isElectronMainProcess()) {
    return scriptPath
  }

  return process.execPath
}

/**
 * How to re-invoke mousse-cli as a child process (service start, etc.).
 */
export function resolveCliInvocation(scriptPath?: string): {
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
} {
  const launcher = resolvePackagedCliLauncher()
  if (launcher) {
    // .cmd needs shell on Windows when not using cmd.exe explicitly
    if (process.platform === 'win32' && launcher.toLowerCase().endsWith('.cmd')) {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c', launcher],
        env: { ...process.env, MOUSSE_CLI: '1' }
      }
    }
    return {
      command: launcher,
      argsPrefix: [],
      env: { ...process.env, MOUSSE_CLI: '1' }
    }
  }

  if (isElectronMainProcess()) {
    // In development `electron .` needs the app entry before our dual-mode flag.
    // A packaged Mousse executable already is the app and accepts `--cli` directly.
    const defaultApp = Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
    const appEntry = defaultApp ? process.argv[1] : undefined
    return {
      command: process.execPath,
      argsPrefix: appEntry ? [appEntry, '--cli'] : ['--cli'],
      env: { ...process.env, MOUSSE_CLI: '1' }
    }
  }

  const script = scriptPath ?? process.argv[1]
  return {
    command: process.execPath,
    argsPrefix: script ? [script] : [],
    env: { ...process.env }
  }
}
