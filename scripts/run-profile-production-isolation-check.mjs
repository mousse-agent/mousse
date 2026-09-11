import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(root, '.mousse-dev/profile-production-evidence')
const buildDir = resolve(evidence, 'build')
await rm(evidence, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
const common = { bundle: true, platform: 'node', sourcemap: false, logLevel: 'warning' }
await build({ ...common, packages: 'external', format: 'cjs', entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(buildDir, 'preload.cjs'), external: ['electron'] })
await build({
  ...common,
  packages: 'external',
  format: 'esm',
  banner: { js: "import { fileURLToPath as __fixtureFileURLToPath } from 'node:url'; import { dirname as __fixtureDirname } from 'node:path'; const __filename = __fixtureFileURLToPath(import.meta.url); const __dirname = __fixtureDirname(__filename);" },
  entryPoints: [resolve(root, 'tests/fixtures/profile-isolation/profile-production-main.ts')],
  outfile: resolve(buildDir, 'main.mjs'),
  external: ['electron', 'node-pty'],
  plugins: [{
    name: 'bundle-pi-cursor-model-discovery',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^pi-cursor-sdk\/src\/(.+)$/ }, (args) => ({
        path: resolve(root, `node_modules/pi-cursor-sdk/src/${args.path.slice('pi-cursor-sdk/src/'.length)}.ts`)
      }))
    }
  }]
})
const env = {
  ...process.env,
  MOUSSE_PROFILE_PRODUCTION_EVIDENCE: evidence,
  MOUSSE_PROFILE_PRODUCTION_PRELOAD: resolve(buildDir, 'preload.cjs')
}
delete env.ELECTRON_RUN_AS_NODE
const code = await new Promise((resolveExit, reject) => {
  const child = spawn(electron, [resolve(buildDir, 'main.mjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (exitCode) => resolveExit(exitCode ?? 1))
})
process.exitCode = code
