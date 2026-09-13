import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const viteCache = resolve(projectRoot, 'node_modules', '.vite')
const tempRoot = await realpath(tmpdir())
const staleBefore = Date.now() - 24 * 60 * 60 * 1_000
const prefix = 'mousse-browser-eval-'
let removed = 0

for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
  const candidate = resolve(tempRoot, entry.name)
  if (dirname(candidate) !== tempRoot) throw new Error(`Refusing unsafe temp path: ${candidate}`)
  const info = await lstat(candidate)
  if (info.isSymbolicLink() || info.mtimeMs >= staleBefore) continue
  await rm(candidate, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  removed += 1
}

if (viteCache !== resolve(projectRoot, 'node_modules/.vite')) {
  throw new Error(`Refusing unsafe Vite cache path: ${viteCache}`)
}
await rm(viteCache, { recursive: true, force: true })

const filesystem = await statfs(projectRoot)
const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
// Current x64 packaging peaks around 1.1 GiB (unpacked app + NSIS archive and
// compiler mmap). Leave additional headroom for filesystem and bundle changes.
const minimumBytes = 1.25 * 1024 ** 3
const formatGiB = (bytes) => (bytes / 1024 ** 3).toFixed(2)

console.log(`[prepare-package] Removed ${removed} stale browser evaluation director${removed === 1 ? 'y' : 'ies'}.`)
console.log('[prepare-package] Cleared the reproducible Vite dependency cache.')
console.log(`[prepare-package] ${formatGiB(freeBytes)} GiB free on the packaging drive.`)

if (freeBytes < minimumBytes) {
  throw new Error(
    `Windows packaging needs at least ${formatGiB(minimumBytes)} GiB free; ` +
    `only ${formatGiB(freeBytes)} GiB is available. NSIS otherwise fails with ` +
    `'Internal compiler error #12345: error creating mmap'.`
  )
}
