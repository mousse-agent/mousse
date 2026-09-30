import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { buildCli } from './build-cli.mjs'
import { ensureElectron } from './ensure-electron.mjs'
import { ensureNodePtyHelperExecutable } from './ensure-native-executables.mjs'
import { developmentDaemonInvocation } from './development-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
ensureElectron()
ensureNodePtyHelperExecutable()
await buildCli({ watch: false })
const invocation = developmentDaemonInvocation(root)
const child = spawn(electronPath, [...invocation.argsPrefix, 'service', 'run'], {
  cwd: root, env: invocation.env, stdio: 'inherit', windowsHide: true
})
child.once('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.once('exit', (code) => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
