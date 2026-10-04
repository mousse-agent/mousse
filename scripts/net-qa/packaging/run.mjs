import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPackagedNativeReader } from '../../build-net-native-reader.mjs'
import asar from '@electron/asar'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const mode = process.argv[2] ?? 'node'
if (!['node', 'electron', 'mac-app'].includes(mode) || process.argv.length > 3)
  throw new Error('Usage: node scripts/net-qa/packaging/run.mjs [node|electron|mac-app]')
if (mode === 'mac-app' && process.platform !== 'darwin')
  throw new Error('mac-app requires an actual macOS runner')
const directory = mkdtempSync(join(tmpdir(), 'mousse-packaging-qa-'))
const env = { ...process.env, MOUSSE_PACKAGING_QA_DIRECTORY: directory }
delete env.ELECTRON_RUN_AS_NODE
const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    cwd: project,
    env,
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    ...options
  })
try {
  const manifest = buildPackagedNativeReader()
  if (!manifest.artifactSha256 || manifest.qualified !== false)
    throw new Error('Host reader build must remain unqualified')
  run(process.execPath, ['scripts/build-cli.mjs'])
  const version = run(process.execPath, ['out/cli/index.js', '--version']).trim()
  run(process.execPath, [
    'node_modules/electron-vite/bin/electron-vite.js',
    'build',
    '--config',
    'scripts/net-qa/packaging/electron.config.ts'
  ])
  let executable = process.execPath,
    args = [join(project, '.mousse-dev/net-packaging/main/probe.js')]
  let reader = join(project, 'out/net-native', `${process.platform}-${process.arch}`, 'reader.node')
  if (mode === 'electron')
    executable =
      process.platform === 'darwin'
        ? join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
        : join(project, 'node_modules/electron/dist/electron')
  if (mode === 'mac-app') {
    // Production entry points remain in this build; only this isolated QA app's
    // main metadata selects the probe. It never starts a provider or model call.
    mkdirSync(join(project, 'out/main'), { recursive: true })
    cpSync(join(project, '.mousse-dev/net-packaging/main'), join(project, 'out/main'), {
      recursive: true
    })
    const output = join(directory, 'package')
    run(
      process.execPath,
      [
        'node_modules/electron-builder/cli.js',
        '--mac',
        `--${process.arch}`,
        '--dir',
        '--config',
        'electron-builder.cli.yml',
        '-c.electronDist=node_modules/electron/dist',
        `-c.directories.output=${output}`,
        '-c.mac.identity=null',
        '-c.extraMetadata.main=out/main/probe.js'
      ],
      { timeout: 300000 }
    )
    const resources = join(
      output,
      `mac${process.arch === 'arm64' ? '-arm64' : ''}`,
      'mousse-cli.app/Contents/Resources'
    )
    const archive = join(resources, 'app.asar'),
      entry = `out/net-native/${process.platform}-${process.arch}/reader.node`
    if (
      !asar.statFile(archive, entry).unpacked ||
      JSON.parse(asar.extractFile(archive, 'package.json')).main !== 'out/main/probe.js'
    )
      throw new Error('QA app lacks its unpacked native reader or probe main')
    executable = join(resources, '../MacOS/mousse-cli')
    args = []
    reader = join(resources, 'app.asar.unpacked', entry)
  }
  env.MOUSSE_PACKAGING_QA_READER = reader
  const output = run(executable, args)
  const evidence = output
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((value) => value?.platform)
  if (
    !evidence ||
    typeof evidence.sdkVersion !== 'string' ||
    !evidence.read ||
    !evidence.symlinkDenied ||
    !evidence.deniedRoot ||
    evidence.billingQualified !== false ||
    evidence.productionReaderQualified !== false
  )
    throw new Error('Packaging probe did not verify its bounded reader and SDK checks')
  if (
    mode !== 'node' &&
    (!evidence.electron ||
      evidence.vaultRequired !== true ||
      evidence.vaultAvailable !== true ||
      evidence.vaultRoundtrip !== true)
  )
    throw new Error('Actual Electron vault qualification did not pass')
  // Include public runtime versions and booleans only. No key, codec, credential,
  // encrypted backup, billing configuration, or provider response is printed.
  console.log(JSON.stringify({ mode, cliVersion: version, ...evidence }))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
