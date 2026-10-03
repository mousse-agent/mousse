import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import asar from '@electron/asar'
import { buildPackagedNativeReader } from '../../build-net-native-reader.mjs'

// Actual production main, ASAR and protected service-run processes. The driver
// remains Node 24.20+; Electron's embedded runtime is reported separately.
if (process.platform !== 'darwin')
  throw new Error('This production CLI package gate requires an actual macOS runner')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const directory = mkdtempSync(join(tmpdir(), 'mousse-production-cli-'))
// macOS's per-user tmpdir is too long for these guarded Unix socket paths.
const runDir = join('/tmp', `mnqa-asar-${randomBytes(6).toString('hex')}`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const run = (args, timeout = 60000) =>
  execFileSync(process.execPath, args, {
    cwd: project,
    env,
    timeout,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
try {
  const reader = buildPackagedNativeReader()
  run([
    'node_modules/electron-vite/bin/electron-vite.js',
    'build',
    '--config',
    'scripts/net-qa/packaging/electron.config.ts'
  ])
  mkdirSync(join(project, 'out/main'), { recursive: true })
  cpSync(join(project, '.mousse-dev/net-packaging/main'), join(project, 'out/main'), {
    recursive: true
  })
  rmSync(join(project, 'out/main/probe.js'), { force: true })
  const output = join(directory, 'package')
  run(
    [
      'node_modules/electron-builder/cli.js',
      '--mac',
      `--${process.arch}`,
      '--dir',
      '--config',
      'electron-builder.cli.yml',
      '-c.electronDist=node_modules/electron/dist',
      `-c.directories.output=${output}`,
      '-c.mac.identity=null'
    ],
    300000
  )
  const app = join(
    output,
    `mac${process.arch === 'arm64' ? '-arm64' : ''}`,
    'mousse-cli.app/Contents'
  )
  const archive = join(app, 'Resources/app.asar'),
    executable = join(app, 'MacOS/mousse-cli')
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'))
  const readerEntry = `out/net-native/${process.platform}-${process.arch}/reader.node`
  if (
    metadata.main !== 'out/main/cli.js' ||
    !asar.statFile(archive, readerEntry).unpacked ||
    sha(join(app, 'Resources/app.asar.unpacked', readerEntry)) !== reader.artifactSha256
  )
    throw new Error('Production CLI main or unpacked reader binding changed')
  const source = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: project,
    encoding: 'utf8'
  }).trim()
  run(
    [
      'scripts/net/qa/public-daemon-soak.mjs',
      '--entry',
      archive,
      '--executable',
      executable,
      '--run-dir',
      runDir,
      '--duration-ms',
      '90000',
      '--interval-ms',
      '1000',
      '--fault-every-ms',
      '5000',
      '--source-sha',
      source
    ],
    240000
  )
  const reportPath = join(runDir, 'report.json'),
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (
    report.status !== 'completed' ||
    report.qualified !== false ||
    !report.cleanedOwnedProcesses ||
    report.pending ||
    report.failed ||
    report.sent !== report.messages ||
    report.faultCounts.some((n) => n < 1) ||
    report.cursors.some((n) => n !== report.messages)
  )
    throw new Error('Actual production CLI daemon gate did not complete')
  const electron = JSON.parse(
    readFileSync(join(project, 'node_modules/electron/package.json'), 'utf8')
  ).version
  const result = {
    v: 1,
    gate: 'production-cli-asar-public-conversation',
    source,
    driverNode: process.version,
    electron,
    main: metadata.main,
    cliVersion: metadata.version,
    asarSha256: sha(archive),
    executableSha256: sha(executable),
    readerSha256: reader.artifactSha256,
    reportPath,
    messages: report.messages,
    faultCounts: report.faultCounts,
    durationMs: report.conversationElapsedMs,
    ownedProcessesStopped: true,
    paidProviderQualified: false,
    fullPlatformQualified: false,
    soakQualified: false
  }
  writeFileSync(join(runDir, 'package-evidence.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600
  })
  console.log(JSON.stringify(result))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
