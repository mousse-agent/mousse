#!/usr/bin/env node
/**
 * The packaged parent hard-kill check (design §1, row M2): a packaged app's daemon runs a networked profile's helper
 * from the package's own resources; the daemon is killed outright; the helper must exit within a second (its stdin
 * closes, it sends GOAWAY and exits).
 *
 *   node scripts/net-helper-hard-kill.mjs <Windows app folder | Mousse.app> [--phase=init]
 *
 * `--phase=init` kills the daemon during its first start instead, while it runs `init` for the new endpoint (held
 * there by `MOUSSE_NET_INIT_HOLD_MS`, as a slow keystore would hold it): `init` must exit within a second too.
 *
 * On macOS the daemon is Electron's main process, which only gets ready in a logged-in GUI session (not over ssh).
 *
 * It uses a fresh home in the temp folder and has the helper listen on loopback (no firewall prompt). An installed app
 * keeps its identity key in the OS keystore only, so the run makes one keystore entry, `endpoint-<id>` of service
 * `mousse-net`, and deletes it at the end. Prints `PASS net-helper-hard-kill helper_exit_ms=<n>` or
 * `FAIL net-helper-hard-kill reason=<word>` (with `phase=init` after the name for that phase).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXIT_WITHIN_MS = 1_000
/** How long `init` is held in the init phase: longer than the wait for it to exit. */
const INIT_HOLD_MS = 20_000
const target = process.argv[2] && resolve(process.argv[2])
/** `--keep` leaves the home (its logs) in place. */
const keep = process.argv.includes('--keep')
/** The control, `--control=daemon-spared`: the daemon is not killed, so the check must fail (helper_outlived_daemon). */
const spared = process.argv.includes('--control=daemon-spared')
const initPhase = process.argv.includes('--phase=init')
const NAME = initPhase ? 'net-helper-hard-kill phase=init' : 'net-helper-hard-kill'
const COMMAND = initPhase ? 'init' : 'serve'
const win = process.platform === 'win32'
// An installed Windows app has mousse-cli.exe (its installer makes it from Mousse.exe); an unpacked one has Mousse.exe
// only, which runs the same daemon when MOUSSE_CLI is set.
const daemon = !target
  ? undefined
  : win
    ? [join(target, 'mousse-cli.exe'), join(target, 'Mousse.exe')].find((path) => existsSync(path))
    : join(target, 'Contents', 'MacOS', 'Mousse')
const helperName = win ? 'mousse-helper.exe' : 'mousse-helper'
const packagedHelper = !target
  ? undefined
  : win
    ? join(target, 'resources', 'net-helper', helperName)
    : join(target, 'Contents', 'Resources', 'net-helper', helperName)

function fail(reason, detail) {
  if (detail) console.log(detail)
  console.log(`FAIL ${NAME} reason=${reason}`)
  cleanup()
  process.exit(1)
}

if (!daemon || !existsSync(daemon))
  fail('no_app', `Usage: node scripts/net-helper-hard-kill.mjs <app folder | Mousse.app>`)
if (!existsSync(packagedHelper)) fail('no_helper', `${packagedHelper} is not in the package`)

const home = mkdtempSync(join(tmpdir(), 'net-hard-kill-'))
const env = {
  ...process.env,
  MOUSSE_CLI: '1',
  MOUSSE_HOME: home,
  MOUSSE_NET_ENGINE_HELPER_LISTEN_IP: '127.0.0.1'
}
delete env.MOUSSE_NET_HELPER
delete env.MOUSSE_NET_ENGINE_INSECURE_FILE_KEY
delete env.ELECTRON_RUN_AS_NODE
const started = []

function cleanup() {
  for (const child of started) if (child.exitCode === null) child.kill('SIGKILL')
  for (const { pid } of processes()) if (started.some((child) => child.pid === pid)) kill(pid)
  forgetKeys()
  if (keep) return console.log(`home=${home}`)
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch {
    // Left to the temp folder.
  }
}

/** Deletes the keystore entry of every endpoint the run made (named in its `identity.json`). */
function forgetKeys() {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return
  for (const profile of readdirSync(profiles)) {
    const identity = join(profiles, profile, 'net-engine', 'endpoint', 'identity.json')
    if (!existsSync(identity)) continue
    let user
    try {
      user = JSON.parse(readFileSync(identity, 'utf8')).keyring_user
    } catch {
      continue
    }
    if (typeof user !== 'string' || !/^endpoint-[\w-]+$/.test(user)) continue
    const done = win
      ? spawnSync('cmdkey', [`/delete:${user}.mousse-net`], { encoding: 'utf8', windowsHide: true })
      : spawnSync('security', ['delete-generic-password', '-s', 'mousse-net', '-a', user], {
          encoding: 'utf8'
        })
    console.log(
      done.status === 0 ? `keystore entry ${user} deleted` : `keystore entry ${user} not deleted`
    )
  }
}

/** Every process: pid, parent pid, executable and command line. */
function processes() {
  if (win) {
    const out = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'
      ],
      { encoding: 'utf8', windowsHide: true }
    ).stdout
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, path, args] = line.split('\t')
        return { pid: Number(pid), ppid: Number(ppid), path: path ?? '', args: args ?? '' }
      })
  }
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? []
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        path: (args ?? '').split(' --')[0],
        args: args ?? ''
      }
    })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function kill(pid) {
  if (win)
    spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone already.
    }
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function startDaemon(log) {
  const child = spawn(daemon, ['--cli', 'service', 'run', '--home', home], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (bytes) => log.push(String(bytes)))
  child.stderr.on('data', (bytes) => log.push(String(bytes)))
  started.push(child)
  return child
}

/** Whether `pid` descends from `root`. */
function descends(list, pid, root) {
  const parent = new Map(list.map((row) => [row.pid, row.ppid]))
  for (let at = pid, hops = 0; at && hops < 32; at = parent.get(at), hops++)
    if (at === root) return true
  return false
}

async function main() {
  // The first run makes the home and its default profile; the networking switch is then turned on in it.
  const first = []
  const setup = startDaemon(first)
  const profiles = join(home, 'profiles')
  let profile
  for (const until = Date.now() + 90_000; Date.now() < until && !profile; await sleep(500)) {
    profile = existsSync(profiles)
      ? readdirSync(profiles).find((name) => existsSync(join(profiles, name, 'mousse.conf')))
      : undefined
    if (setup.exitCode !== null) fail('daemon_exited', first.join('').slice(-2000))
  }
  if (!profile) fail('no_profile', first.join('').slice(-2000))
  await sleep(3_000)
  spawnSync(daemon, ['--cli', 'service', 'stop', '--home', home], {
    env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 60_000
  })
  for (const until = Date.now() + 30_000; Date.now() < until && setup.exitCode === null;)
    await sleep(250)
  if (setup.exitCode === null) kill(setup.pid)
  await sleep(1_000)
  mkdirSync(join(profiles, profile, 'net-engine'), { recursive: true })
  writeFileSync(
    join(profiles, profile, 'net-engine', 'settings.json'),
    JSON.stringify({ enabled: true, profile })
  )

  // The second run starts the helper once it is ready (first `init` for the new endpoint, then `serve`).
  const log = []
  if (initPhase) env.MOUSSE_NET_INIT_HOLD_MS = String(INIT_HOLD_MS)
  const root = startDaemon(log)
  let helper
  for (const until = Date.now() + 90_000; Date.now() < until && !helper; await sleep(500)) {
    const list = processes()
    helper = list.find(
      (row) =>
        row.path.endsWith(helperName) &&
        new RegExp(` ${COMMAND} `).test(row.args) &&
        descends(list, row.pid, root.pid)
    )
    if (root.exitCode !== null) fail('daemon_exited', log.join('').slice(-2000))
  }
  if (!helper) fail('no_helper_started', log.join('').slice(-2000))
  if (win && resolve(helper.path).toLowerCase() !== resolve(packagedHelper).toLowerCase())
    fail('wrong_helper', `${helper.path} is not ${packagedHelper}`)
  console.log(`daemon=${helper.ppid} helper=${helper.pid} ${helper.path}`)
  // Up a moment, as a helper in use is (in `init`, well inside its hold).
  await sleep(initPhase ? 1_000 : 2_000)
  if (!alive(helper.pid)) fail('helper_stopped_early', log.join('').slice(-2000))
  const killedAt = Date.now()
  if (spared) console.log('control=daemon-spared')
  else kill(helper.ppid)
  while (alive(helper.pid) && Date.now() - killedAt < 10_000) await sleep(20)
  const took = Date.now() - killedAt
  if (alive(helper.pid)) {
    kill(helper.pid)
    fail(
      'helper_outlived_daemon',
      `the helper was still running ${took} ms after its daemon was killed`
    )
  }
  if (took > EXIT_WITHIN_MS)
    fail('helper_exit_slow', `the helper exited ${took} ms after its daemon was killed`)
  cleanup()
  console.log(`PASS ${NAME} helper_exit_ms=${took}`)
}

main().catch((error) => fail('error', String(error?.stack ?? error)))
