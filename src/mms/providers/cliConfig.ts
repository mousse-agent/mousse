import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CliProviderConfigPatch } from '../../shared/providerAuth'
import { isWindowsScriptShim, resolveWindowsShim, type CliLaunch } from './resolveWindowsShim'

export type { CliLaunch } from './resolveWindowsShim'

/** The user's CLI launch settings, as an instance's config keeps them (`InstanceConfig`). */
export type StoredCliConfig = {
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_PATH = 4096
const MAX_ARGS = 128
const MAX_ARG = 8192
const MAX_ENV = 256
const MAX_ENV_VALUE = 32_768
export const CLI_VERSION_TIMEOUT_MS = 3_000

function noNul(value: string, label: string): string {
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL characters`)
  return value
}

/** Validates an untrusted `providers.setCliConfig` patch; absent fields stay unchanged. */
export function parseCliConfigPatch(value: unknown): CliProviderConfigPatch {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  const input = value as Record<string, unknown>
  const patch: CliProviderConfigPatch = {}
  if (input.binaryPath !== undefined) {
    if (input.binaryPath === null) patch.binaryPath = null
    else if (typeof input.binaryPath !== 'string') throw new Error('binaryPath must be a string or null')
    else {
      const trimmed = input.binaryPath.trim()
      if (trimmed.length > MAX_PATH) throw new Error('binaryPath is too long')
      patch.binaryPath = trimmed ? noNul(trimmed, 'binaryPath') : null
    }
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args)) throw new Error('args must be an array of strings')
    if (input.args.length > MAX_ARGS) throw new Error(`args accepts at most ${MAX_ARGS} entries`)
    patch.args = input.args.map((arg, index) => {
      if (typeof arg !== 'string') throw new Error(`args[${index}] must be a string`)
      if (arg.length > MAX_ARG) throw new Error(`args[${index}] is too long`)
      return noNul(arg, `args[${index}]`)
    })
  }
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env))
      throw new Error('env must be an object of string values')
    const entries = Object.entries(input.env as Record<string, unknown>)
    if (entries.length > MAX_ENV) throw new Error(`env accepts at most ${MAX_ENV} variables`)
    const env: Record<string, string> = {}
    for (const [key, entry] of entries) {
      if (!ENV_KEY.test(key)) throw new Error(`env name ${JSON.stringify(key)} must match [A-Za-z_][A-Za-z0-9_]*`)
      if (typeof entry !== 'string') throw new Error(`env ${key} must be a string`)
      if (entry.length > MAX_ENV_VALUE) throw new Error(`env ${key} is too long`)
      env[key] = noNul(entry, `env ${key}`)
    }
    patch.env = env
  }
  return patch
}

/** The stored args, ignoring anything a hand-edited `settings.json` put there that is not a string. */
export function storedCliArgs(stored: StoredCliConfig): string[] {
  return Array.isArray(stored.args) ? stored.args.filter((arg): arg is string => typeof arg === 'string') : []
}

export function storedCliEnv(stored: StoredCliConfig): Record<string, string> {
  const env = stored.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  return Object.fromEntries(
    Object.entries(env).filter(([key, entry]) => ENV_KEY.test(key) && typeof entry === 'string')
  )
}

/**
 * An absolute path to an existing executable file, returned as chosen. Node can't start Windows
 * `.cmd`/`.bat` scripts without a shell, so a package-manager shim (such as npm's `codex.cmd`) is
 * accepted only when it resolves to the program it runs (see `resolveWindowsShim`).
 */
export function requireExecutable(path: string, label: string, platform: NodeJS.Platform = process.platform): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`)
  try {
    if (!statSync(path).isFile()) throw new Error('not a file')
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`${label} executable not found or not executable: ${path}`)
  }
  if (isWindowsScriptShim(path, platform) && !resolveWindowsShim(path, { platform }))
    throw new Error(`${label} can't start from this .cmd or .bat script. Choose the program (.exe) it runs instead.`)
  return path
}

/** How to start a stored or detected executable path; undefined when it can't start. */
export function cliLaunch(path: string | undefined): CliLaunch | undefined {
  if (!path || !isAbsolute(path)) return undefined
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return undefined
  }
  return resolveWindowsShim(path)
}

/**
 * The user's variables over Mousse's environment. Windows names are case-insensitive, so a user
 * `PATH` replaces an inherited `Path` instead of sitting beside it.
 */
export function withUserEnv(
  base: NodeJS.ProcessEnv,
  user: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = { ...base }
  if (platform === 'win32') {
    const names = new Set(Object.keys(user).map((key) => key.toUpperCase()))
    for (const key of Object.keys(env)) if (names.has(key.toUpperCase())) delete env[key]
  }
  return Object.assign(env, user)
}

/**
 * Converts launch args to the Agent SDK's `extraArgs` (`--name value` / `--name` flags). The SDK
 * only passes long options, so positional values and short flags are rejected.
 */
export function claudeExtraArgs(args: string[]): Record<string, string | null> {
  const extra: Record<string, string | null> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const match = /^--([A-Za-z0-9][A-Za-z0-9-]*)(?:=([\s\S]*))?$/.exec(arg)
    if (!match)
      throw new Error(
        `Claude Code launch argument ${JSON.stringify(arg)} is not supported. Use long options such as --name, --name=value or --name value.`
      )
    const name = match[1]
    if (Object.hasOwn(extra, name)) throw new Error(`Claude Code launch argument --${name} is repeated`)
    if (match[2] !== undefined) extra[name] = match[2]
    else if (index + 1 < args.length && !args[index + 1].startsWith('-')) extra[name] = args[++index]
    else extra[name] = null
  }
  return extra
}

export function parseCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(output)?.[1]
}

export type VersionRunner = (launch: CliLaunch, env: NodeJS.ProcessEnv) => Promise<string>

const runVersion: VersionRunner = (launch, env) =>
  new Promise((resolveOutput, reject) => {
    let settled = false
    const finish = (error: Error | null, stdout = '') => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      if (error) reject(error)
      else resolveOutput(stdout)
    }
    // `timeout` kills the child; the guard also covers grandchildren that keep the pipes open.
    const guard = setTimeout(() => finish(new Error('version check timed out')), CLI_VERSION_TIMEOUT_MS + 500)
    guard.unref?.()
    try {
      const child = execFile(
        launch.command,
        [...launch.args, '--version'],
        { env, timeout: CLI_VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout, stderr) => finish(error, `${stdout}\n${stderr}`)
      )
      child.stdin?.end()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })

/**
 * `<binary> --version` run the way the CLI launches (a resolved shim runs its target), cached per
 * program file (path, size and modification time).
 */
export class CliVersionCache {
  private readonly cache = new Map<string, Promise<string | undefined>>()
  constructor(private readonly run: VersionRunner = runVersion) {}

  version(launch: CliLaunch | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    if (!launch) return Promise.resolve(undefined)
    let key: string
    try {
      const stat = statSync(launch.path)
      key = `${launch.command}\0${launch.path}\0${stat.size}\0${stat.mtimeMs}`
    } catch {
      return Promise.resolve(undefined)
    }
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.run(launch, env).then(parseCliVersion, () => undefined)
      this.cache.set(key, pending)
    }
    return pending
  }
}

/** Shared across profiles: the same executable reports the same version. */
export const sharedCliVersions = new CliVersionCache()
