import { execFile } from 'node:child_process'
import { basename, delimiter } from 'node:path'

/**
 * The PATH a terminal would have. Apps started from a desktop launcher inherit a short PATH (no
 * shell profile ran), so a CLI installed by a version manager or a package manager's global bin is
 * invisible to them. The login shell is asked once per daemon, asynchronously, and the answer is
 * used to find executables; it never replaces the environment a turn already runs with.
 */

export const SHELL_PATH_TIMEOUT_MS = 15_000
const MARK = '__MOUSSE_PATH__'

export interface ShellPathResult {
  /** The captured PATH entries; empty when the capture failed. */
  entries: string[]
  /** How it was captured, or why it failed (logged, never shown as an error). */
  source: 'login_shell' | 'windows_registry' | 'failed'
  error?: string
}

/** Runs one capture command; resolves with stdout or rejects. */
export type ShellRunner = (command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<string>

const runCommand: ShellRunner = (command, args, { timeoutMs, env }) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
    ).stdin?.end()
  })

/** The command that prints PATH between markers for `shell`, by shell family. */
export function shellPathCommand(shell: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    // Machine and user PATH as stored now, so a CLI installed after Mousse started is found.
    const script = `[Console]::Out.Write('${MARK}' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + '${MARK}')`
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] }
  }
  const name = basename(shell)
  if (name === 'fish') return { command: shell, args: ['-l', '-c', `printf '%s' '${MARK}'(string join : $PATH)'${MARK}'`] }
  // POSIX shells read their login profile with -l; -i also reads the rc file version managers edit.
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh'].includes(name))
    return { command: shell, args: ['-ilc', `printf '%s' "${MARK}$PATH${MARK}"`] }
  // Non-POSIX shells (nu, xonsh, elvish, pwsh): a POSIX login shell still reads /etc/profile.
  return { command: '/bin/sh', args: ['-lc', `printf '%s' "${MARK}$PATH${MARK}"`] }
}

/** The PATH between the markers, split and de-duplicated; empty when there is none. */
export function parseShellPath(output: string, platform: NodeJS.Platform): string[] {
  const start = output.indexOf(MARK)
  const end = output.indexOf(MARK, start + MARK.length)
  if (start < 0 || end < 0) return []
  const entries = output
    .slice(start + MARK.length, end)
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...new Set(entries)]
}

/** `entries` after the inherited PATH entries, without repeats: inherited ones win. */
export function mergePath(inherited: string | undefined, entries: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const own = (inherited ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  return [...new Set([...own, ...entries])]
}

/**
 * Captures the login-shell PATH: 15 s per attempt, one retry. An empty answer counts as a failure
 * and is logged; callers then search only the inherited PATH.
 */
export async function captureShellPath(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  run?: ShellRunner
  log?: (message: string, details: Record<string, unknown>) => void
} = {}): Promise<ShellPathResult> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const { command, args } = shellPathCommand(shell, platform)
  const run = options.run ?? runCommand
  const log = options.log ?? ((message, details) => console.warn(message, details))
  let lastError = 'empty PATH'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const entries = parseShellPath(await run(command, args, { timeoutMs: options.timeoutMs ?? SHELL_PATH_TIMEOUT_MS, env }), platform)
      if (entries.length > 0) return { entries, source: platform === 'win32' ? 'windows_registry' : 'login_shell' }
      lastError = 'empty PATH'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  log('[harness] login shell PATH capture failed; searching the inherited PATH only', { shell: command, error: lastError })
  return { entries: [], source: 'failed', error: lastError }
}

let shared: Promise<ShellPathResult> | undefined

/** One capture per daemon, started on first use (at boot by the gateway). */
export function sharedShellPath(): Promise<ShellPathResult> {
  shared ??= captureShellPath()
  return shared
}

/** Test seam: forget the shared capture, or install a fixed one. */
export function setSharedShellPath(result: ShellPathResult | undefined): void {
  shared = result ? Promise.resolve(result) : undefined
}
