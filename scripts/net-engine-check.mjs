#!/usr/bin/env node
/**
 * Runs one owner check (Phase 1a or 1b) in this checkout and prints what the check kit judges:
 *
 *   app_build=<commit>[-dirty]
 *   PASS <id>            (exit 0)
 *   FAIL <id> reason=<word>   (exit 1)
 *
 * Usage: node scripts/net-engine-check.mjs <check id> [--out <folder>] [--role host|caller] [--topology <name>]
 *
 * `MOUSSE_NET_ENGINE_CONTROL` (a control's deliberate defect) and `MOUSSE_NET_HELPER` pass through to the run. Each
 * check is a test file under tests/netEngine/checks; its first failed step writes its reason to the run's folder.
 *
 * A cross-machine cell runs once per computer: `--role host` on the computer that listens, `--role caller` on the one
 * that dials, with `--topology` naming the cell's endpoints. The run gets them as `MOUSSE_NET_ENGINE_CHECK_ROLE` and
 * `MOUSSE_NET_ENGINE_CHECK_TOPOLOGY`. A caller writes the builds its host reported over the test link to the run's
 * folder (`host_build`, `host_app_build`), printed here as `host_build=` and `host_app_build=` lines. A check with
 * no cross-machine form refuses a role. The caller finds its host at `MOUSSE_NET_ENGINE_CHECK_HOST` (its local network
 * address; the test link is `tests/netEngine/checks/link.ts`).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKS = {
  'phase1a.picker-v1-off': 'tests/netEngine/checks/pickerV1Off.test.ts',
  'phase1a.private-streams': 'tests/netEngine/checks/privateStreams.test.ts',
  'phase1a.once-or-unknown': 'tests/netEngine/checks/onceOrUnknown.test.ts',
  'phase1a.pair-both-ways': 'tests/netEngine/checks/pairBothWays.test.ts',
  'phase1a.removal': 'tests/netEngine/checks/removal.test.ts',
  'phase1a.reconnect': 'tests/netEngine/checks/reconnect.test.ts',
  'phase1a.path-switch': 'tests/netEngine/checks/pathSwitch.test.ts',
  'phase1a.pair-offline': 'tests/netEngine/checks/pairOffline.test.ts',
  'phase1a.shared-computer': 'tests/netEngine/checks/sharedComputer.test.ts',
  'phase1b.link-app': 'tests/netEngine/checks/linkApp.test.ts'
}
/** The checks that run as cross-machine cells, one role per computer. */
const CROSS_MACHINE = new Set(['phase1a.pair-offline', 'phase1a.shared-computer'])

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = `Usage: node scripts/net-engine-check.mjs <${Object.keys(CHECKS).join('|')}> [--out <folder>] [--role host|caller] [--topology <name>]`
const refuse = (message) => {
  console.error(message ? `${message}\n${usage}` : usage)
  process.exit(2)
}
const flags = {}
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  if (!['--out', '--role', '--topology'].includes(arg)) refuse(`Unknown option ${arg}.`)
  const value = argv[++i]
  if (value === undefined) refuse(`${arg} needs a value.`)
  flags[arg.slice(2)] = value
}
const id = positional[0]
if (positional.length !== 1 || !(id in CHECKS)) refuse()
if (flags.role !== undefined && !['host', 'caller'].includes(flags.role))
  refuse(`--role is host or caller, not ${flags.role}.`)
if ((flags.role !== undefined || flags.topology !== undefined) && !CROSS_MACHINE.has(id))
  refuse(`${id} runs on one computer; it takes no --role or --topology.`)
if (CROSS_MACHINE.has(id) && flags.role === undefined)
  refuse(`${id} is a cross-machine cell: give --role.`)
const out = flags.out ? resolve(flags.out) : mkdtempSync(join(tmpdir(), 'net-engine-check-'))
mkdirSync(out, { recursive: true })
// What an earlier run left in the folder is not this run's.
for (const key of ['reason', 'host_build', 'host_app_build'])
  rmSync(join(out, key), { force: true })

const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
const commit = git('rev-parse', 'HEAD').stdout.trim() || 'unknown'
const dirty = git('status', '--porcelain').stdout.trim() !== ''
console.log(`app_build=${commit}${dirty ? '-dirty' : ''}`)
// The checks run the helper named by MOUSSE_NET_HELPER (each computer's engine service starts it), else the fake one.
const helper = process.env.MOUSSE_NET_HELPER?.trim()
if (helper && !existsSync(helper)) {
  console.log(`FAIL ${id} reason=no_helper (${helper} does not exist)`)
  process.exit(1)
}
console.log(helper ? `helper=${helper}` : 'helper=fake')
if (process.env.MOUSSE_NET_ENGINE_CONTROL)
  console.log(`control=${process.env.MOUSSE_NET_ENGINE_CONTROL}`)
if (flags.role) console.log(`role=${flags.role}`)
if (flags.topology) console.log(`topology=${flags.topology}`)

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const run = spawnSync(process.execPath, [vitest, 'run', CHECKS[id], '--reporter=verbose'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MOUSSE_NET_ENGINE_CHECK_OUT: out,
    MOUSSE_NET_ENGINE_CHECK_APP_BUILD: `${commit}${dirty ? '-dirty' : ''}`,
    ...(flags.role ? { MOUSSE_NET_ENGINE_CHECK_ROLE: flags.role } : {}),
    ...(flags.topology ? { MOUSSE_NET_ENGINE_CHECK_TOPOLOGY: flags.topology } : {})
  }
})
// What a caller heard of its host's builds over the test link.
for (const key of ['host_build', 'host_app_build']) {
  const file = join(out, key)
  const value = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (value && !/\s/.test(value)) console.log(`${key}=${value}`)
}
const reasonFile = join(out, 'reason')
const reason = existsSync(reasonFile) ? readFileSync(reasonFile, 'utf8').trim() : ''
if (run.status === 0 && !reason) {
  console.log(`PASS ${id}`)
  process.exit(0)
}
console.log(`FAIL ${id}${reason ? ` reason=${reason}` : ''}`)
process.exit(1)
