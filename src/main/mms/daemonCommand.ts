import { basename } from 'path'
import { dropForeignAppImageMounts } from '../../cli/appImageMounts'

/** How the GUI starts the background service: the program, the arguments before `service run`, and its environment. */
export interface DaemonCommand {
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
}

/**
 * The service outlives the window, so it must not run from files that go away with the window.
 * A packaged GUI re-enters its own dual-mode executable with `--cli`. On Linux that executable sits
 * in the AppImage's private mount, which the AppImage runtime removes when the window quits: the
 * service then keeps running but cannot start programs (`spawn ENOTCONN`) and soon fails. There the
 * service is started from the AppImage file itself, which mounts its own copy for as long as it runs.
 * The window's environment still names its mount first in PATH and other search paths, so those entries are left out:
 * nothing the service or its starter runs should look there once the window quits.
 * Unpackaged runs use the CLI host (`host`).
 */
export function daemonCommand(input: {
  execPath: string
  platform: NodeJS.Platform
  electron: boolean
  env: NodeJS.ProcessEnv
  host: DaemonCommand
}): DaemonCommand {
  // PATH launchers and the copied console host are intended for user shells; resolving either here
  // can delay or prevent the daemon and leave a Start Menu launch headless.
  const packaged = input.electron && /^mousse(?:\.exe)?$/i.test(basename(input.execPath))
  if (!packaged) return input.host
  const appImage = input.platform === 'linux' ? input.env.APPIMAGE : undefined
  if (appImage) {
    // The AppImage runtime sets these for the copy it starts.
    const { APPIMAGE: _appImage, APPDIR: _appDir, ARGV0: _argv0, OWD: _owd, ...rest } = input.env
    // Without APPDIR, every mount is foreign, the window's own included.
    dropForeignAppImageMounts(rest, input.platform)
    return { command: appImage, argsPrefix: ['--cli'], env: { ...rest, MOUSSE_CLI: '1' } }
  }
  return { command: input.execPath, argsPrefix: ['--cli'], env: { ...input.env, MOUSSE_CLI: '1' } }
}
