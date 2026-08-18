import { build, context } from 'esbuild'
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/cli/index.ts')
const outfile = resolve(root, 'out/cli/index.js')

/** Shared esbuild options for the mousse-cli bundle (and MMS daemon entry). */
export function getCliBuildOptions(projectRoot = root) {
  const out = resolve(projectRoot, 'out/cli/index.js')
  return {
    entryPoints: [resolve(projectRoot, 'src/cli/index.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node\nimport { fileURLToPath as __mousse_fileURLToPath } from "url";\nimport { dirname as __mousse_dirname } from "path";\nconst __filename = __mousse_fileURLToPath(import.meta.url);\nconst __dirname = __mousse_dirname(__filename);',
    },
    // Runtime deps stay external (resolved from node_modules), except packages that
    // ship raw TypeScript and therefore must be compiled into the bundle.
    packages: 'external',
    plugins: [
      {
        name: 'bundle-ts-source-packages',
        setup(api) {
          api.onResolve({ filter: /^pi-cursor-sdk(\/|$)/ }, (args) => {
            const sub =
              args.path === 'pi-cursor-sdk' ? 'src/index' : args.path.slice('pi-cursor-sdk/'.length)
            let path = resolve(projectRoot, 'node_modules/pi-cursor-sdk', sub)
            if (!existsSync(path) && existsSync(`${path}.ts`)) path = `${path}.ts`
            return { path }
          })
        }
      }
    ]
  }
}

/**
 * One-shot CLI build, or watch mode for development.
 * @param {{ watch?: boolean, onRebuild?: (error: Error | null) => void, log?: boolean }} [opts]
 */
export async function buildCli(opts = {}) {
  const { watch = false, onRebuild, log = true } = opts
  mkdirSync(dirname(outfile), { recursive: true })
  const options = getCliBuildOptions(root)

  if (!watch) {
    await build(options)
    if (log) console.log(`Built ${outfile}`)
    return null
  }

  const ctx = await context({
    ...options,
    plugins: [
      ...options.plugins,
      {
        name: 'cli-rebuild-notify',
        setup(api) {
          api.onEnd((result) => {
            const err =
              result.errors.length > 0
                ? new Error(result.errors.map((e) => e.text).join('\n'))
                : null
            if (!err && log) console.log(`[cli] rebuilt ${outfile}`)
            if (err && log) console.error('[cli] rebuild failed:', err.message)
            onRebuild?.(err)
          })
        }
      }
    ]
  })
  await ctx.watch()
  if (log) console.log(`[cli] watching → ${outfile}`)
  return ctx
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const watch = process.argv.includes('--watch')
  await buildCli({ watch })
  if (!watch) {
    // one-shot
  }
}
