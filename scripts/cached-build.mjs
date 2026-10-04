import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { build, version as esbuildVersion } from 'esbuild'

const CACHE_VERSION = 1
const CONFIG_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.node.json',
  'scripts/cached-build.mjs', 'scripts/build-cli.mjs', 'scripts/build-browser-worker.mjs'
]

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileNames(root, directory) {
  const path = resolve(root, directory)
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name)
    return entry.isDirectory() ? fileNames(root, name) : [name]
  }).sort()
}

function buildContext(root) {
  return {
    root: resolve(root),
    runtime: `${process.version}/${process.platform}/${process.arch}/${esbuildVersion}`,
    config: CONFIG_FILES.map((path) => [path, existsSync(resolve(root, path)) ? digest(resolve(root, path)) : null]),
    // New files can change extension/index resolution without changing an old input.
    sources: [...fileNames(root, 'src'), ...fileNames(root, 'node_modules/pi-cursor-sdk/src')]
  }
}

function fingerprints(root, paths) {
  return Object.fromEntries(paths.sort().map((path) => [path, digest(resolve(root, path))]))
}

function unchanged(root, files) {
  if (!files || !Object.keys(files).length) return false
  return Object.entries(files).every(([path, hash]) => digest(resolve(root, path)) === hash)
}

/** Only start opts into reuse; ordinary builds and watch mode still compile. */
export async function cachedBuild(options, { projectRoot, name, reuse = false }) {
  const root = resolve(projectRoot)
  const cachePath = join(root, 'out', '.start-build-cache', `${name}.json`)
  const context = buildContext(root)
  context.options = { ...options, plugins: options.plugins?.map((plugin) => plugin.name) }
  if (reuse) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (cache.version === CACHE_VERSION &&
          JSON.stringify(cache.context) === JSON.stringify(context) &&
          unchanged(root, cache.inputs) && unchanged(root, cache.outputs)) {
        return { reused: true }
      }
    } catch {
      // A missing, corrupt or stale cache is always a regular build.
    }
  }

  const startedAt = Date.now()
  const result = await build({ ...options, absWorkingDir: root, metafile: true })
  try {
    const inputPaths = Object.keys(result.metafile.inputs)
    const outputPaths = Object.keys(result.metafile.outputs)
    const cache = {
      version: CACHE_VERSION,
      context,
      inputs: fingerprints(root, inputPaths),
      outputs: fingerprints(root, outputPaths)
    }
    // Don't certify output if the source tree/configuration changed during compilation.
    const after = buildContext(root)
    after.options = context.options
    if (JSON.stringify(after) === JSON.stringify(context)) {
      if (inputPaths.every((path) => statSync(resolve(root, path)).mtimeMs < startedAt)) {
        mkdirSync(dirname(cachePath), { recursive: true })
        const tempPath = `${cachePath}.${randomUUID()}.tmp`
        writeFileSync(tempPath, JSON.stringify(cache))
        renameSync(tempPath, cachePath)
      }
    }
  } catch {
    // Cache writes are an optimization; compilation errors still propagate above.
  }
  return { reused: false }
}
