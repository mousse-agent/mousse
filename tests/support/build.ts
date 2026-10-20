import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version as esbuildVersion, type BuildOptions } from 'esbuild'
import { getCliBuildOptions } from '../../scripts/build-cli.mjs'
import { getBrowserWorkerBuildOptions } from '../../scripts/build-browser-worker.mjs'
import { buildPackagedNativeReader } from '../../scripts/build-net-native-reader.mjs'

/**
 * Test bundles built once per source state and shared by every test file and worker.
 *
 * Artifacts live under the temp directory, keyed by a digest of everything that can change
 * the output (source contents, build configuration, lockfile, Node and esbuild versions).
 * A directory lock serializes concurrent builders; a finished artifact is published by one
 * atomic rename, so readers never observe a partial build. Unchanged sources therefore cost
 * one digest pass instead of a bundle per test file, within a run and across runs.
 */

const CACHE_VERSION = 1
export const projectRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'scripts/build-cli.mjs',
  'scripts/build-browser-worker.mjs',
  'scripts/build-net-native-reader.mjs',
  'tests/support/build.ts'
]
const SOURCE_ROOTS = ['src', 'node_modules/pi-cursor-sdk/src']

const sha256 = (input: Buffer | string) => createHash('sha256').update(input).digest('hex')
const fileDigest = (path: string) => sha256(readFileSync(path))

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    })
    .sort()
}

/** Everything outside the entry's own inputs that still decides what esbuild emits. */
function runtimeContext(): Record<string, unknown> {
  return {
    version: CACHE_VERSION,
    projectRoot,
    runtime: `${process.version}/${process.platform}/${process.arch}/esbuild-${esbuildVersion}`,
    config: CONFIG_FILES.map((path) => [
      path,
      existsSync(join(projectRoot, path)) ? fileDigest(join(projectRoot, path)) : null
    ])
  }
}

/** Digest of every source file: a conservative key for bundles of the product itself. */
function sourceTreeDigest(): string {
  const hash = createHash('sha256')
  for (const root of SOURCE_ROOTS) {
    for (const path of filesUnder(join(projectRoot, root))) {
      hash.update(relative(projectRoot, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  return hash.digest('hex')
}

let cacheRootPath: string | undefined
function cacheRoot(): string {
  if (cacheRootPath) return cacheRootPath
  const root = join(realpathSync(tmpdir()), 'mousse-test-builds')
  mkdirSync(root, { recursive: true })
  // Bundles keep runtime dependencies external, so they resolve from the real installation.
  const modules = join(root, 'node_modules')
  if (!existsSync(modules)) {
    try {
      symlinkSync(realpathSync(join(projectRoot, 'node_modules')), modules, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const manifest = join(root, 'package.json')
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ type: 'module' }) + '\n')
  cacheRootPath = root
  return root
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A directory lock shared by every test worker; a dead holder's lock is reclaimed. */
async function withLock<T>(path: string, work: () => Promise<T>, timeoutMs = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(path)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let stale = false
      try {
        const holder = Number(readFileSync(join(path, 'pid'), 'utf8'))
        const age = Date.now() - statSync(path).mtimeMs
        stale = (Number.isInteger(holder) && !processAlive(holder)) || age > timeoutMs
      } catch {
        // The holder has not written its pid yet or has just released the lock.
        stale = Date.now() - statSync(path, { throwIfNoEntry: false })?.mtimeMs! > 5_000
      }
      if (stale) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the shared test build lock at ${path}`)
      await sleep(100)
    }
  }
  try {
    writeFileSync(join(path, 'pid'), String(process.pid))
    return await work()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}

/** Remove published artifacts of other source states that no run has touched for a day. */
function pruneStale(root: string, keep: string, prefix: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || entry.name === keep || entry.name.endsWith('.lock')) continue
    const path = join(root, entry.name)
    try {
      if (Date.now() - statSync(path).mtimeMs > 24 * 60 * 60_000) rmSync(path, { recursive: true, force: true })
    } catch {
      // Another run may be pruning the same directory.
    }
  }
}

function publish(temporary: string, destination: string): void {
  if (existsSync(destination)) {
    rmSync(temporary, { recursive: true, force: true })
    return
  }
  renameSync(temporary, destination)
}

export interface ProductBuild {
  /** Directory holding `cli/`, `browser-worker/` and, when requested, `net-native/`. */
  readonly out: string
  /** The bundled CLI and daemon entry. */
  readonly entry: string
  /** The bundled managed browser worker. */
  readonly browserWorker: string
  /** Bundle another entry with the product's CLI build options into `out/<relativeOutput>`. */
  buildEntry(source: string, relativeOutput: string): Promise<string>
}

/**
 * The real CLI, daemon and browser worker bundles for the current source tree, built once.
 * Nothing here reads or writes the checkout's `out` directory, so a stale local build cannot
 * leak into a test and a test cannot clobber a developer's build.
 */
export async function productBuild(options: { nativeReader?: boolean } = {}): Promise<ProductBuild> {
  const root = cacheRoot()
  const key = sha256(JSON.stringify({ ...runtimeContext(), sources: sourceTreeDigest(), nativeReader: options.nativeReader === true })).slice(0, 20)
  const name = `product-${key}`
  const directory = join(root, name)
  const out = join(directory, 'out')
  const entry = join(out, 'cli', 'index.js')
  const browserWorker = join(out, 'browser-worker', 'index.mjs')
  if (!existsSync(join(directory, 'manifest.json'))) {
    await withLock(join(root, `${name}.lock`), async () => {
      if (existsSync(join(directory, 'manifest.json'))) return
      const temporary = join(root, `${name}.building-${process.pid}`)
      rmSync(temporary, { recursive: true, force: true })
      mkdirSync(join(temporary, 'out'), { recursive: true })
      try {
        const cliOptions = getCliBuildOptions(projectRoot) as BuildOptions
        await build({
          ...cliOptions,
          absWorkingDir: projectRoot,
          outfile: join(temporary, 'out', 'cli', 'index.js'),
          sourcemap: false,
          logLevel: 'silent'
        })
        await build({
          ...(getBrowserWorkerBuildOptions(projectRoot) as BuildOptions),
          absWorkingDir: projectRoot,
          outfile: join(temporary, 'out', 'browser-worker', 'index.mjs'),
          sourcemap: false,
          logLevel: 'silent'
        })
        if (options.nativeReader) buildPackagedNativeReader(join(temporary, 'out'))
        writeFileSync(join(temporary, 'manifest.json'), JSON.stringify({ key, builtAt: new Date().toISOString(), nativeReader: options.nativeReader === true }))
        publish(temporary, directory)
      } catch (error) {
        rmSync(temporary, { recursive: true, force: true })
        throw error
      }
    })
    pruneStale(root, name, 'product-')
  }
  return {
    out,
    entry,
    browserWorker,
    buildEntry: (source, relativeOutput) => productEntry(root, name, source, relativeOutput)
  }
}

/**
 * An extra entry bundled with the CLI options into the product's own `out/` tree, so it can
 * resolve packaged neighbours (such as `../net-native`) exactly as the shipped CLI does.
 */
async function productEntry(root: string, productName: string, source: string, relativeOutput: string): Promise<string> {
  if (isAbsolute(relativeOutput)) throw new Error('buildEntry output must be relative to the product out directory')
  const directory = join(root, productName)
  const output = join(directory, 'out', relativeOutput)
  const inputsPath = `${output}.inputs.json`
  const entry = resolve(projectRoot, source)
  const current = (): string | undefined => {
    try {
      const recorded = JSON.parse(readFileSync(inputsPath, 'utf8')) as { inputs: Record<string, string> }
      if (!existsSync(output)) return undefined
      for (const [path, digest] of Object.entries(recorded.inputs)) {
        if (fileDigest(join(projectRoot, path)) !== digest) return undefined
      }
      return output
    } catch {
      return undefined
    }
  }
  const reused = current()
  if (reused) return reused
  return withLock(join(root, `${productName}.${basename(relativeOutput)}.lock`), async () => {
    const again = current()
    if (again) return again
    const temporary = `${output}.building-${process.pid}`
    const started = Date.now()
    mkdirSync(dirname(output), { recursive: true })
    const result = await build({
      ...(getCliBuildOptions(projectRoot) as BuildOptions),
      absWorkingDir: projectRoot,
      entryPoints: [entry],
      outfile: temporary,
      sourcemap: false,
      logLevel: 'silent',
      metafile: true
    })
    const inputs: Record<string, string> = {}
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = resolve(projectRoot, input)
      if (existsSync(path)) inputs[relative(projectRoot, path)] = fileDigest(path)
    }
    const consistent = Object.keys(inputs).every((path) => statSync(join(projectRoot, path)).mtimeMs < started)
    renameSync(temporary, output)
    if (consistent) writeFileSync(inputsPath, JSON.stringify({ inputs }))
    else rmSync(inputsPath, { force: true })
    return output
  })
}

/**
 * Bundle one entry (a crash child, a probe, a fixture daemon) with the given esbuild options and
 * return the path of the output. `outfile` is a file name, not a location: the artifact lives in
 * the shared cache and is rebuilt only when one of its recorded inputs changes.
 */
export async function sharedBuild(options: BuildOptions & { entryPoints: [string] | string[]; outfile: string }): Promise<string> {
  const root = cacheRoot()
  const { outfile, ...rest } = options
  if (isAbsolute(outfile)) throw new Error('sharedBuild outfile must be a relative file name inside the shared cache')
  const settings = { ...rest, entryPoints: options.entryPoints.map((entry) => resolve(projectRoot, entry)), plugins: rest.plugins?.map((plugin) => plugin.name) }
  const key = sha256(JSON.stringify({ ...runtimeContext(), settings, outfile })).slice(0, 20)
  const name = `entry-${key}`
  const directory = join(root, name)
  const inputsPath = join(directory, 'inputs.json')
  const current = (): string | undefined => {
    try {
      const recorded = JSON.parse(readFileSync(inputsPath, 'utf8')) as { inputs: Record<string, string>; output: string }
      const output = join(directory, recorded.output)
      if (!existsSync(output)) return undefined
      for (const [path, digest] of Object.entries(recorded.inputs)) {
        if (fileDigest(join(projectRoot, path)) !== digest) return undefined
      }
      return output
    } catch {
      return undefined
    }
  }
  const reused = current()
  if (reused) return reused
  return withLock(join(root, `${name}.lock`), async () => {
    const again = current()
    if (again) return again
    mkdirSync(directory, { recursive: true })
    const output = join(directory, outfile)
    const temporary = join(directory, `${basename(outfile)}.building-${process.pid}`)
    const started = Date.now()
    const result = await build({ ...rest, entryPoints: settings.entryPoints, absWorkingDir: projectRoot, outfile: temporary, metafile: true, logLevel: rest.logLevel ?? 'silent' })
    const inputs: Record<string, string> = {}
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = resolve(projectRoot, input)
      if (!existsSync(path)) continue
      inputs[relative(projectRoot, path)] = fileDigest(path)
    }
    // An input edited during compilation would certify a bundle nobody can reproduce.
    const consistent = Object.keys(inputs).every((path) => statSync(join(projectRoot, path)).mtimeMs < started)
    mkdirSync(dirname(output), { recursive: true })
    renameSync(temporary, output)
    for (const extra of readdirSync(directory)) {
      if (extra.startsWith(`${basename(outfile)}.building-`)) rmSync(join(directory, extra), { force: true })
    }
    if (consistent) writeFileSync(inputsPath, JSON.stringify({ inputs, output: relative(directory, output) }))
    else rmSync(inputsPath, { force: true })
    return output
  })
}

/** A child bundled exactly like the CLI (external packages, TypeScript package plugin), as an ES module. */
export function cliChild(entry: string, name: string): Promise<string> {
  return sharedBuild({
    ...(getCliBuildOptions(projectRoot) as BuildOptions),
    entryPoints: [resolve(projectRoot, entry)],
    outfile: name.endsWith('.mjs') ? name : `${name}.mjs`,
    sourcemap: false
  })
}

/** A Node crash child or probe bundled from `entry`; CommonJS by default so `require` and `__dirname` work as in the fixtures. */
export function crashChild(
  entry: string,
  options: Omit<BuildOptions, 'entryPoints' | 'outfile'> & { name?: string } = {}
): Promise<string> {
  const { name, ...rest } = options
  const format = rest.format ?? 'cjs'
  const extension = format === 'esm' ? '.mjs' : '.cjs'
  const file = `${name ?? basename(entry).replace(/\.[cm]?[jt]sx?$/, '')}${extension}`
  return sharedBuild({ bundle: true, platform: 'node', ...rest, format, entryPoints: [resolve(projectRoot, entry)], outfile: file })
}
