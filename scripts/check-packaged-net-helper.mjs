#!/usr/bin/env node
// Checks the network helper of a packaged app, and optionally that the packaged app starts, for the six desktop
// builds (Phase 1b `phase1b.desktop-builds`). The engine kit's build smoke runs it.
//
//   node scripts/check-packaged-net-helper.mjs [<unpacked app>] [--expect <build>] [--start] [--start-wait-ms <ms>]
//
// <unpacked app>  what electron-builder made: `release/win-unpacked`, `release/linux-arm64-unpacked`,
//                 `release/mac-arm64/Mousse.app`, ... (default: the first one under `release/`).
// --expect        the build the helper must be: `<commit>[+profile]`. Default: MOUSSE_BUILD_ID when it is set (the
//                 kit sets it to the build under test), else `<native/net-helper/ENGINE_COMMIT>+release`.
// --start         also start the packaged app headless, as the startup entry does (`--cli service run`, in a new
//                 MOUSSE_HOME), wait until its daemon says it is ready, and stop it.
// --start-wait-ms how long that start may take (default 120000).
//
// It prints, one per line: `helper=<path>`, `helper_build=<build>`, `helper_target=<triple>`, then `app_started=<ms>`
// with --start. It exits 0 and ends with `net helper: ok`, or exits 1 with `net helper: FAIL reason=<word> <why>`:
// `no_app`, `missing_helper`, `helper_does_not_run`, `stale_helper` (another build than expected, a dirty one or one
// with a must-fail control), `app_not_started`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findUnpackedApp, packagedLayout, parseHelperVersion, sameBuild } from './net-helper-build.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export class CheckFailed extends Error {
  constructor(reason, message) {
    super(message)
    this.reason = reason
  }
}

/** The build the packaged helper must be: `--expect`, else MOUSSE_BUILD_ID, else the commit this checkout pins. */
export function expectedBuild({ expect, env = process.env, root = project } = {}) {
  const given = expect ?? env.MOUSSE_BUILD_ID?.trim()
  if (given) return given.includes('+') ? given : `${given}+release`
  return `${readFileSync(join(root, 'native', 'net-helper', 'ENGINE_COMMIT'), 'utf8').trim()}+release`
}

/**
 * Finds the packaged helper of `app`, runs its `--version` (through `run`, a `spawnSync`) and compares the build it
 * names with `expected`. Answers what it found; throws `CheckFailed` with the reason.
 */
export function checkHelper(app, expected, run = spawnSync) {
  const { helper } = packagedLayout(app)
  if (!existsSync(helper)) throw new CheckFailed('missing_helper', `${app} has no ${helper}`)
  const version = run(helper, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (version.error || version.status !== 0)
    throw new CheckFailed(
      'helper_does_not_run',
      `${helper} --version: ${version.error?.message ?? version.stderr?.trim() ?? `exit ${version.status}`}`
    )
  const said = parseHelperVersion(version.stdout)
  if (!said) throw new CheckFailed('stale_helper', `${helper} --version says "${version.stdout.trim()}", with no build`)
  const target = (() => {
    try {
      return readFileSync(join(dirname(helper), 'TARGET'), 'utf8').trim()
    } catch {
      return 'unknown'
    }
  })()
  const found = { helper, build: said.build, control: said.control, target }
  if (said.control !== 'none')
    throw Object.assign(new CheckFailed('stale_helper', `${helper} was built with the must-fail control ${said.control}`), { found })
  if (!sameBuild(said.build, expected))
    throw Object.assign(new CheckFailed('stale_helper', `${helper} is build ${said.build}, not ${expected}`), { found })
  return found
}

/**
 * Starts the packaged app as the startup entry does, headless, in a new MOUSSE_HOME; answers how long it took to
 * say it is ready. Stops it afterwards.
 */
export async function startApp(app, waitMs) {
  const { executable } = packagedLayout(app)
  if (!existsSync(executable)) throw new CheckFailed('app_not_started', `${app} has no ${executable}`)
  const home = mkdtempSync(join(tmpdir(), 'mousse-smoke-home-'))
  const env = { ...process.env, MOUSSE_HOME: home, MOUSSE_CLI: '1' }
  // A display-less Linux has no setuid sandbox helper in an unpacked build and no X server.
  const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  if (process.platform === 'linux') env.ELECTRON_DISABLE_SANDBOX = '1'
  const started = Date.now()
  const child = spawn(executable, ['--cli', ...switches, 'service', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let said = ''
  const listen = (chunk) => (said = (said + chunk).slice(-16_384))
  child.stdout.on('data', listen)
  child.stderr.on('data', listen)
  try {
    return await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new CheckFailed('app_not_started', `the packaged app was not ready within ${waitMs} ms:\n${said}`)),
        waitMs
      )
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new CheckFailed('app_not_started', `the packaged app exited (${code}) before it was ready:\n${said}`))
      })
      const ready = () => {
        if (!/Mousse MMS running \(headless\)/.test(said)) return
        clearTimeout(timer)
        resolvePromise(Date.now() - started)
      }
      child.stdout.on('data', ready)
      child.stderr.on('data', ready)
    })
  } finally {
    child.removeAllListeners('exit')
    const stopped = spawnSync(executable, ['--cli', ...switches, 'service', 'stop'], { env, timeout: 60_000, windowsHide: true })
    if (stopped.status !== 0 && child.exitCode === null) child.kill()
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

async function main(argv) {
  const flags = {}
  let appArg
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--start') flags.start = true
    else if (argv[i] === '--expect' || argv[i] === '--start-wait-ms') flags[argv[i].slice(2)] = argv[++i]
    else appArg = argv[i]
  }
  try {
    const app = appArg ? resolve(appArg) : findUnpackedApp(join(project, 'release'))
    if (!app || !existsSync(app)) throw new CheckFailed('no_app', 'no unpacked app; run electron-builder first')
    const expected = expectedBuild({ expect: flags.expect })
    const found = checkHelper(app, expected)
    console.log(`helper=${found.helper}`)
    console.log(`helper_build=${found.build}`)
    console.log(`helper_target=${found.target}`)
    if (flags.start) console.log(`app_started=${await startApp(app, Number(flags['start-wait-ms'] ?? 120_000))}`)
    console.log('net helper: ok')
  } catch (error) {
    if (error.found) {
      console.log(`helper=${error.found.helper}`)
      console.log(`helper_build=${error.found.build}`)
    }
    console.log(`net helper: FAIL reason=${error.reason ?? 'failed'} ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
