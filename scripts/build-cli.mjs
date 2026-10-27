import { context } from 'esbuild'
import { mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { buildPackagedNativeReader } from './build-net-native-reader.mjs'
import { buildBrowserWorker, getBrowserWorkerBuildOptions } from './build-browser-worker.mjs'
import { buildPiRuntime } from './build-pi-runtime.mjs'
import { cachedBuild } from './cached-build.mjs'

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
    // Runtime deps stay external (resolved from node_modules).
    packages: 'external'
  }
}

/**
 * The Cursor host entry beside the CLI bundle (`out/cli/cursorHost.js`): the daemon starts it as a
 * child process, and it loads `@cursor/sdk` from node_modules.
 */
export function getCursorHostBuildOptions(projectRoot = root) {
  return {
    entryPoints: [resolve(projectRoot, 'src/mms/harness/hosts/cursorHost.ts')],
    outfile: resolve(projectRoot, 'out/cli/cursorHost.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    packages: 'external'
  }
}

/** The ChatGPT token helper on its own (`out/cli/chatgpt-token.js`): Node built-ins only. */
export function getChatgptTokenBuildOptions(projectRoot = root) {
  return {
    entryPoints: [resolve(projectRoot, 'src/cli/fastpath/chatgptTokenMain.ts')],
    outfile: resolve(projectRoot, 'out/cli/chatgpt-token.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false
  }
}

/**
 * One-shot CLI build, or watch mode for development.
 * @param {{ watch?: boolean, onRebuild?: (error: Error | null) => void, log?: boolean, reuse?: boolean }} [opts]
 */
export async function buildCli(opts = {}) {
  const { watch = false, onRebuild, log = true, reuse = false } = opts
  buildPackagedNativeReader()
  // Pi's agent runs from out/pi-runtime (a copy of the pinned bundle plus Mousse's extension).
  await buildPiRuntime(root)
  mkdirSync(dirname(outfile), { recursive: true })
  const options = getCliBuildOptions(root)

  if (!watch) {
    const worker = await buildBrowserWorker(root, { reuse })
    const cli = await cachedBuild(options, { projectRoot: root, name: 'cli', reuse })
    await cachedBuild(getCursorHostBuildOptions(root), { projectRoot: root, name: 'cursor-host', reuse })
    await cachedBuild(getChatgptTokenBuildOptions(root), { projectRoot: root, name: 'chatgpt-token', reuse })
    if (log) console.log(`${cli.reused ? 'Reused' : 'Built'} ${outfile}`)
    return { cliReused: cli.reused, workerReused: worker.reused }
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
  // The host rarely changes; it is built once when watching starts.
  await cachedBuild(getCursorHostBuildOptions(root), { projectRoot: root, name: 'cursor-host' })
  await cachedBuild(getChatgptTokenBuildOptions(root), { projectRoot: root, name: 'chatgpt-token' })
  const browserOptions = getBrowserWorkerBuildOptions(root)
  let browserContext
  try {
    browserContext = await context({
      ...browserOptions,
      plugins: [...browserOptions.plugins, {
        name: 'browser-worker-rebuild-notify',
        setup(api) {
          api.onEnd((result) => {
            const error = result.errors.length ? new Error(result.errors.map((item) => item.text).join('\n')) : null
            if (error && log) console.error('[browser-worker] rebuild failed:', error.message)
            onRebuild?.(error)
          })
        }
      }]
    })
    await browserContext.watch()
  } catch (error) {
    await browserContext?.dispose()
    await ctx.dispose()
    throw error
  }
  if (log) console.log(`[cli] watching → ${outfile}`)
  return { dispose: async () => { await Promise.all([ctx.dispose(), browserContext.dispose()]) } }
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
