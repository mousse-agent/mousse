import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function getBrowserWorkerBuildOptions(projectRoot = root) {
  return {
    entryPoints: [resolve(projectRoot, 'src/browser-worker/index.ts')],
    outfile: resolve(projectRoot, 'out/browser-worker/index.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
    plugins: [{
      name: 'owned-browser-engine',
      setup(api) {
        api.onResolve({ filter: /^(?:electron|playwright(?:-core)?|puppeteer(?:-core)?|browser-use|@browserbasehq\/stagehand)(?:\/|$)/ }, (args) => ({ errors: [{ text: 'The managed browser worker must stay Electron-free and use the owned CDP engine: ' + args.path }] }))
      }
    }]
  }
}
export async function buildBrowserWorker(projectRoot = root) {
  await build(getBrowserWorkerBuildOptions(projectRoot))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildBrowserWorker()
