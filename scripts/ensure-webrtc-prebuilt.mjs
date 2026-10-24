// Makes sure the Windows x64 build of node-datachannel (the WebRTC direct path for phones) is in
// node_modules before packaging. npm installs only the host platform's prebuilt, so a Windows
// build made on Linux would otherwise ship without it. The tarball must match the integrity
// recorded in package-lock.json.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = '@node-datachannel/win32-x64-msvc'
const target = join(root, 'node_modules', name)
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const locked = lock.packages?.[`node_modules/${name}`]
if (!locked?.version || !locked.integrity)
  throw new Error(`${name} is missing from package-lock.json`)

const installed = join(target, 'package.json')
if (
  existsSync(installed) &&
  JSON.parse(readFileSync(installed, 'utf8')).version === locked.version
) {
  console.log(`[webrtc-prebuilt] ${name}@${locked.version} is present.`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'mousse-webrtc-prebuilt-'))
try {
  const windows = process.platform === 'win32'
  const npm = windows ? 'npm.cmd' : 'npm'
  // With a shell, Node joins the arguments unquoted; the temp path may contain spaces.
  const destination = windows ? `"${work}"` : work
  const report = JSON.parse(
    execFileSync(
      npm,
      ['pack', `${name}@${locked.version}`, '--json', '--pack-destination', destination],
      {
        cwd: work,
        encoding: 'utf8',
        shell: windows
      }
    )
  )
  // npm 10 reports an array, npm 12 an object keyed by package name.
  const packed = Array.isArray(report) ? report[0] : report[name]
  const tarball = join(work, packed.filename)
  const [algorithm, expected] = locked.integrity.split('-')
  const actual = createHash(algorithm).update(readFileSync(tarball)).digest('base64')
  if (actual !== expected)
    throw new Error(`${name}@${locked.version} does not match package-lock.json`)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'])
  console.log(`[webrtc-prebuilt] Added ${name}@${locked.version} for Windows packaging.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
