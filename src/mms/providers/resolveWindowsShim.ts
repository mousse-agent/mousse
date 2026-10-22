import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'

/** How Mousse starts a CLI: `command` with `args` before the CLI's own arguments. */
export type CliLaunch = {
  /** The program that runs: a native executable, or the JavaScript entry script `command` runs. */
  path: string
  command: string
  /** The entry script when node runs a JavaScript CLI; otherwise empty. */
  args: string[]
}

export type ShimOptions = {
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  /** Searched for `node.exe` when a JavaScript CLI's shim has none beside it. */
  env?: NodeJS.ProcessEnv
}

const MAX_SHIM_BYTES = 64 * 1024
const SCRIPT_SHIMS = new Set(['.cmd', '.bat', '.ps1'])
const JS = /\.(c|m)?js$/i
const TRIPLES: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc'
}

export const directLaunch = (path: string): CliLaunch => ({ path, command: path, args: [] })

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A Windows program file (PE image, starting `MZ`), not a placeholder left by a skipped install script. */
function isProgram(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(2)
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === 'MZ'
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readSmall(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(MAX_SHIM_BYTES + 1)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return length > MAX_SHIM_BYTES ? undefined : buffer.subarray(0, length).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The file a package-manager shim runs, relative to the shim's directory. npm, pnpm and yarn
 * write `"%dp0%\…"` / `"%~dp0\…"` in `.cmd` shims and `"$basedir/…"` in shell and PowerShell
 * shims; the node runtime they may also name (`node.exe`, `node$exe`) is not the target.
 */
export function shimTarget(text: string): string | undefined {
  const targets = [...text.matchAll(/"(?:%~?dp0%?|\$basedir)[\\/]([^"%$*]+)"/gi)]
    .map((match) => match[1].trim())
    .filter((target) => !/^node(\.exe)?$/i.test(target))
  return targets.at(-1)
}

function packageRoot(entry: string): { root: string; manifest: Record<string, unknown> } | undefined {
  for (let dir = dirname(entry); dir !== dirname(dir) && basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    const text = readSmall(join(dir, 'package.json'))
    if (text === undefined) continue
    try {
      const manifest: unknown = JSON.parse(text)
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest))
        return { root: dir, manifest: manifest as Record<string, unknown> }
    } catch {
      /* not a package root */
    }
    return undefined
  }
  return undefined
}

/** Where Node would find `name` from `root`: its own node_modules, then each ancestor's. */
function installedPackage(root: string, name: string): string | undefined {
  for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (isFile(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * The native program a package's launcher would start: shipped in the package itself or in its
 * Windows optional dependency, such as Codex's `@openai/codex-win32-x64` with
 * `vendor/x86_64-pc-windows-msvc/bin/codex.exe`, or `@anthropic-ai/claude-code-win32-x64/claude.exe`.
 */
function nativeExecutable(entry: string, bin: string, arch: NodeJS.Architecture): string | undefined {
  const pkg = packageRoot(entry)
  if (!pkg) return undefined
  const dirs = [pkg.root]
  const optional = pkg.manifest.optionalDependencies
  if (optional && typeof optional === 'object')
    for (const name of Object.keys(optional))
      if (new RegExp(`(^|[-_/])win(32)?[-_]${arch}($|[-_])`, 'i').test(name)) {
        const dir = installedPackage(pkg.root, name)
        if (dir) dirs.push(dir)
      }
  const triple = TRIPLES[arch]
  const file = `${bin}.exe`
  for (const dir of dirs) {
    const candidates = [join(dir, file), join(dir, 'bin', file)]
    if (triple) candidates.push(join(dir, 'vendor', triple, 'bin', file), join(dir, 'vendor', triple, bin, file))
    const found = candidates.find(isProgram)
    if (found) return found
  }
  return undefined
}

function findNode(shimDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const beside = join(shimDir, 'node.exe')
  if (isFile(beside)) return beside
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  for (const dir of (pathKey ? env[pathKey] ?? '' : '').split(delimiter)) {
    if (!dir) continue
    const candidate = resolve(dir, 'node.exe')
    if (isFile(candidate)) return candidate
  }
  return undefined
}

function resolveShim(shim: string, options: Required<ShimOptions>): CliLaunch | undefined {
  const text = readSmall(shim)
  const relative = text === undefined ? undefined : shimTarget(text)
  if (!relative) return undefined
  const shimDir = dirname(shim)
  const target = resolve(shimDir, ...relative.split(/[\\/]+/))
  if (!isFile(target)) return undefined
  const program = /\.(exe|com)$/i.test(target)
  if (program && isProgram(target)) return directLaunch(target)
  if (!program && !JS.test(target)) return undefined
  // A JavaScript launcher, or a placeholder `.exe` whose install script never ran (Claude Code
  // with `ignore-scripts`): use the native program the package ships for this platform.
  const native = nativeExecutable(target, basename(shim, extname(shim)), options.arch)
  if (native) return directLaunch(native)
  if (program) return undefined
  const node = findNode(shimDir, options.env)
  return node ? { path: target, command: node, args: [target] } : undefined
}

/**
 * How to start the CLI at `path`. Node can't spawn `.cmd`/`.bat` files without a shell, so on
 * Windows a package-manager shim (`codex.cmd`, `claude.cmd`, or the extensionless and `.ps1`
 * shims beside them) resolves to the program it runs: the package's native `.exe` when it ships
 * one, otherwise node with the JavaScript entry script. Returns undefined for a script shim it
 * can't read. Other files, and every path on other platforms, start as they are.
 */
export function resolveWindowsShim(path: string, options: ShimOptions = {}): CliLaunch | undefined {
  const resolved: Required<ShimOptions> = {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    env: options.env ?? process.env
  }
  if (resolved.platform !== 'win32') return directLaunch(path)
  const extension = extname(path).toLowerCase()
  if (SCRIPT_SHIMS.has(extension)) return resolveShim(path, resolved)
  // An extensionless file is either npm's shell shim or a program to start as before.
  if (extension === '') return resolveShim(path, resolved) ?? directLaunch(path)
  return directLaunch(path)
}

/** Whether `path` is a Windows script shim that only starts once resolved. */
export const isWindowsScriptShim = (path: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' && SCRIPT_SHIMS.has(extname(path).toLowerCase())
