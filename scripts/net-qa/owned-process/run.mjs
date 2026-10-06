import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import asar from '@electron/asar'
import { buildOwnedProcess } from '../../build-owned-process.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), mode = process.argv[2] ?? 'node'
if (!['node', 'electron', 'mac-app'].includes(mode) || process.platform !== 'darwin') throw new Error('Usage on Darwin: node scripts/net-qa/owned-process/run.mjs [node|electron|mac-app]')
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-owned-process-qa-'))
const env = { ...process.env, MOUSSE_OWNED_PROCESS_QA_DIRECTORY: directory, MOUSSE_OWNED_PROCESS_QA_HEARTBEAT: join(project, 'tests/fixtures/agent-platform/process-lifecycle/heartbeat-child.mjs') }; delete env.ELECTRON_RUN_AS_NODE
const run = (executable, args, options = {}) => execFileSync(executable, args, { cwd: project, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...options })
buildOwnedProcess()
let executable = process.execPath, args = [join(project, '.mousse-dev/owned-process-qa/probe.mjs')]
await build({ entryPoints: [join(project, 'scripts/net-qa/owned-process/probe.ts')], outfile: args[0], platform: 'node', format: 'esm', bundle: true, packages: 'external' })
if (mode === 'electron') executable = join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
if (mode === 'mac-app') {
  run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build', '--config', 'scripts/net-qa/owned-process/electron.config.ts'])
  mkdirSync(join(project, 'out/main'), { recursive: true }); cpSync(join(project, '.mousse-dev/owned-process-qa/main'), join(project, 'out/main'), { recursive: true })
  const output = join(directory, 'package')
  run(process.execPath, ['node_modules/electron-builder/cli.js', '--mac', `--${process.arch}`, '--dir', '--config', 'electron-builder.cli.yml', '-c.electronDist=node_modules/electron/dist', `-c.directories.output=${output}`, '-c.mac.identity=null', '-c.extraMetadata.main=out/main/owned-process-probe.js'], { timeout: 300000 })
  const resources = join(output, `mac${process.arch === 'arm64' ? '-arm64' : ''}`, 'mousse-cli.app/Contents/Resources'), archive = join(resources, 'app.asar')
  if (!asar.statFile(archive, `out/net-native/darwin-${process.arch}/owned-process.node`).unpacked) throw new Error('Owned-process native addon was not unpacked')
  executable = join(resources, '../MacOS/mousse-cli'); args = []
}
const stdout = run(executable, args), evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'))
if (!evidence.allPidsGone || evidence.ownedCount !== 0 || !evidence.capturedOrphan || !evidence.birthMismatchDenied || !evidence.unrelatedAlive || (mode !== 'node' && evidence.electron !== '43.2.0')) throw new Error('Actual owned-process QA failed')
console.log(stdout.trim()); console.log(JSON.stringify({ mode, directory, executable }))
