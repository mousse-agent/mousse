import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { atomicWriteJsonSync } from '../../data/AtomicFs'

/**
 * Pi's private `settings.json` in the instance's agent dir, written by Mousse before every start.
 * Mousse owns that directory: it holds only files Mousse writes (`settings.json`, the sessions it
 * asked for, the `auth.json` 2c's broker writes) and never a `models.json`.
 */

/**
 * Pi's own retry of a failed model request (PR 2 v4 change 1): transient request retries belong to
 * the runtime, and Mousse configures them. Pi waits `baseDelayMs × 2^(n−1)` before retry `n`, so the
 * worst case per request is 1.6 + 3.2 + 6.4 + 12.8 + 25.6 = 49.6 s, no worse than the legacy loop's
 * 5 × 10 s. SDK retries stay off (`provider.maxRetries: 0`; the guard also forces it per request),
 * so every retry passes the request guard again.
 */
export const PI_RETRY_SETTINGS = Object.freeze({ enabled: true, maxRetries: 5, baseDelayMs: 1600, provider: Object.freeze({ maxRetries: 0 }) })

/** The longest Pi waits between attempts of one request under `retry`. */
export function worstCaseBackoffMs(retry: { maxRetries: number; baseDelayMs: number } = PI_RETRY_SETTINGS): number {
  let total = 0
  for (let attempt = 1; attempt <= retry.maxRetries; attempt += 1) total += retry.baseDelayMs * 2 ** (attempt - 1)
  return total
}

export interface PiSettingsInput {
  /** The shell Pi's `bash` tool runs (Windows: Git Bash). */
  shellPath?: string
  /** Mirrors Mousse's own compaction setting (overflow compaction stays on either way). */
  compaction?: boolean
  /** Test seam: other retry values (shorter delays). */
  retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number; provider: { maxRetries: number } }
}

/** The settings Mousse gives Pi. */
export function piSettings(input: PiSettingsInput = {}): Record<string, unknown> {
  return {
    // Project-local settings, extensions and skills never load (`--no-approve` too).
    defaultProjectTrust: 'never',
    retry: input.retry ?? PI_RETRY_SETTINGS,
    compaction: { enabled: input.compaction ?? true },
    // Pi 1.x would otherwise send extra requests to keep a prompt cache warm during long tool runs:
    // spend no one asked for. Every request Pi makes is one Mousse's turn asked for.
    cacheWarming: 'off',
    ...(input.shellPath ? { shellPath: input.shellPath } : {})
  }
}

/** Files Mousse writes in Pi's agent dir; anything else found there is removed before a start. */
const MOUSSE_FILES = new Set(['settings.json', 'auth.json'])

/**
 * Writes `settings.json` into the agent dir and removes anything Mousse did not write there (a
 * `models.json`, extensions, skills, a `trust.json` from an earlier version). Sessions live in the
 * state dir, outside the agent dir.
 */
export function preparePiHome(home: string, input: PiSettingsInput = {}): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(home)) if (!MOUSSE_FILES.has(entry)) rmSync(join(home, entry), { recursive: true, force: true })
  atomicWriteJsonSync(join(home, 'settings.json'), piSettings(input), { mode: 0o600 })
}

/** Git for Windows' bash under one install root. */
function gitBashUnder(root: string | undefined): string | undefined {
  return root ? win32.join(root, 'Git', 'bin', 'bash.exe') : undefined
}

/**
 * The Git Bash Pi's `bash` tool should run on Windows, or undefined elsewhere (Pi's own lookup is
 * right there). Pi looks only under `%ProgramFiles%` before PATH, where `bash.exe` may be WSL's
 * (`System32\bash.exe`); Mousse also finds a per-user install and the bash beside `git.exe` on
 * PATH, and never picks WSL's.
 */
export function piShellPath(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const read = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
  const candidates = [
    gitBashUnder(read('ProgramFiles')),
    gitBashUnder(read('ProgramFiles(x86)')),
    gitBashUnder(read('ProgramW6432')),
    read('LOCALAPPDATA') ? win32.join(read('LOCALAPPDATA')!, 'Programs', 'Git', 'bin', 'bash.exe') : undefined
  ]
  // `git.exe` lives in `<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin`; bash is `<root>\bin\bash.exe`.
  for (const entry of (read('PATH') ?? '').split(win32.delimiter).filter(Boolean)) {
    if (!exists(win32.join(entry, 'git.exe'))) continue
    const parent = win32.dirname(entry)
    candidates.push(win32.join(parent, 'bin', 'bash.exe'), win32.join(win32.dirname(parent), 'bin', 'bash.exe'))
  }
  const wsl = /\\windows\\(?:system32|sysnative)\\bash\.exe$/i
  return candidates.find((candidate): candidate is string => Boolean(candidate) && !wsl.test(candidate!) && exists(candidate!))
}
