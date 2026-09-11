import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const fixtureDir = dirname(fileURLToPath(import.meta.url))
const evidenceRoot = process.env.MOUSSE_ATTACHED_ROOT
if (!evidenceRoot) {
  process.stderr.write('MOUSSE_ATTACHED_ROOT is required\n')
  process.exit(1)
}
const buildDir = resolve(evidenceRoot, 'build')
const evidencePath = resolve(evidenceRoot, 'evidence.json')
const artifactRoot = resolve(evidenceRoot, 'artifacts')
const userData = resolve(evidenceRoot, 'electron-user-data')
await rm(evidenceRoot, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
await mkdir(artifactRoot, { recursive: true })
await mkdir(userData, { recursive: true })
await build({
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: false,
  logLevel: 'warning',
  packages: 'external',
  banner: {
    js: "import { fileURLToPath as __fixtureFileURLToPath } from 'node:url'; import { dirname as __fixtureDirname } from 'node:path'; const __filename = __fixtureFileURLToPath(import.meta.url); const __dirname = __fixtureDirname(__filename);"
  },
  entryPoints: [resolve(fixtureDir, 'electron-main.ts')],
  outfile: resolve(buildDir, 'main.mjs'),
  external: ['electron']
})
await writeFile(resolve(buildDir, 'package.json'), JSON.stringify({ type: 'module' }))
const env = {
  ...process.env,
  MOUSSE_ATTACHED_EVIDENCE: evidencePath,
  MOUSSE_ATTACHED_ARTIFACTS: artifactRoot,
  MOUSSE_ATTACHED_USER_DATA: userData,
  MOUSSE_ATTACHED_HOST_HTML: resolve(fixtureDir, 'host.html'),
  MOUSSE_ATTACHED_PAGE_HTML: resolve(fixtureDir, 'site', 'page.html')
}
delete env.ELECTRON_RUN_AS_NODE
const electronPath = typeof electron === 'string' ? electron : electron.default ?? electron
const code = await new Promise((resolveExit, reject) => {
  const child = spawn(electronPath, [resolve(buildDir, 'main.mjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    process.stderr.write(chunk)
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.once('error', reject)
  child.once('exit', (exitCode) => {
    if (exitCode) reject(new Error(`attached electron fixture exited ${exitCode}: ${stderr.slice(-4000)}`))
    else resolveExit(0)
  })
})
process.exitCode = code
