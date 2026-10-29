import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

// Waits up to 60 s for the old Mousse to exit, then starts the new AppImage with the same arguments.
const RESTART_SCRIPT = 'pid=$1; shift; i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; exec "$@"'

export interface AppImageInstallOptions {
  /** The running AppImage (`$APPIMAGE`). */
  current: string
  /** The downloaded release, named as published. */
  downloaded: string
  /** Called once the new file is in place, before the old one is removed. */
  onReplaced?: (destination: string, previous: string) => void
}

/**
 * Where the new release goes: over the running file when its name carries no version (the user
 * chose that name), otherwise beside it under the release's own versioned name.
 */
export function appImageDestination(current: string, downloaded: string): string {
  const name = basename(current)
  return basename(downloaded) === name || !/\d+\.\d+\.\d+/.test(name) ? current : join(dirname(current), basename(downloaded))
}

function moveInto(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // The download cache is on another file system.
    const part = `${destination}.part`
    copyFileSync(source, part)
    renameSync(part, destination)
    unlinkSync(source)
  }
}

/**
 * Puts a downloaded AppImage in place of the running one. Unlike electron-updater, the old file is
 * removed only after the new one is in place, so a failed move leaves Mousse installed.
 */
export function installAppImage(options: AppImageInstallOptions): string {
  const { current, downloaded } = options
  if (!isAbsolute(current) || current.includes('\0')) throw new Error(`The running AppImage path is not usable: ${current}`)
  const destination = appImageDestination(current, downloaded)
  moveInto(downloaded, destination)
  chmodSync(destination, 0o755)
  options.onReplaced?.(destination, current)
  if (destination !== current) {
    try {
      unlinkSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`The previous AppImage was not removed: ${(error as Error).message}`)
    }
  }
  return destination
}

/**
 * Starts `appImage` once process `pid` has exited. Starting it earlier loses to the old process's
 * single-instance lock, and the new copy quits at once.
 */
export function startAfterExit(pid: number, appImage: string, args: string[], env: NodeJS.ProcessEnv): void {
  // The AppImage runtime sets these for the copy it starts.
  const { APPIMAGE: _appImage, APPDIR: _appDir, ARGV0: _argv0, OWD: _owd, ...rest } = env
  const child = spawn('/bin/sh', ['-c', RESTART_SCRIPT, 'mousse-restart', String(pid), appImage, ...args], {
    detached: true,
    stdio: 'ignore',
    env: rest
  })
  child.unref()
}
