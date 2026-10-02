/**
 * Open the Electron app against the user's shared Mousse installation.
 *
 * Unlike `npm run dev`, this launcher never uses the repository-local
 * `.mousse-dev` runtime. The GUI starts or connects to the MMS daemon itself.
 */

import { spawn } from 'node:child_process'
import { linuxGuiLaunchArgs } from './linux-gui-launch.mjs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCli } from './build-cli.mjs'
import { ensureElectron } from './ensure-electron.mjs'
import { ensureNodePtyHelperExecutable } from './ensure-native-executables.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronViteEntry = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')
const homeDir = join(homedir(), '.mousse')

ensureElectron()
ensureNodePtyHelperExecutable()
await buildCli({ watch: false, log: false })

const env = { ...process.env }

// An unset MOUSSE_HOME means the normal global ~/.mousse home. It also lets
// Electron keep its standard userData directory, which safeStorage-backed
// credentials depend on. Clear development overrides inherited from a shell.
delete env.ELECTRON_RUN_AS_NODE
delete env.MOUSSE_CLI
delete env.MOUSSE_HOME
delete env.MOUSSE_ELECTRON_USER_DATA
delete env.MOUSSE_BROWSER_ROOT
delete env.MOUSSE_ARTIFACT_ROOT
delete env.MOUSSE_DEV_MANAGED_DAEMON

console.log(`[start] Opening Mousse (home=${homeDir})`)

const electron = spawn(process.execPath, [electronViteEntry, ...linuxGuiLaunchArgs(['dev'])], {
  cwd: root,
  env,
  stdio: 'inherit'
})

electron.once('error', (error) => {
  console.error(`[start] Failed to open Mousse: ${error.message}`)
  process.exitCode = 1
})

electron.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
