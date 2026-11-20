#!/usr/bin/env node
// The packaged app's part of `phase1b.desktop-builds` (Phase 1b §14, §15, M14): the engine kit's
// `tools/build-smoke.mjs` runs it in this checkout with the release helper it built and checked.
//
//   node scripts/net-engine-package-smoke.mjs --helper <mousse-helper> --target <target> --out <dir> [--no-build]
//
// 1. Builds the app (`npm run build`; `--no-build` keeps the `out/` there is).
// 2. Packages it unpacked (`electron-builder --dir`) for <target> into <dir>/release, with <helper> as its
//    `resources/net-helper` and nothing else changed in this checkout. Resources this computer has not built (the
//    voice engine, Windows' editor sshd) are left out: the smoke is about the helper and the start.
// 3. The packaged helper's `--version` must be <helper>'s own build, with no must-fail control.
// 4. Starts the packaged app as the startup entry does (`--cli service run`, headless, a new MOUSSE_HOME), waits
//    until its daemon is ready, and asks it `net-engine status`: the app must find its packaged helper (not
//    "Not in this build"). Then stops it.
//
// Prints `app_build=<commit>[-dirty]`, `packaged_helper=<path>`, then `PASS package-smoke`, or
// `FAIL package-smoke reason=<word>`: `bad_arguments`, `wrong_host` (a target this computer cannot package and
// run), `stale_helper`, `build_failed`, `package_failed`, `missing_helper`, `helper_does_not_run`,
// `app_not_started`, `helper_not_found`. Exit 0 only on PASS.
//
// Waits: MOUSSE_CHECK_PACKAGE_START_MS (180000) for the packaged app to be ready.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CheckFailed } from './check-packaged-net-helper.mjs'
import { findUnpackedApp, helperFileName, HELPER_TARGETS, packagedLayout, parseHelperVersion } from './net-helper-build.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BUILDER_OS = { windows: '--win', macos: '--mac', linux: '--linux' }
const NODE_OS = { windows: 'win32', macos: 'darwin', linux: 'linux' }

/** Whether this computer packages and runs `target`: its own OS, its own architecture, or x64 on an Apple silicon Mac (Rosetta). */
export function runsHere(target, platform = process.platform, arch = process.arch) {
  const [os, targetArch] = target.split('-')
  if (NODE_OS[os] !== platform) return false
  return targetArch === arch || (platform === 'darwin' && arch === 'arm64' && targetArch === 'x64')
}

/**
 * electron-builder's config for the smoke: this checkout's `build` from package.json, output in `<out>/release`, the
 * helper from `helperDir`, and only the extra resources that exist here (`exists`). Electron comes from
 * node_modules only when it is this computer's architecture.
 */
export function smokeConfig(build, { out, helperDir, sameArch, root = project, exists = existsSync }) {
  const resources = (list) =>
    (list ?? [])
      .map((entry) => (entry.to === 'net-helper' ? { ...entry, from: helperDir } : entry))
      .filter((entry) => entry.to === 'net-helper' || exists(resolve(root, entry.from)))
  const config = {
    ...build,
    directories: { ...build.directories, output: join(out, 'release') },
    extraResources: resources(build.extraResources),
    publish: null
  }
  if (build.afterPack) config.afterPack = resolve(root, build.afterPack)
  for (const os of ['win', 'mac', 'linux'])
    if (build[os]) config[os] = { ...build[os], extraResources: resources(build[os].extraResources), extraFiles: resources(build[os].extraFiles) }
  if (!sameArch) delete config.electronDist
  return config
}

/** `<commit>[-dirty]` of this checkout. */
function appBuild() {
  const git = (...args) => spawnSync('git', args, { cwd: project, encoding: 'utf8' })
  const commit = git('rev-parse', 'HEAD').stdout?.trim() || 'unknown'
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout?.trim()
  return `${commit}${dirty ? '-dirty' : ''}`
}

function parse(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-build') flags.noBuild = true
    else if (['--helper', '--target', '--out'].includes(arg) && argv[i + 1] !== undefined) flags[arg.slice(2)] = argv[++i]
    else throw new CheckFailed('bad_arguments', `unknown or incomplete argument ${arg}`)
  }
  if (!flags.helper || !flags.target || !flags.out)
    throw new CheckFailed('bad_arguments', 'usage: --helper <file> --target <target> --out <dir> [--no-build]')
  if (!HELPER_TARGETS[flags.target]) throw new CheckFailed('bad_arguments', `--target is one of ${Object.keys(HELPER_TARGETS).join(', ')}`)
  return flags
}

function step(command, args, reason) {
  console.log(`> ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, { cwd: project, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' })
  if (result.status !== 0) throw new CheckFailed(reason, `${command} ${args.join(' ')} exited ${result.status ?? result.error?.message}`)
}

/** Starts the packaged app headless in a new MOUSSE_HOME, reads `net-engine status` from it, and stops it. */
async function startAndAsk(app, home, waitMs) {
  const { executable } = packagedLayout(app)
  if (!existsSync(executable)) throw new CheckFailed('app_not_started', `${app} has no ${executable}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, MOUSSE_HOME: home, MOUSSE_CLI: '1' }
  // The packaged app finds its own helper; a helper named for the dev app would hide a missing one.
  delete env.MOUSSE_NET_HELPER
  const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  if (process.platform === 'linux') env.ELECTRON_DISABLE_SANDBOX = '1'
  const cli = (...args) =>
    spawnSync(executable, ['--cli', ...switches, ...args], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  const started = Date.now()
  const child = spawn(executable, ['--cli', ...switches, 'service', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let said = ''
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new CheckFailed('app_not_started', `the packaged app was not ready within ${waitMs} ms:\n${said}`)),
        waitMs
      )
      child.on('exit', (code) => {
        clearTimeout(timer)
        fail(new CheckFailed('app_not_started', `the packaged app exited (${code}) before it was ready:\n${said}`))
      })
      const listen = (chunk) => {
        said = (said + chunk).slice(-16_384)
        if (!/Mousse MMS running \(headless\)/.test(said)) return
        clearTimeout(timer)
        done()
      }
      child.stdout.on('data', listen)
      child.stderr.on('data', listen)
    })
    console.log(`app_started=${Date.now() - started}`)
    const asked = cli('--json', 'net-engine', 'status')
    const text = asked.stdout ?? ''
    let status
    try {
      status = JSON.parse(text.slice(text.indexOf('{')))
    } catch {
      throw new CheckFailed('helper_not_found', `net-engine status said: ${text.trim() || asked.stderr?.trim() || `exit ${asked.status}`}`)
    }
    console.log(`app_helper_state=${status.helper?.state}`)
    if (!status.helper?.state || status.helper.state === 'not_in_build')
      throw new CheckFailed('helper_not_found', 'the packaged app does not find its helper (Not in this build)')
  } finally {
    child.removeAllListeners('exit')
    const stopped = cli('service', 'stop')
    if (stopped.status !== 0 && child.exitCode === null) child.kill()
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

async function main(argv) {
  try {
    const flags = parse(argv)
    const out = resolve(flags.out)
    const helper = resolve(flags.helper)
    const triple = HELPER_TARGETS[flags.target]
    console.log(`app_build=${appBuild()}`)
    if (!runsHere(flags.target))
      throw new CheckFailed('wrong_host', `${flags.target} is not packaged and run on ${process.platform} ${process.arch}`)

    // The helper under test, as the package will carry it.
    const version = spawnSync(helper, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    const said = parseHelperVersion(version.stdout)
    if (!said) throw new CheckFailed('stale_helper', `${helper} --version says "${(version.stdout ?? '').trim()}"`)
    if (said.control !== 'none') throw new CheckFailed('stale_helper', `${helper} carries the must-fail control ${said.control}`)
    const helperDir = join(out, 'helper-package')
    rmSync(helperDir, { recursive: true, force: true })
    mkdirSync(helperDir, { recursive: true })
    const staged = join(helperDir, helperFileName(triple))
    copyFileSync(helper, staged)
    chmodSync(staged, 0o755)
    writeFileSync(join(helperDir, 'TARGET'), `${triple}\n`)

    if (!flags.noBuild) step('npm', ['run', 'build'], 'build_failed')

    const [os, arch] = flags.target.split('-')
    const build = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).build
    const config = smokeConfig(build, { out, helperDir, sameArch: arch === process.arch })
    const configFile = join(out, 'electron-builder.json')
    rmSync(join(out, 'release'), { recursive: true, force: true })
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
    step(
      process.execPath,
      [join(project, 'node_modules', 'electron-builder', 'cli.js'), '--dir', BUILDER_OS[os], `--${arch}`, '--config', configFile, '--publish', 'never'],
      'package_failed'
    )

    const app = findUnpackedApp(join(out, 'release'))
    if (!app) throw new CheckFailed('package_failed', `electron-builder made no unpacked app in ${join(out, 'release')}`)
    const packaged = packagedLayout(app).helper
    console.log(`packaged_helper=${packaged}`)
    if (!existsSync(packaged)) throw new CheckFailed('missing_helper', `${app} has no ${packaged}`)
    const inside = spawnSync(packaged, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (inside.error || inside.status !== 0)
      throw new CheckFailed('helper_does_not_run', `${packaged} --version: ${inside.error?.message ?? `exit ${inside.status}`}`)
    const insideSaid = parseHelperVersion(inside.stdout)
    if (insideSaid?.build !== said.build || insideSaid.control !== 'none')
      throw new CheckFailed('stale_helper', `the packaged helper says "${(inside.stdout ?? '').trim()}", not build ${said.build}`)
    await startAndAsk(app, join(out, 'home'), Number(process.env.MOUSSE_CHECK_PACKAGE_START_MS ?? 180_000))
    console.log('PASS package-smoke')
  } catch (error) {
    console.log(`note: ${error.message}`)
    console.log(`FAIL package-smoke reason=${error.reason ?? 'failed'}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
