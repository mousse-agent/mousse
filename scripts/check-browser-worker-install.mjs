/**
 * Downloads the pinned Chrome for Testing build into .mousse-dev/browser-binaries.
 * Does not import TypeScript. Used for fixture qualification; binaries are not committed.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureWindowsBrowserSandboxAccess } from '../src/shared/browser/windowsSandboxPermissions.mjs'

const VERSION = '153.0.8010.36'
const REVISION = '1681091'
const CHANNEL = 'Stable'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserRoot = resolve(root, '.mousse-dev/browser-binaries')
const logDir = resolve(root, '.mousse-dev/logs')
mkdirSync(logDir, { recursive: true })

function platformId() {
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'win32' : 'win64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  throw new Error(`Unsupported platform ${process.platform}/${process.arch}`)
}

function executableRel(platform) {
  if (platform === 'win64') return 'chrome-win64/chrome.exe'
  if (platform === 'win32') return 'chrome-win32/chrome.exe'
  if (platform === 'linux64') return 'chrome-linux64/chrome'
  if (platform === 'linux-arm64') return 'chrome-linux-arm64/chrome'
  if (platform === 'mac-x64') return 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  return 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
}

function zipName(platform) {
  if (platform.startsWith('mac')) return `chrome-${platform}.zip`
  return `chrome-${platform}.zip`
}

async function download(url, dest) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${url}`)
  mkdirSync(dirname(dest), { recursive: true })
  const hash = createHash('sha256')
  const file = createWriteStream(dest)
  const readable = Readable.fromWeb(response.body)
  readable.on('data', (chunk) => hash.update(chunk))
  await pipeline(readable, file)
  return hash.digest('hex')
}

function extract(zipPath, dest) {
  mkdirSync(dest, { recursive: true })
  // GNU tar cannot read ZIP archives. Windows/macOS ship libarchive tar.
  const command = process.platform === 'linux' ? 'unzip' : process.platform === 'win32' ? 'tar.exe' : 'tar'
  const args = process.platform === 'linux' ? ['-q', zipPath, '-d', dest] : ['-xf', zipPath, '-C', dest]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))))
  })
}

const platform = platformId()
const installDir = join(browserRoot, 'binaries', 'certified')
const metadataPath = join(installDir, 'metadata.json')
const exeRel = executableRel(platform)
if (existsSync(join(installDir, exeRel)) && existsSync(metadataPath)) {
  const existing = JSON.parse(readFileSync(metadataPath, 'utf-8'))
  ensureWindowsBrowserSandboxAccess(browserRoot, dirname(join(installDir, exeRel)))
  const receipt = { skipped: true, reason: 'already-installed', metadata: existing }
  writeFileSync(join(logDir, 'browser-worker-install.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
  process.exit(0)
}

const url = `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/${zipName(platform)}`
const staging = join(browserRoot, 'binaries', 'staging')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
const zipPath = join(staging, zipName(platform))
console.log('Downloading', url)
const sha256 = await download(url, zipPath)
const unpack = join(staging, 'unpack')
mkdirSync(unpack, { recursive: true })
await extract(zipPath, unpack)
if (!existsSync(join(unpack, exeRel))) throw new Error(`missing ${exeRel}`)
// Apply before moving: Windows moves can retain the staging file ACL.
ensureWindowsBrowserSandboxAccess(browserRoot, dirname(join(unpack, exeRel)))
rmSync(installDir, { recursive: true, force: true })
mkdirSync(dirname(installDir), { recursive: true })
renameSync(unpack, installDir)
ensureWindowsBrowserSandboxAccess(browserRoot, dirname(join(installDir, exeRel)))
const metadata = {
  source: 'chrome-for-testing',
  channel: CHANNEL,
  version: VERSION,
  revision: REVISION,
  platform,
  url,
  sha256,
  executable: exeRel,
  certifiedAt: new Date().toISOString()
}
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
writeFileSync(join(browserRoot, 'binaries', `SHA256-${VERSION}-${platform}.txt`), `${sha256}  ${url}\n`)
rmSync(staging, { recursive: true, force: true })
const receipt = { skipped: false, metadata }
writeFileSync(join(logDir, 'browser-worker-install.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt, null, 2))
