import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run from an owned Git worktree with separately cloned Linux dependencies.
// No dependency installation, network access, or production qualification flags.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const image = 'node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2'
const tests = [
  'bot-receipts',
  'multi-epoch',
  'private-rotation',
  'private-activation',
  'daemon'
].map((name) => `tests/net/spaces/archive/${name}.test.ts`)
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024
  })
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error ?? result.stderr}`)
  return result.stdout.trim()
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
run('git', [
  'diff',
  '--exit-code',
  'HEAD',
  '--',
  'src',
  'tests',
  'scripts/build-cli.mjs',
  'package.json',
  'package-lock.json'
])
const sha = run('git', ['rev-parse', 'HEAD']),
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  directory = join(root, '.mousse-dev', 'net-qa', 'linux-archive-receipts', stamp),
  log = join(directory, 'selected-tests.log')
mkdirSync(directory, { recursive: true })
writeFileSync(log, '', { flag: 'wx' })
const names = {
  probe: `mousse-net-linux-archive-probe-${process.pid}`,
  test: `mousse-net-linux-archive-check-${process.pid}`
}
const common = (name) => [
  'run',
  '--rm',
  '--name',
  name,
  '--platform',
  'linux/arm64',
  '--network',
  'none',
  '--mount',
  `type=bind,source=${root.replace(/\/$/, '')},target=/work`,
  '--workdir',
  '/work',
  image
]
const probe = `import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';const require=createRequire(import.meta.url),db=new DatabaseSync(':memory:'),sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules,sqlite:db.prepare('select sqlite_version() as version').get().version,sdkVersion:JSON.parse(readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json')).version,sdkResolved:import.meta.resolve('@earendil-works/pi-coding-agent'),esbuild:require('esbuild').version,ptyLoad:typeof require('node-pty').spawn==='function',packageLockSha256:sha('package-lock.json'),sdkManifestSha256:sha('node_modules/@earendil-works/pi-coding-agent/package.json')}));db.close()`
const runtime = JSON.parse(
  run('docker', [...common(names.probe), 'node', '--input-type=module', '-e', probe])
)
if (
  runtime.node !== 'v24.20.0' ||
  runtime.platform !== 'linux' ||
  runtime.arch !== 'arm64' ||
  runtime.sdkVersion !== '0.85.1' ||
  !runtime.ptyLoad ||
  runtime.packageLockSha256 !== hash(readFileSync(join(root, 'package-lock.json')))
)
  throw new Error('Pinned Linux dependency/runtime evidence mismatch')
const evidence = {
  sourceSha: sha,
  sourceTree: run('git', ['rev-parse', 'HEAD^{tree}']),
  image,
  network: 'none',
  runtime,
  tests,
  inputs: Object.fromEntries(tests.map((path) => [path, hash(readFileSync(join(root, path)))])),
  startedAt: new Date().toISOString(),
  log,
  status: 'running',
  exitCode: null,
  cleanup: null
}
writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
process.stdout.write(`Linux archive selected-check evidence: ${directory}\n`)
let timedOut = false
try {
  evidence.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        ...common(names.test),
        'node',
        'node_modules/vitest/vitest.mjs',
        'run',
        ...tests,
        '--maxWorkers=1'
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 240000)
    child.stdout.on('data', (bytes) => {
      appendFileSync(log, bytes)
      process.stdout.write(bytes)
    })
    child.stderr.on('data', (bytes) => {
      appendFileSync(log, bytes)
      process.stderr.write(bytes)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  evidence.status = evidence.exitCode === 0 && !timedOut ? 'passed' : 'failed'
} finally {
  // Container identity is an exact owned name. Never enumerate/stop neighbours.
  const listed = run('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n')
  const remaining = Object.values(names).filter((name) => listed.includes(name))
  for (const name of remaining) run('docker', ['rm', '--force', name])
  const after = run('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n')
  evidence.cleanup = {
    forced: remaining,
    residual: Object.values(names).filter((name) => after.includes(name))
  }
  evidence.finishedAt = new Date().toISOString()
  evidence.timedOut = timedOut
  evidence.logSha256 = hash(readFileSync(log))
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600
  })
}
if (evidence.status !== 'passed' || evidence.cleanup.residual.length) process.exitCode = 1
