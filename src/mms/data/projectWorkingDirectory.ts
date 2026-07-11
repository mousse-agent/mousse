import { homedir } from 'os'
import { resolve } from 'path'

let appliedPath: string | undefined

export function resolveProjectWorkingDirectory(projectPath?: string): string {
  return resolve(projectPath ?? homedir())
}

export function applyProjectWorkingDirectory(projectPath?: string): string {
  const target = resolveProjectWorkingDirectory(projectPath)
  if (appliedPath === target) return target

  try {
    process.chdir(target)
    appliedPath = target
  } catch (err) {
    console.warn(`[projectWorkingDirectory] Failed to chdir to ${target}:`, err)
  }

  return target
}

export function getAppliedProjectWorkingDirectory(): string | undefined {
  return appliedPath
}
