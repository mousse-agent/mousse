// Builds the native voice engine of read aloud, `native/voice-engine`, and puts what a package carries in
// `native/voice-engine/target/package`, which electron-builder copies to `resources/voice-engine`
// (package.json "build.extraResources"). The app runs Kokoro there; without it, Kokoro runs on WebAssembly.
//
//   node scripts/build-voice-engine.mjs            build it; without Rust, or where it cannot be built, say so and do nothing
//   node scripts/build-voice-engine.mjs --require  the same, but fail when it cannot be built here (packaging)
//
// The crate is built with `--locked`. ONNX Runtime is linked into the binary from the prebuilt libraries the `ort`
// crate downloads while building; there are none for Intel macOS, which ships without the engine.
//
// On Windows the build needs the MSVC toolchain (set RUSTUP_TOOLCHAIN to an `-msvc` one when the default is
// another). ONNX Runtime's libraries use the shared Visual C++ runtime, so its DLLs from Visual Studio's
// redistributable folder go beside the engine: it then runs on a computer without the runtime installed.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(project, 'native', 'voice-engine')
const name = process.platform === 'win32' ? 'mousse-voice.exe' : 'mousse-voice'
const output = join(crate, 'target', 'release', name)
const packageDir = join(crate, 'target', 'package')
const required = process.argv.includes('--require')
/** The Visual C++ runtime DLLs the engine imports. */
const VC_RUNTIME = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

function skip(message) {
  rmSync(packageDir, { recursive: true, force: true })
  console.log(`voice engine: ${message}; Kokoro will run on WebAssembly.`)
  process.exit(0)
}

function stop(message) {
  if (required) {
    console.error(`voice engine: ${message}`)
    process.exit(1)
  }
  skip(message)
}

// A package never carries an engine from an earlier build.
rmSync(packageDir, { recursive: true, force: true })

if (process.platform === 'darwin' && process.arch === 'x64') skip('ONNX Runtime has no prebuilt libraries for Intel macOS')
const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8', windowsHide: true })
if (rustc.status !== 0) stop('Rust was not found (install it from https://rustup.rs)')
const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1]?.trim() ?? ''
if (process.platform === 'win32' && !host.endsWith('-msvc')) {
  stop(`the Rust toolchain targets ${host || 'an unknown host'}; build with an MSVC one (RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc)`)
}

const built = spawnSync('cargo', ['build', '--release', '--locked'], { cwd: crate, stdio: 'inherit', windowsHide: true })
if (built.status !== 0) stop('the build failed')
if (!existsSync(output)) stop(`the build left no ${output}`)

/** The newest `VC\Redist\MSVC\<version>\x64\Microsoft.VC*.CRT` folder of the installed Visual Studio. */
function vcRuntimeDir() {
  const fromEnv = process.env.VCToolsRedistDir
  const roots = []
  if (fromEnv) roots.push(fromEnv)
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true })
    const install = found.stdout?.trim().split(/\r?\n/)[0]
    if (install) {
      const redist = join(install, 'VC', 'Redist', 'MSVC')
      if (existsSync(redist)) {
        const versions = readdirSync(redist).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        roots.push(...versions.map((version) => join(redist, version)))
      }
    }
  }
  for (const root of roots) {
    const x64 = join(root, 'x64')
    if (!existsSync(x64)) continue
    const crt = readdirSync(x64).find((entry) => /^Microsoft\.VC\d+\.CRT$/.test(entry))
    if (crt && VC_RUNTIME.every((dll) => existsSync(join(x64, crt, dll)))) return join(x64, crt)
  }
  return null
}

mkdirSync(packageDir, { recursive: true })
copyFileSync(output, join(packageDir, name))
if (process.platform === 'win32') {
  const runtime = vcRuntimeDir()
  if (!runtime) stop("Visual Studio's redistributable Visual C++ runtime was not found")
  for (const dll of VC_RUNTIME) copyFileSync(join(runtime, dll), join(packageDir, dll))
}
const size = statSync(output).size
console.log(`voice engine: ${packageDir} (${name}, ${Math.round(size / 1024 / 1024)} MiB)`)
