import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'out/browser-worker/index.mjs')
mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/browser-worker/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info'
})

console.log(`Bundled ${outfile}`)
