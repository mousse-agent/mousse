// Builds the Windows helper of the SSH endpoint, `native/sshd-helper` -> `native/sshd-helper/target/release/sshd.exe`,
// which the Windows package carries as `resources/editor-ssh/sshd.exe` (package.json "build.win.extraResources").
//
//   node scripts/build-sshd-helper.mjs            build it on Windows; elsewhere, or without Rust, say so and do nothing
//   node scripts/build-sshd-helper.mjs --require  the same, but fail on Windows when it cannot be built (packaging)
//
// The crate depends on `windows-sys` alone, pinned in Cargo.lock, and is built with `--locked`. Without the helper a
// Windows computer carries editor connections to its own OpenSSH server, as before the endpoint.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(project, 'native', 'sshd-helper')
const output = join(crate, 'target', 'release', 'sshd.exe')
const required = process.argv.includes('--require')

function stop(message) {
  if (required) {
    console.error(`sshd helper: ${message}`)
    process.exit(1)
  }
  console.warn(`sshd helper: ${message}; Windows owners will use their own OpenSSH server.`)
  process.exit(0)
}

if (process.platform !== 'win32') {
  console.log('sshd helper: only built on Windows.')
  process.exit(0)
}
if (spawnSync('cargo', ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0)
  stop('cargo was not found (install Rust from https://rustup.rs)')

const built = spawnSync(
  'cargo',
  ['build', '--release', '--locked'],
  // From the crate's folder, so its `.cargo/config.toml` (the C runtime linked in) applies.
  { cwd: crate, stdio: 'inherit', windowsHide: true }
)
if (built.status !== 0) stop('the build failed')
if (!existsSync(output)) stop(`the build left no ${output}`)
const size = statSync(output).size
// A helper this size is far too large for what it does: something unexpected was linked in.
if (size > 2 * 1024 * 1024) stop(`${output} is ${size} bytes`)
console.log(`sshd helper: ${output} (${Math.round(size / 1024)} KiB)`)
