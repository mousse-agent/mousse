import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { InstanceBinary } from '../../shared/harness/status'
import { resolveNpm } from './agents/install'
import { cliLaunch, type CliLaunch } from './cliConfig'
import { resolveCommand, withEnforced, type InstanceEnv } from './env'
import { runHarness } from './spawn'

/** An update by the CLI's own installer can download a whole release; npm and brew may build. */
export const OWNER_UPDATE_TIMEOUT_MS = 10 * 60_000

/** The program name without a Windows extension (`claude.exe` -> `claude`). */
function stem(path: string): string {
  const name = basename(path)
  return /^\.(exe|cmd|bat)$/i.test(extname(name)) ? name.slice(0, -extname(name).length) : name
}

/**
 * How to run an owner's update command (`HarnessDriver.updateCommand`): a fixed command line of
 * plain words. Its first word naming the CLI itself (`claude update`) runs the very executable the
 * instance runs, never another copy found on PATH; npm runs the way Mousse runs npm elsewhere;
 * anything else (brew) is looked up on the instance's PATH.
 */
export function ownerUpdateLaunch(
  command: string,
  binary: Pick<InstanceBinary, 'path'> | undefined,
  env: Pick<InstanceEnv, 'env' | 'searchPath'>,
  platform: NodeJS.Platform = process.platform
): { launch: CliLaunch; args: string[] } | undefined {
  const [program, ...args] = command.trim().split(/\s+/)
  if (!program) return undefined
  const own = binary?.path && stem(binary.path).toLowerCase() === program.toLowerCase() ? cliLaunch(binary.path) : undefined
  if (!own && program === 'scoop' && platform === 'win32') {
    const scoop = scoopLaunch(binary?.path, env, platform)
    return scoop ? { launch: scoop, args } : undefined
  }
  const launch = own ?? (program === 'npm' ? resolveNpm(env, platform) : resolveCommand(program, env, platform))
  return launch ? { launch, args } : undefined
}

/**
 * Scoop's own script, run by PowerShell: `scoop.cmd` on PATH is no shim Mousse can read. Scoop's
 * folder is the one the executable sits in, else `SCOOP`, else `~/scoop`.
 */
function scoopLaunch(path: string | undefined, env: Pick<InstanceEnv, 'env' | 'searchPath'>, platform: NodeJS.Platform): CliLaunch | undefined {
  const fromPath = path ? /^(.*?[\\/]scoop)[\\/](?:shims|apps)[\\/]/i.exec(path)?.[1] : undefined
  const home = env.env.USERPROFILE ?? env.env.HOME
  const roots = [fromPath, env.env.SCOOP, home ? join(home, 'scoop') : undefined].filter((root): root is string => Boolean(root))
  const script = roots.map((root) => join(root, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1')).find((candidate) => existsSync(candidate))
  const powershell = script ? resolveCommand('powershell', env, platform) : undefined
  return script && powershell ? { ...powershell, args: [...powershell.args, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] } : undefined
}

/** The entry's environment with `overrides` set over it, also over the variables it enforces. */
export function withUpdateEnv(env: InstanceEnv, overrides: Record<string, string> | undefined): InstanceEnv {
  const names = Object.keys(overrides ?? {})
  if (!overrides || !names.length) return env
  const upper = new Set(names.map((name) => name.toUpperCase()))
  const enforced = env.enforced ? Object.fromEntries(Object.entries(env.enforced).filter(([name]) => !upper.has(name.toUpperCase()))) : undefined
  return { ...env, env: withEnforced(env.env, overrides), ...(enforced ? { enforced } : {}) }
}

/** WinGet's exit code when it has no newer version of the package yet (`APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE`). */
const WINGET_NO_UPGRADE = [0x8a15002b, 0x8a15002b - 0x1_0000_0000]

/** WinGet found no newer version, though Mousse's version check did: its package lags the release. */
export function wingetHasNoUpgrade(command: string, code: number | null, output: string): boolean {
  if (!/^winget\s/i.test(command.trim())) return false
  return (code !== null && WINGET_NO_UPGRADE.includes(code)) || /no (applicable|available) upgrade found|no newer package versions are available/i.test(output)
}

function lastLines(text: string, max = 600): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed
}

/**
 * Runs the owner's update command for an install Mousse did not make, and throws with what the
 * command printed when it fails. The caller checks the CLI again afterwards for its new version.
 */
export async function runOwnerUpdate(input: {
  command: string
  binary: Pick<InstanceBinary, 'path' | 'version'> | undefined
  env: InstanceEnv
  /** Variables the command needs over the entry's environment (`HarnessDriver.updateEnv`). */
  updateEnv?: Record<string, string>
  signal: AbortSignal
  onProgress: (message: string) => void
  timeoutMs?: number
}): Promise<void> {
  const env = withUpdateEnv(input.env, input.updateEnv)
  const resolved = ownerUpdateLaunch(input.command, input.binary, env)
  const program = input.command.trim().split(/\s+/)[0]
  if (!resolved) throw new Error(`Mousse could not find ${program} to update with. Run this in a terminal: ${input.command}`)
  input.onProgress(`Running ${input.command}`)
  const result = await runHarness(env, 'update', resolved.launch.command, [...resolved.launch.args, ...resolved.args], {
    timeoutMs: input.timeoutMs ?? OWNER_UPDATE_TIMEOUT_MS,
    signal: input.signal,
    maxBytes: 64 * 1024
  })
  if (result.spawnError === 'aborted') throw new Error('Update cancelled.')
  if (result.spawnError) throw new Error(`Could not start ${program}: ${result.spawnError}. Run this in a terminal: ${input.command}`)
  if (result.timedOut) throw new Error(`${input.command} did not finish in time. Run it in a terminal to see why.`)
  if (wingetHasNoUpgrade(input.command, result.code, `${result.stdout}\n${result.stderr}`))
    throw new Error(`WinGet has no version newer than ${input.binary?.version ?? 'this one'} yet. Try again later.`)
  if (result.code !== 0) {
    const output = lastLines(result.stderr) || lastLines(result.stdout)
    throw new Error(`${input.command} failed (exit ${result.code})${output ? `: ${output}` : '.'}`)
  }
}
