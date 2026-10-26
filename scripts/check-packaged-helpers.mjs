#!/usr/bin/env node
// Checks a packaged build (after `electron-builder --dir`) for the Cursor host and its helpers:
// the SDK's platform package sits under app.asar.unpacked, its `rg` runs offline, and the Cursor
// host starts with the packaged Electron and loads the SDK from the archive.
//
//   node scripts/check-packaged-helpers.mjs [release/win-unpacked]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function fail(message) {
  console.error(`check-packaged-helpers: ${message}`)
  process.exit(1)
}

/** The unpacked app: the argument, or the first `release/*-unpacked` (or macOS `.app`). */
function appDir() {
  if (process.argv[2]) return resolve(process.argv[2])
  const release = join(root, 'release')
  if (!existsSync(release)) fail('no release/ folder; run electron-builder --dir first')
  for (const entry of readdirSync(release)) {
    if (entry.endsWith('-unpacked')) return join(release, entry)
    if (entry === 'mac' || entry.startsWith('mac-')) {
      const app = readdirSync(join(release, entry)).find((name) => name.endsWith('.app'))
      if (app) return join(release, entry, app)
    }
  }
  fail('no unpacked app under release/')
}

const app = appDir()
const resources = app.endsWith('.app') ? join(app, 'Contents', 'Resources') : join(app, 'resources')
const unpacked = join(resources, 'app.asar.unpacked')
const platformPackage = join(unpacked, 'node_modules', '@cursor', `sdk-${process.platform}-${process.arch}`)
const exe = process.platform === 'win32' ? '.exe' : ''
const rg = join(platformPackage, 'bin', `rg${exe}`)
const sandbox = join(platformPackage, 'bin', `cursorsandbox${exe}`)
const host = join(unpacked, 'out', 'main', 'cursorHost.js')

for (const [label, path] of [['ripgrep', rg], ['the sandbox helper', sandbox], ['the Cursor host', host]]) {
  if (!existsSync(path)) fail(`${label} is not unpacked: ${path}`)
}

// `rg` runs from the unpacked folder with no network: a bare environment and an empty search.
const version = spawnSync(rg, ['--version'], { encoding: 'utf8', env: { PATH: '' }, timeout: 15_000, windowsHide: true })
if (version.status !== 0 || !/^ripgrep \d/.test(version.stdout)) fail(`rg --version failed: ${version.error?.message ?? version.stderr}`)
console.log(`rg: ${version.stdout.split('\n')[0]}`)

// The host starts with the packaged Electron as Node and loads @cursor/sdk from app.asar.
function electronBinary() {
  if (app.endsWith('.app')) {
    const macos = join(app, 'Contents', 'MacOS')
    return join(macos, readdirSync(macos)[0])
  }
  const names = readdirSync(app).filter((name) => (process.platform === 'win32' ? /\.exe$/i.test(name) : !name.includes('.')))
  const main = names.find((name) => /^mousse/i.test(name)) ?? names[0]
  if (!main) fail(`no executable in ${app}`)
  return join(app, main)
}

const electron = electronBinary()
const child = spawn(electron, [host], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOUSSE_CURSOR_HOST: '1', CURSOR_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
const timer = setTimeout(() => {
  child.kill()
  fail(`the Cursor host did not start in time\n${stderr}`)
}, 30_000)
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk
  if (!buffer.includes('"event":"ready"')) return
  clearTimeout(timer)
  console.log(`host: started with ${electron}`)
  child.stdin.end()
})
child.on('exit', (code) => {
  clearTimeout(timer)
  if (!buffer.includes('"event":"ready"')) fail(`the Cursor host exited with code ${code} before it was ready\n${stderr}`)
  console.log('check-packaged-helpers: ok')
})
