import { build } from 'esbuild'
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/cli/index.ts')
const outfile = resolve(root, 'out/cli/index.js')

mkdirSync(dirname(outfile), { recursive: true })

const banner = '#!/usr/bin/env node'

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  banner: { js: banner },
  // Runtime deps stay external (resolved from node_modules), except packages that
  // ship raw TypeScript and therefore must be compiled into the bundle.
  packages: 'external',
  plugins: [
    {
      name: 'bundle-ts-source-packages',
      setup(api) {
        api.onResolve({ filter: /^pi-cursor-sdk(\/|$)/ }, (args) => {
          const sub = args.path === 'pi-cursor-sdk' ? 'src/index' : args.path.slice('pi-cursor-sdk/'.length)
          let path = resolve(root, 'node_modules/pi-cursor-sdk', sub)
          if (!existsSync(path) && existsSync(`${path}.ts`)) path = `${path}.ts`
          return { path }
        })
      }
    }
  ]
})

console.log(`Built ${outfile}`)
