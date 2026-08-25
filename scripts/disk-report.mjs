import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mousseHome = resolve(process.env.MOUSSE_HOME || join(homedir(), '.mousse'))

async function bytes(path) {
  let info
  try { info = await lstat(path) } catch { return 0 }
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  const entries = await readdir(path)
  const sizes = await Promise.all(entries.map((entry) => bytes(join(path, entry))))
  return sizes.reduce((total, size) => total + size, 0)
}

const categories = [
  ['release (reproducible)', join(root, 'release')],
  ['tmp (manual retention)', join(root, 'tmp')],
  ['node_modules (shared)', join(root, 'node_modules')],
  ['build output', join(root, 'out')],
  ['Mousse runtime', mousseHome]
]
const report = []
for (const [category, path] of categories) {
  const size = await bytes(path)
  report.push({ category, path, bytes: size, mebibytes: Number((size / 1024 / 1024).toFixed(2)) })
}
report.sort((a, b) => b.bytes - a.bytes)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.table(report.map(({ category, mebibytes, path }) => ({ category, MiB: mebibytes, path })))
  console.log('Release output is cleaned automatically before packaging. tmp remains manual/recoverable by design.')
}
