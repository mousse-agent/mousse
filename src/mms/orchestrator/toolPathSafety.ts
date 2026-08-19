import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Default Pi bash timeout when the model omits one (Pi itself has no default). */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120

/** Cap model-requested bash timeouts so a single tool call cannot run indefinitely. */
export const MAX_BASH_TIMEOUT_SECONDS = 300

/**
 * Convert Git Bash / MSYS absolute paths (/c/Users/...) and WSL (/mnt/c/...) paths
 * into native Windows paths. Non-Windows platforms leave input unchanged except for
 * trivial trimming.
 */
export function normalizeOsPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  if (process.platform === 'win32') {
    const gitBash = trimmed.match(/^\/([a-zA-Z])\/(.*)$/)
    if (gitBash) {
      const drive = gitBash[1]!.toUpperCase()
      const rest = (gitBash[2] ?? '').replace(/\//g, '\\')
      return `${drive}:\\${rest}`
    }

    const wsl = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/)
    if (wsl) {
      const drive = wsl[1]!.toUpperCase()
      const rest = (wsl[2] ?? '').replace(/\//g, '\\')
      return `${drive}:\\${rest}`
    }
  }

  return trimmed
}

export function resolveToolPath(filePath: string, cwd: string): string {
  const normalized = normalizeOsPath(filePath)
  const normalizedCwd = normalizeOsPath(cwd)
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizedCwd, normalized)
}

export function isPathInsideCwd(filePath: string, cwd: string): boolean {
  const resolvedCwd = resolve(normalizeOsPath(cwd))
  const resolvedPath = resolveToolPath(filePath, resolvedCwd)
  const rel = relative(resolvedCwd, resolvedPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Detect shell commands that search or traverse from a filesystem root.
 * These commonly hang for hours on Windows (e.g. `grep -rl foo /`, `find /`).
 */
export function isFilesystemWideBashCommand(command: string): boolean {
  const compact = command.replace(/\s+/g, ' ').trim()
  if (!compact) return false

  // find /  find /c/...  find C:\...
  if (/\bfind(?:\.exe)?\s+["']?\/(?!\.)/i.test(compact)) return true
  if (/\bfind(?:\.exe)?\s+["']?[a-zA-Z]:[\\/]/i.test(compact)) return true

  // grep/rg with a root path argument: " /" , " /c/...", or " C:\"
  if (/\b(?:grep|rg)(?:\.exe)?\b/i.test(compact)) {
    if (/(?:^|[\s])\/(?:[\s;|&]|$)/.test(compact)) return true
    if (/(?:^|[\s])\/[a-zA-Z](?:\/|[\s;|&]|$)/.test(compact)) return true
    if (/(?:^|[\s])[a-zA-Z]:\\?(?:[\s;|&]|$)/.test(compact)) return true
  }

  // Get-ChildItem C:\ -Recurse / Get-ChildItem / -Recurse
  if (
    /\bGet-ChildItem\b/i.test(compact) &&
    /-[rR]ecurse/i.test(compact) &&
    /\bGet-ChildItem\s+["']?(?:[a-zA-Z]:\\?|\/)["']?(?:\s|$)/i.test(compact)
  ) {
    return true
  }

  return false
}

export function clampBashTimeoutSeconds(timeout: unknown): number {
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
    return Math.min(Math.floor(timeout), MAX_BASH_TIMEOUT_SECONDS)
  }
  return DEFAULT_BASH_TIMEOUT_SECONDS
}

const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'directory', 'dir'] as const

/**
 * Normalize path-like tool arguments and optionally reject writes/edits outside cwd.
 */
export function sanitizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): { args: Record<string, unknown>; error?: string } {
  const next: Record<string, unknown> = { ...args }

  for (const key of PATH_ARG_KEYS) {
    if (typeof next[key] === 'string' && next[key]) {
      const original = String(next[key])
      const resolved = resolveToolPath(original, cwd)
      // Prefer cwd-relative paths when the target is inside the project.
      next[key] = isPathInsideCwd(resolved, cwd)
        ? relative(resolve(normalizeOsPath(cwd)), resolved) || '.'
        : resolved
    }
  }

  if (toolName === 'write' || toolName === 'edit') {
    const pathValue = typeof next.path === 'string' ? next.path : typeof next.file_path === 'string' ? next.file_path : ''
    if (pathValue && !isPathInsideCwd(pathValue, cwd)) {
      return {
        args: next,
        error: `Refusing ${toolName} outside the project/worktree cwd: ${pathValue}`
      }
    }
  }

  if (toolName === 'bash') {
    const command = typeof next.command === 'string' ? next.command : ''
    if (isFilesystemWideBashCommand(command)) {
      return {
        args: next,
        error:
          'Blocked filesystem-wide shell command. Search/list only inside the project/worktree ' +
          '(e.g. `find .`, `grep -R pattern .`). Root paths like `/` or `C:\\` are not allowed.'
      }
    }
    next.timeout = clampBashTimeoutSeconds(next.timeout)
  }

  return { args: next }
}
