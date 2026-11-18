#!/usr/bin/env node
/**
 * Runs one Phase 1a owner check in this checkout and prints what the check kit judges:
 *
 *   app_build=<commit>[-dirty]
 *   PASS <id>            (exit 0)
 *   FAIL <id> reason=<word>   (exit 1)
 *
 * Usage: node scripts/net-engine-check.mjs <check id> [--out <folder>]
 *
 * `MOUSSE_NET_ENGINE_CONTROL` (a control's deliberate defect) and `MOUSSE_NET_HELPER` pass through to the run. Each
 * check is a test file under tests/netEngine/checks; its first failed step writes its reason to the run's folder.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKS = {
  'phase1a.picker-v1-off': 'tests/netEngine/checks/pickerV1Off.test.ts'
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const id = args[0]
const outAt = args.indexOf('--out')
if (!id || !(id in CHECKS)) {
  console.error(`Usage: node scripts/net-engine-check.mjs <${Object.keys(CHECKS).join('|')}> [--out <folder>]`)
  process.exit(2)
}
const out = outAt > 0 && args[outAt + 1] ? resolve(args[outAt + 1]) : mkdtempSync(join(tmpdir(), 'net-engine-check-'))
mkdirSync(out, { recursive: true })

const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
const commit = git('rev-parse', 'HEAD').stdout.trim() || 'unknown'
const dirty = git('status', '--porcelain').stdout.trim() !== ''
console.log(`app_build=${commit}${dirty ? '-dirty' : ''}`)
console.log(`helper=${process.env.MOUSSE_NET_HELPER ? process.env.MOUSSE_NET_HELPER : 'in-memory'}`)
if (process.env.MOUSSE_NET_ENGINE_CONTROL) console.log(`control=${process.env.MOUSSE_NET_ENGINE_CONTROL}`)

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const run = spawnSync(process.execPath, [vitest, 'run', CHECKS[id], '--reporter=verbose'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, MOUSSE_NET_ENGINE_CHECK_OUT: out }
})
const reasonFile = join(out, 'reason')
const reason = existsSync(reasonFile) ? readFileSync(reasonFile, 'utf8').trim() : ''
if (run.status === 0 && !reason) {
  console.log(`PASS ${id}`)
  process.exit(0)
}
console.log(`FAIL ${id}${reason ? ` reason=${reason}` : ''}`)
process.exit(1)
