import { basename, extname } from 'node:path'
import type { InstanceBinary } from '../../shared/harness/status'
import { resolveNpm } from './agents/install'
import { cliLaunch, type CliLaunch } from './cliConfig'
import { resolveCommand, type InstanceEnv } from './env'
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
  const launch = own ?? (program === 'npm' ? resolveNpm(env, platform) : resolveCommand(program, env, platform))
  return launch ? { launch, args } : undefined
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
  binary: Pick<InstanceBinary, 'path'> | undefined
  env: InstanceEnv
  signal: AbortSignal
  onProgress: (message: string) => void
  timeoutMs?: number
}): Promise<void> {
  const resolved = ownerUpdateLaunch(input.command, input.binary, input.env)
  const program = input.command.trim().split(/\s+/)[0]
  if (!resolved) throw new Error(`Mousse could not find ${program} to update with. Run this in a terminal: ${input.command}`)
  input.onProgress(`Running ${input.command}`)
  const result = await runHarness(input.env, 'update', resolved.launch.command, [...resolved.launch.args, ...resolved.args], {
    timeoutMs: input.timeoutMs ?? OWNER_UPDATE_TIMEOUT_MS,
    signal: input.signal,
    maxBytes: 64 * 1024
  })
  if (result.spawnError === 'aborted') throw new Error('Update cancelled.')
  if (result.spawnError) throw new Error(`Could not start ${program}: ${result.spawnError}. Run this in a terminal: ${input.command}`)
  if (result.timedOut) throw new Error(`${input.command} did not finish in time. Run it in a terminal to see why.`)
  if (result.code !== 0) {
    const output = lastLines(result.stderr) || lastLines(result.stdout)
    throw new Error(`${input.command} failed (exit ${result.code})${output ? `: ${output}` : '.'}`)
  }
}
