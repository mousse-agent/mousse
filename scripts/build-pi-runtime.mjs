// Writes out/pi-runtime/: the files Mousse needs to run Pi's agent as its own process.
//
//   pi-coding-agent/package.json, pi-coding-agent/dist/bundle/**   the pinned CLI bundle (rpc-entry.js and its chunks)
//   pi-coding-agent/node_modules/<package>/**                      the packages the bundle still imports (RUNTIME_PACKAGES)
//   mousse-extension.mjs                                           Mousse's extension, bundled on its own
//   runtime.json                                                   the versions copied
//
// The Electron build aliases the package to a shim (electron.vite.config.ts), so the runtime is
// launched from these files on disk; packaged builds unpack them from the asar (asarUnpack).
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Packages the bundle imports at run time, copied beside it (photon-node is loaded only for images). */
export const RUNTIME_PACKAGES = ['@earendil-works/chord', 'typebox', '@silvia-odwyer/photon-node']
/** Imports the bundle guards with try/catch, which Mousse does not ship. */
const OPTIONAL_IMPORTS = ['@aws-sdk/signature-v4-crt', '@mariozechner/clipboard', 'bufferutil', 'utf-8-validate', 'supports-color']

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

/** Bare specifiers the bundle imports (static, dynamic and require) that are not Node built-ins. */
export function bundleImports(bundleDir) {
  const found = new Set()
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|(?:\b|__)require\s*\(\s*)"((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*)"/g
  const files = readdirSync(bundleDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  for (const file of files)
    for (const match of readFileSync(join(file.parentPath, file.name), 'utf8').matchAll(pattern)) {
      const specifier = match[1]
      if (!builtinModules.includes(specifier) && !builtinModules.includes(specifier.split('/')[0])) found.add(specifier)
    }
  return [...found].sort()
}

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export async function buildPiRuntime(projectRoot = root) {
  const out = resolve(projectRoot, 'out/pi-runtime')
  const pi = resolve(projectRoot, 'node_modules/@earendil-works/pi-coding-agent')
  if (!existsSync(join(pi, 'dist/bundle/rpc-entry.js'))) throw new Error('Pi runtime: @earendil-works/pi-coding-agent is not installed (run npm ci)')
  const unknown = bundleImports(join(pi, 'dist/bundle')).filter((specifier) =>
    ![...RUNTIME_PACKAGES, ...OPTIONAL_IMPORTS].includes(packageName(specifier)))
  if (unknown.length) throw new Error(`Pi runtime: the bundle imports packages Mousse does not ship: ${unknown.join(', ')}`)

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

  await build(getPiExtensionBuildOptions(projectRoot))
  const { version } = JSON.parse(readFileSync(join(pi, 'package.json'), 'utf8'))
  writeFileSync(join(out, 'runtime.json'), `${JSON.stringify({ pi: version, packages: versions }, null, 2)}
`)
  return { out, version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, version } = await buildPiRuntime()
  console.log(`Built Pi ${version} runtime in ${out}`)
}
