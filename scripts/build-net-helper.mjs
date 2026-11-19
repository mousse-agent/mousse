// Builds the network helper, `mousse-helper` of mousse-net at the commit pinned in `native/net-helper/ENGINE_COMMIT`,
// and puts it in `native/net-helper/target/package`, which electron-builder copies to `resources/net-helper`
// (package.json "build.extraResources"). The daemon runs one per networked profile; without it, networking shows
// "Not in this build".
//
//   node scripts/build-net-helper.mjs            build it; without Rust or git, or when the build fails, say so and do nothing
//   node scripts/build-net-helper.mjs --require  the same, but fail when it cannot be built here (packaging)
//     --arch <x64|arm64>                         for that architecture of this OS (default: this computer's)
//     --target <triple>                          for that Rust target triple (one of the six in net-helper-build.mjs)
//
// The source is a checkout of exactly that commit in `native/net-helper/source`, fetched from MOUSSE_NET_REPO (a
// URL or a local repository; mousse-net on GitHub by default), never a working tree. A source checkout with changes
// or untracked files is left alone and the build stops: moving it to the pinned commit would lose that work. Its
// remotes and ignored files are not touched. It is built with `--locked --target <triple>`; CARGO_TARGET_DIR is
// honoured. On Windows the C runtime is linked in, so the helper runs on a computer without the Visual C++
// redistributable.
//
// The helper names its build in `--version`, from its source's commit. MOUSSE_BUILD_ID, which would override that,
// is not passed to the build: a package says what it was built from. When the built helper runs here, its
// `--version` must name `<ENGINE_COMMIT>+release` and no must-fail control, or the build stops. A helper for another
// architecture is checked where it runs, by `scripts/check-packaged-net-helper.mjs`.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELPER_TARGETS, helperFileName, parseHelperVersion, sameBuild, targetName } from './net-helper-build.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = join(project, 'native', 'net-helper')
const source = join(folder, 'source')
const packageDir = join(folder, 'target', 'package')
const targetDir = process.env.CARGO_TARGET_DIR || join(folder, 'target', 'cargo')
const repo = process.env.MOUSSE_NET_REPO || 'https://github.com/mousse-agent/mousse-net.git'
const args = process.argv.slice(2)
const required = args.includes('--require')
const option = (flag) => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

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

let triple
try {
  triple = option('--target') ?? HELPER_TARGETS[targetName(process.platform, option('--arch') ?? process.arch)]
} catch (error) {
  stop(error.message)
}
if (!Object.values(HELPER_TARGETS).includes(triple))
  stop(`${triple} is not one of the desktop targets (${Object.values(HELPER_TARGETS).join(', ')})`)
const name = helperFileName(triple)

const commit = readFileSync(join(folder, 'ENGINE_COMMIT'), 'utf8').trim()
if (!/^[0-9a-f]{40}$/.test(commit)) stop(`ENGINE_COMMIT is not a full commit id: ${commit}`)

// A package never carries a helper from an earlier build.
rmSync(packageDir, { recursive: true, force: true })

const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
const git = (...args) => run('git', ['-C', source, ...args])

if (run('git', ['--version']).status !== 0) stop('git was not found')

// The pinned commit, checked out alone: fetched by id, or with every branch when the repository does not serve ids.
// A checkout someone works in (changes, untracked files such as signed check results) stops the build instead.
const fresh = !existsSync(join(source, '.git'))
if (fresh) {
  mkdirSync(source, { recursive: true })
  if (run('git', ['init', '-q', source]).status !== 0) stop(`could not create ${source}`)
} else {
  const status = git('status', '--porcelain', '--untracked-files=all')
  if (status.status !== 0) stop(`${source} is not a readable git checkout`)
  const changed = status.stdout.split(/\r?\n/).filter(Boolean)
  if (changed.length > 0)
    stop(
      `${source} has ${changed.length} changed or untracked file(s) (${changed.slice(0, 3).map((line) => line.slice(3)).join(', ')}${changed.length > 3 ? ', ...' : ''}); ` +
        'commit or move them, or point the build at another folder, before it checks out the pinned commit'
    )
}
if (git('cat-file', '-e', `${commit}^{commit}`).status !== 0) {
  const byId = git('fetch', '-q', ...(fresh ? ['--depth', '1'] : []), repo, commit)
  if (byId.status !== 0 && git('fetch', '-q', repo, '+refs/heads/*:refs/net-helper-build/*').status !== 0)
    stop(`could not fetch ${repo}`)
  if (git('cat-file', '-e', `${commit}^{commit}`).status !== 0) stop(`${repo} has no commit ${commit}`)
}
if (git('checkout', '-q', '--detach', commit).status !== 0) stop(`could not check out ${commit}`)
if (git('rev-parse', 'HEAD').stdout.trim() !== commit) stop(`the source is not at ${commit}`)

if (run('cargo', ['--version']).status !== 0) stop('Rust was not found (install it from https://rustup.rs)')
const host = /^host: (.+)$/m.exec(run('rustc', ['-vV']).stdout ?? '')?.[1]?.trim() ?? ''
if (process.platform === 'win32' && !host.endsWith('-msvc'))
  stop(`the Rust toolchain targets ${host || 'an unknown host'}; build with an MSVC one (RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc)`)
// A target other than this computer's own needs its standard library.
if (triple !== host) {
  const installed = run('rustup', ['target', 'list', '--installed'])
  if (installed.status === 0 && !installed.stdout.split(/\r?\n/).includes(triple))
    stop(`the Rust target ${triple} is not installed (rustup target add ${triple})`)
}

const env = { ...process.env, CARGO_TARGET_DIR: targetDir }
// The helper names the commit it was built from, never an id from the environment.
delete env.MOUSSE_BUILD_ID
if (triple.endsWith('-windows-msvc')) {
  const variable = `CARGO_TARGET_${triple.toUpperCase().replace(/-/g, '_')}_RUSTFLAGS`
  env[variable] = [process.env[variable], '-C target-feature=+crt-static'].filter(Boolean).join(' ')
}
const built = run('cargo', ['build', '--release', '--locked', '--target', triple, '-p', 'mousse-helper'], {
  cwd: source,
  stdio: 'inherit',
  env
})
if (built.status !== 0) stop('the build failed')
const output = join(targetDir, triple, 'release', name)
if (!existsSync(output)) stop(`the build left no ${output}`)

mkdirSync(packageDir, { recursive: true })
copyFileSync(output, join(packageDir, name))
writeFileSync(join(packageDir, 'ENGINE_COMMIT'), `${commit}\n`)
writeFileSync(join(packageDir, 'TARGET'), `${triple}\n`)
const size = Math.round(statSync(output).size / 1024 / 1024)
const version = run(join(packageDir, name), ['--version'])
if (version.error && ['ENOEXEC', 'EBADARCH', 'UNKNOWN', 'EACCES'].includes(version.error.code)) {
  console.log(`net helper: ${packageDir} (${triple}, ${commit.slice(0, 12)}, ${size} MiB; not run on this computer)`)
} else {
  if (version.status !== 0) stop(`the built helper does not run: ${version.stderr?.trim() || version.error?.message}`)
  const said = parseHelperVersion(version.stdout)
  if (!said || !sameBuild(said.build, `${commit}+release`) || said.control !== 'none')
    stop(`the built helper says "${version.stdout.trim()}", not build ${commit}+release with control none`)
  console.log(`net helper: ${packageDir} (${version.stdout.trim()}, ${triple}, ${size} MiB)`)
}
