import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const entries = {
  'full-shell-seed': ['git-foundation-full-shell-seed.ts', 'seed.mjs'],
  'live-provider': ['git-foundation-live-provider.ts', 'live.mjs']
}
const entry = entries[process.argv[2]]
if (!entry) throw new Error('Choose full-shell-seed or live-provider')
const outfile = resolve(root, '.mousse-dev/quality-full-shell', entry[1])
await build({
  entryPoints: [resolve(root, 'tests/fixtures', entry[0])], outfile,
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  banner: { js: "import {createRequire as __fixtureRequire} from 'node:module'; const require=__fixtureRequire(import.meta.url); const __dirname=import.meta.dirname; const __filename=import.meta.filename;" },
  plugins: [{ name: 'cursor-discovery', setup(api) {
    api.onResolve({ filter: /^pi-cursor-sdk\/src\// }, (args) => ({ path: resolve(root, 'node_modules', args.path + '.ts') }))
  } }]
})
console.log(outfile)
