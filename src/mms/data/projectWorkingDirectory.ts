import { homedir } from 'os'
import { resolve } from 'path'

/**
 * Last resolved project path for the GUI bound thread.
 * Intentionally does NOT call process.chdir — per-turn / concurrent threads must pass
 * explicit cwd into tools and providers instead of relying on process global state.
 */
let appliedPath: string | undefined

export function resolveProjectWorkingDirectory(projectPath?: string): string {
  return resolve(projectPath ?? homedir())
}

/**
 * Record the project working directory for the active UI thread.
 * Does not mutate process.cwd() (unsafe under concurrent thread turns).
 */
export function applyProjectWorkingDirectory(projectPath?: string): string {
  const target = resolveProjectWorkingDirectory(projectPath)
  appliedPath = target
  return target
}

export function getAppliedProjectWorkingDirectory(): string | undefined {
  return appliedPath
}
