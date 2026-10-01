import { zipSync, strToU8 } from 'fflate'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { toPosixRelative } from '../pathSafety'

export function exportSkillDirectory(rootPath: string, name: string): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  collect(rootPath, rootPath, files)
  if (Object.keys(files).length === 0) {
    throw new Error('Skill package has no files to export.')
  }
  return zipSync(files, { level: 6 })
}

export function exportSkillMarkdown(content: string): Uint8Array {
  return strToU8(content)
}

function collect(root: string, current: string, files: Record<string, Uint8Array>): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const entryPath = join(current, entry.name)
    if (entry.isDirectory()) {
      collect(root, entryPath, files)
      continue
    }
    if (!entry.isFile()) continue
    const rel = toPosixRelative(relative(root, entryPath))
    files[rel] = readFileSync(entryPath)
    void statSync(entryPath)
  }
}
