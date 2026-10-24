import { execFile } from 'node:child_process'
import { hostname as osHostname } from 'node:os'

/** The Mousse ID service accepts device names of up to 64 characters. */
const MAX_NAME_LENGTH = 64
const LOOKUP_TIMEOUT_MS = 1500

export interface ComputerNameDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  hostname: () => string
  /** Runs a program and returns its standard output. */
  run: (file: string, args: string[]) => Promise<string>
}

function clean(value: string | null | undefined): string {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, MAX_NAME_LENGTH).join('').trim()
}

/** A network hostname without the ".local" suffix macOS adds for Bonjour. */
export function stripLocalSuffix(hostname: string): string {
  return hostname.trim().replace(/\.local\.?$/i, '')
}

/**
 * The name a person gave this computer. `lookup` is what the system reports as
 * the user-facing name (macOS ComputerName, Linux pretty hostname); the network
 * hostname is the fallback everywhere.
 */
export function chooseComputerName(input: {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  hostname: string
  lookup?: string | null
}): string {
  const fromSystem = input.platform === 'win32' ? clean(input.env.COMPUTERNAME) : clean(input.lookup)
  return fromSystem || clean(stripLocalSuffix(input.hostname))
}

/** Reads the computer name. Lookup failures and timeouts fall back to the hostname. */
export async function resolveComputerName(deps: ComputerNameDeps): Promise<string> {
  let lookup: string | undefined
  try {
    if (deps.platform === 'darwin') lookup = await deps.run('scutil', ['--get', 'ComputerName'])
    else if (deps.platform === 'linux') lookup = await deps.run('hostnamectl', ['--pretty'])
  } catch {
    lookup = undefined
  }
  return chooseComputerName({ platform: deps.platform, env: deps.env, hostname: deps.hostname(), lookup })
}

const systemDeps: ComputerNameDeps = {
  platform: process.platform,
  env: process.env,
  hostname: osHostname,
  run: (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

let cached: Promise<string> | undefined

/** The computer name, looked up once. Call early so later callers get the cached answer. */
export function getComputerName(): Promise<string> {
  cached ??= resolveComputerName(systemDeps)
  return cached
}
