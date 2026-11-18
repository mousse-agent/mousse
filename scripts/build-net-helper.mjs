// Builds the network helper, `mousse-helper` of mousse-net at the commit pinned in `native/net-helper/ENGINE_COMMIT`,
// and puts it in `native/net-helper/target/package`, which electron-builder copies to `resources/net-helper`
// (package.json "build.extraResources"). The daemon runs one per networked profile; without it, networking shows
// "Not in this build".
//
//   node scripts/build-net-helper.mjs            build it; without Rust or git, or when the build fails, say so and do nothing
//   node scripts/build-net-helper.mjs --require  the same, but fail when it cannot be built here (packaging)
//
// The source is a checkout of exactly that commit in `native/net-helper/source`, fetched from MOUSSE_NET_REPO (a
// URL or a local repository; mousse-net on GitHub by default), never a working tree. It is built with `--locked`;
// CARGO_TARGET_DIR is honoured. On Windows the C runtime is linked in, so the helper runs on a computer without the
// Visual C++ redistributable.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = join(project, 'native', 'net-helper')
const source = join(folder, 'source')
const packageDir = join(folder, 'target', 'package')
const targetDir = process.env.CARGO_TARGET_DIR || join(folder, 'target', 'cargo')
const name = process.platform === 'win32' ? 'mousse-helper.exe' : 'mousse-helper'
const repo = process.env.MOUSSE_NET_REPO || 'https://github.com/mousse-agent/mousse-net.git'
const required = process.argv.includes('--require')

function skip(message) {
  rmSync(packageDir, { recursive: true, force: true })
  console.log(`net helper: ${message}; networking will show "Not in this build".`)
  process.exit(0)
}

function stop(message) {
  if (required) {
    console.error(`net helper: ${message}`)
    process.exit(1)
  }
  skip(message)
}

const commit = readFileSync(join(folder, 'ENGINE_COMMIT'), 'utf8').trim()
if (!/^[0-9a-f]{40}$/.test(commit)) stop(`ENGINE_COMMIT is not a full commit id: ${commit}`)

// A package never carries a helper from an earlier build.
rmSync(packageDir, { recursive: true, force: true })

const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
const git = (...args) => run('git', ['-C', source, ...args])

if (run('git', ['--version']).status !== 0) stop('git was not found')
if (run('cargo', ['--version']).status !== 0) stop('Rust was not found (install it from https://rustup.rs)')
if (process.platform === 'win32') {
  const host = /^host: (.+)$/m.exec(run('rustc', ['-vV']).stdout ?? '')?.[1]?.trim() ?? ''
  if (!host.endsWith('-msvc'))
    stop(`the Rust toolchain targets ${host || 'an unknown host'}; build with an MSVC one (RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc)`)
}

// The pinned commit, checked out alone: fetched by id, or with every branch when the repository does not serve ids.
if (!existsSync(join(source, '.git'))) {
  mkdirSync(source, { recursive: true })
  if (run('git', ['init', '-q', source]).status !== 0) stop(`could not create ${source}`)
}
git('remote', 'remove', 'origin')
git('remote', 'add', 'origin', repo)
if (git('cat-file', '-e', `${commit}^{commit}`).status !== 0) {
  const byId = git('fetch', '-q', '--depth', '1', 'origin', commit)
  if (byId.status !== 0 && git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*').status !== 0)
    stop(`could not fetch ${repo}`)
  if (git('cat-file', '-e', `${commit}^{commit}`).status !== 0) stop(`${repo} has no commit ${commit}`)
}
if (git('checkout', '-q', '--force', '--detach', commit).status !== 0) stop(`could not check out ${commit}`)
git('clean', '-q', '-fdx')
if (git('rev-parse', 'HEAD').stdout.trim() !== commit) stop(`the source is not at ${commit}`)

const env = { ...process.env, CARGO_TARGET_DIR: targetDir }
if (process.platform === 'win32') {
  const flags = process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS
  env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = [flags, '-C target-feature=+crt-static'].filter(Boolean).join(' ')
}
const built = run('cargo', ['build', '--release', '--locked', '-p', 'mousse-helper'], { cwd: source, stdio: 'inherit', env })
if (built.status !== 0) stop('the build failed')
const output = join(targetDir, 'release', name)
if (!existsSync(output)) stop(`the build left no ${output}`)

mkdirSync(packageDir, { recursive: true })
copyFileSync(output, join(packageDir, name))
writeFileSync(join(packageDir, 'ENGINE_COMMIT'), `${commit}\n`)
const version = run(join(packageDir, name), ['--version'])
if (version.status !== 0) stop(`the built helper does not run: ${version.stderr?.trim() || version.error?.message}`)
const size = statSync(output).size
console.log(`net helper: ${packageDir} (${version.stdout.trim()}, ${commit.slice(0, 12)}, ${Math.round(size / 1024 / 1024)} MiB)`)
