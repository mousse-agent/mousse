import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { mousseGitEnv } from './gitEnv'
import { assertGitAllowed, type UserAction } from './gitPolicy'
import { repoProgramEnv, withoutRepoProgramsAsync } from './repoPrograms'
import { gitEnvFor, gitFile } from './gitExecutable'
import { execFileGitAsync, withGitDiskAdmission } from './gitSpawn'

export interface ExecutableResult {
  stdout: string
  stderr: string
}

export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: {
    cwd?: string
    /** Added to the process environment. */ env?: Record<string, string>
    /** Longer than the default minute, for a download. */ timeoutMs?: number
    /** The user's request, for a command that changes something (a pull request, a branch on GitHub, a clone). */
    userRequested?: UserAction
  }
) => Promise<ExecutableResult>

/** Runs a program; `git` runs no program the repository configures (`repoPrograms`). */
export const execRunner: ExecutableRunner = async (executable, args, options) => {
  const cwd = options?.cwd ?? process.cwd()
  if (/^gh(\.exe)?$/i.test(basename(executable))) assertGitAllowed({ executable: 'gh', cwd, args, userRequested: options?.userRequested })
  const timeout = options?.timeoutMs ?? 60_000
  const maxBuffer = 1024 * 1024
  const env = { ...process.env, ...options?.env }
  if (executable === 'git') return withGitDiskAdmission(cwd, async () => {
    const argv = await withoutRepoProgramsAsync(cwd, args, { userRequested: options?.userRequested })
    return execFileGitAsync(gitFile(), argv, { cwd, env: gitEnvFor(repoProgramEnv(env)), windowsHide: true, timeout, maxBuffer })
  })
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options?.cwd,
        // `gh` runs Git itself (remotes, `pr checkout`), so its Git gets the same settings as Mousse's own.
        env: mousseGitEnv(env),
        windowsHide: true,
        encoding: 'utf8',
        timeout,
        maxBuffer
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr })
          reject(error)
          return
        }
        resolvePromise({ stdout, stderr })
      }
    )
  })
}

/**
 * Where gh is when it is not found by name: a packaged macOS app gets a minimal PATH, so Homebrew's gh is missed, and a
 * gh that winget just installed is not on the PATH Mousse started with.
 */
export function ghFallbackPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin' || platform === 'linux') return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh']
  if (platform !== 'win32') return []
  const folders = [env.ProgramFiles ?? 'C:\\Program Files', env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : null]
  return folders.flatMap((folder) => (folder ? [`${folder}\\GitHub CLI\\gh.exe`] : []))
}

export function createGhFallbackRunner(
  base: ExecutableRunner,
  platform: NodeJS.Platform = process.platform
): ExecutableRunner {
  const fallbacks = ghFallbackPaths(platform)
  let remembered: string | null = null
  return async (executable, args, options) => {
    if (executable !== 'gh') return base(executable, args, options)
    if (remembered) return base(remembered, args, options)
    try {
      return await base('gh', args, options)
    } catch (error) {
      if (!isMissingExecutable(error)) throw error
      for (const candidate of fallbacks) {
        try {
          const result = await base(candidate, args, options)
          remembered = candidate
          return result
        } catch (candidateError) {
          if (isMissingExecutable(candidateError)) continue
          remembered = candidate
          throw candidateError
        }
      }
      throw error
    }
  }
}

export const defaultRunner = createGhFallbackRunner(execRunner)

export function processMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const value = error as { stderr?: unknown; message?: unknown }
  const stderr = typeof value.stderr === 'string' ? value.stderr.trim() : ''
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  return stderr || message || 'Unknown command failure'
}

export function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT')
}

export type GhFailureKind = 'none' | 'not-github' | 'unauthenticated' | 'rate-limited' | 'not-found' | 'error'

/** Classifies a failed `gh` call by its error text. */
export function classifyGhFailure(message: string): GhFailureKind {
  const text = message.toLowerCase()
  if (text.includes('no pull requests found')) return 'none'
  if (text.includes('point to a known github host') || text.includes('not a github repository')) return 'not-github'
  // A rate-limit message can suggest signing in; the limit is what the caller must wait out.
  if (text.includes('rate limit')) return 'rate-limited'
  if (text.includes('gh auth login') || text.includes('not logged in')) return 'unauthenticated'
  if (text.includes('could not resolve to a pullrequest') || text.includes('http 404')) return 'not-found'
  return 'error'
}
