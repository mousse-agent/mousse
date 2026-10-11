import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function nativeProbe() {
  return spawnSync(process.execPath, ['-e', "require('node-pty')"], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
}

/** Restore node-pty's native binding when npm skipped its install script. */
export function ensureNodePty() {
  if (nativeProbe().status === 0) return
  console.log('[dev] node-pty native binding is missing; rebuilding for the current Node.js…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const rebuilt = spawnSync(npm, ['rebuild', 'node-pty', '--foreground-scripts'], {
    cwd: root,
    stdio: 'inherit',
    // Windows cannot launch a .cmd file directly through CreateProcess.
    // The command and arguments are fixed here; no user input enters the shell.
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'false' }
  })
  if (rebuilt.error || rebuilt.status !== 0 || nativeProbe().status !== 0) {
    throw new Error(`node-pty could not be rebuilt for Node.js ${process.version}. Run npm rebuild node-pty --foreground-scripts and retry.`)
  }
}
