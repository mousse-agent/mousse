// Writes out/pi-runtime/: the files Mousse needs to run Pi's agent as its own process.
//
//   pi-coding-agent/package.json, pi-coding-agent/dist/bundle/**   the pinned CLI bundle (rpc-entry.js and its chunks)
//   pi-coding-agent/node_modules/<package>/**                      the packages the bundle still imports (RUNTIME_PACKAGES)
//   pi-coding-agent/dist/modes/interactive/theme/*.json             the built-in themes RPC mode loads at startup
//   mousse-extension.mjs                                           Mousse's extension, bundled on its own
//   runtime.json                                                   the versions copied
//
// The Electron build aliases the package to a shim (electron.vite.config.ts), so the runtime is
// launched from these files on disk; packaged builds unpack them from the asar (asarUnpack).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Modules Pi hands to extensions (its `virtualModules`); everything else must be a Node built-in. */
const PI_PROVIDED = /^(?:@earendil-works\/[^/]+|typebox|@sinclair\/typebox)(?:\/|$)/

export function getPiExtensionBuildOptions(projectRoot = root) {
  return {
    entryPoints: [resolve(projectRoot, 'src/mms/harness/pi/extension/index.ts')],
    outfile: resolve(projectRoot, 'out/pi-runtime/mousse-extension.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false,
    plugins: [{
      name: 'pi-extension-imports',
      setup(api) {
        api.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.kind === 'entry-point' || isAbsolute(args.path)) return undefined
          if (PI_PROVIDED.test(args.path)) return { path: args.path, external: true }
          if (args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true }
          return { errors: [{ text: `Mousse's Pi extension may import only Node built-ins and Pi's own modules: ${args.path}` }] }
        })
      }
    }]
  }
}

/** Packages the bundle imports at run time, copied beside it (jiti loads extensions; photon-node resizes images). */
export const RUNTIME_PACKAGES = ['@earendil-works/chord', 'typebox', 'jiti', '@silvia-odwyer/photon-node']
/** Imports guarded with try/catch (Pi's bundle) that Mousse does not ship. */
export const OPTIONAL_IMPORTS = ['@aws-sdk/signature-v4-crt', '@mariozechner/clipboard', 'bufferutil', 'utf-8-validate', 'supports-color']

/** `<from>/node_modules/<name>` or the nearest one above it, as Node resolves a bare import. */
function packageDir(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(directory) === directory) throw new Error(`Pi runtime: ${name} is not installed`)
  }
}

/** A package's published files without maps or type declarations. */
function copyPackage(source, target) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const entries = manifest.files ? ['package.json', ...manifest.files] : readdirSync(source).filter((name) => name !== 'node_modules')
  mkdirSync(target, { recursive: true })
  for (const entry of entries) {
    if (!existsSync(join(source, entry))) continue
    cpSync(join(source, entry), join(target, entry), { recursive: true, filter: (path) => !/\.(map|d\.[cm]?ts)$/.test(path) })
  }
  return manifest.version
}

/** Bare specifiers the bundle imports (static, dynamic, and `require` under any esbuild alias) that are not Node built-ins. */
export function bundleImports(bundleDir) {
  const found = new Set()
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|(?:\b|__)require\d*\s*\(\s*)"((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*)"/g
  const files = readdirSync(bundleDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  for (const file of files)
    for (const match of readFileSync(join(file.parentPath, file.name), 'utf8').matchAll(pattern)) {
      const specifier = match[1]
      if (!builtinModules.includes(specifier) && !builtinModules.includes(specifier.split('/')[0])) found.add(specifier)
    }
  return [...found].sort()
}

export function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier) || builtinModules.includes(specifier.split('/')[0])

/**
 * Dependencies a shipped package declares that Mousse does not ship, each with why no file Pi
 * loads imports it. `runtimeProblems` walks the package's reachable files to hold that true.
 */
export const UNREACHABLE_DEPENDENCIES = {
  '@earendil-works/chord': { esbuild: 'only chord/bundler and chord/node import it; Pi loads chord/context, which imports nothing' }
}

const RUNTIME_CONDITIONS = new Set(['node', 'import', 'require', 'module-sync', 'default'])

/** Every file an export target maps to under a condition Node can pick at run time. */
function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(exportTargets)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).filter(([condition]) => RUNTIME_CONDITIONS.has(condition)).flatMap(([, target]) => exportTargets(target))
}

/** The files `specifier` can load from the package in `directory` (`import` and `require` alike). */
function packageEntries(directory, specifier) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const subpath = specifier === packageName(specifier) ? '.' : `./${specifier.slice(packageName(specifier).length + 1)}`
  if (manifest.exports !== undefined) {
    const exports = typeof manifest.exports === 'string' || Array.isArray(manifest.exports) || !Object.keys(manifest.exports).some((key) => key.startsWith('.'))
      ? { '.': manifest.exports }
      : manifest.exports
    return exportTargets(exports[subpath]).map((target) => join(directory, target))
  }
  return [join(directory, subpath === '.' ? manifest.main ?? 'index.js' : subpath)]
}

function existingFile(path) {
  for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, 'index.js')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return undefined
}

/**
 * The bare imports of every file reachable from `specifiers` inside the package they name, in the
 * runtime at `packageRoot`. A plain scan of import and require calls: meant for packages
 * published as ordinary modules, not for bundles that embed source text.
 */
export function reachableImports(packageRoot, specifiers) {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'])([^"'\s]+)\1/g
  const found = new Set()
  const visited = new Set()
  const files = specifiers.flatMap((specifier) =>
    packageEntries(join(packageRoot, 'node_modules', packageName(specifier)), specifier).map((path) => existingFile(path) ?? path))
  while (files.length) {
    const file = files.pop()
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const specifier = match[2]
      if (specifier.startsWith('.')) {
        const next = existingFile(resolve(dirname(file), specifier))
        if (next) files.push(next)
      } else if (!isBuiltin(specifier)) found.add(specifier)
    }
  }
  return [...found].sort()
}

/**
 * What would fail at run time in the runtime at `packageRoot`: a bare import of Pi's bundle whose
 * package is not inside the runtime, or a shipped package's dependency that is neither shipped
 * nor proven unreachable. Node would otherwise find a missing package in any node_modules above
 * the runtime (the repository's, the user's home) and hide the gap.
 */
export function runtimeProblems(packageRoot) {
  const problems = []
  const shipped = (name) => existsSync(join(packageRoot, 'node_modules', name, 'package.json'))
  const imports = bundleImports(join(packageRoot, 'dist', 'bundle')).filter((specifier) => !OPTIONAL_IMPORTS.includes(packageName(specifier)))
  for (const specifier of imports) if (!shipped(packageName(specifier))) problems.push(`Pi's bundle imports ${specifier}`)
  for (const name of new Set(imports.map(packageName))) {
    if (!shipped(name)) continue
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'node_modules', name, 'package.json'), 'utf8'))
    const optionalPeers = manifest.peerDependenciesMeta ?? {}
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((peer) => !optionalPeers[peer]?.optional)
    ]
    const unshipped = dependencies.filter((dependency) => !shipped(dependency))
    if (!unshipped.length) continue
    const reached = reachableImports(packageRoot, imports.filter((specifier) => packageName(specifier) === name)).map(packageName)
    for (const dependency of unshipped) {
      if (!UNREACHABLE_DEPENDENCIES[name]?.[dependency]) problems.push(`${name} depends on ${dependency}`)
      else if (reached.includes(dependency)) problems.push(`${name} now loads ${dependency}`)
    }
  }
  return problems
}

export async function buildPiRuntime(projectRoot = root, options = {}) {
  const out = options.out ?? resolve(projectRoot, 'out/pi-runtime')
  const pi = resolve(projectRoot, 'node_modules/@earendil-works/pi-coding-agent')
  if (!existsSync(join(pi, 'dist/bundle/rpc-entry.js'))) throw new Error('Pi runtime: @earendil-works/pi-coding-agent is not installed (run npm ci)')

  rmSync(out, { recursive: true, force: true })
  const target = join(out, 'pi-coding-agent')
  mkdirSync(target, { recursive: true })
  cpSync(join(pi, 'package.json'), join(target, 'package.json'))
  cpSync(join(pi, 'dist/bundle'), join(target, 'dist/bundle'), { recursive: true, filter: (path) => !path.endsWith('.map') })
  // RPC mode still loads the built-in theme files at startup.
  for (const theme of ['dark.json', 'light.json', 'theme-schema.json'])
    cpSync(join(pi, 'dist/modes/interactive/theme', theme), join(target, 'dist/modes/interactive/theme', theme))
  const versions = {}
  for (const name of RUNTIME_PACKAGES) versions[name] = copyPackage(packageDir(pi, name), join(target, 'node_modules', name))
  if (!existsSync(join(target, 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm'))) throw new Error('Pi runtime: photon-node has no wasm')
  const problems = runtimeProblems(target)
  if (problems.length) throw new Error(`Pi runtime: packages Mousse does not ship would be loaded: ${problems.join('; ')}`)

  // Loaded here so the check script can import this module where esbuild has no native binary.
  const { build } = await import('esbuild')
  await build({ ...getPiExtensionBuildOptions(projectRoot), outfile: join(out, 'mousse-extension.mjs') })
  const { version } = JSON.parse(readFileSync(join(pi, 'package.json'), 'utf8'))
  writeFileSync(join(out, 'runtime.json'), `${JSON.stringify({ pi: version, packages: versions }, null, 2)}
`)
  return { out, version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, version } = await buildPiRuntime()
  console.log(`Built Pi ${version} runtime in ${out}`)
}
