import { unzipSync } from 'fflate'
import { existsSync, lstatSync, readFileSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import { inspectRelativePath, toPosixRelative } from '../pathSafety'

export const MAX_ARCHIVE_COMPRESSED_BYTES = 8 * 1024 * 1024
export const MAX_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024
export const MAX_ARCHIVE_FILES = 256
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024

export interface ImportedSkillFile {
  relativePath: string
  bytes: Uint8Array
  executable: boolean
}

export interface ImportedSkillPackage {
  files: ImportedSkillFile[]
  skillMarkdown: string
  skillRelativePath: string
  expandedBytes: number
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.ps1',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.exe',
  '.bat',
  '.cmd'
])

export function importSkillZip(bytes: Uint8Array, zipName = 'upload.zip'): ImportedSkillPackage {
  if (bytes.byteLength > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error(
      `Skill archive exceeds compressed size limit (${MAX_ARCHIVE_COMPRESSED_BYTES} bytes).`
    )
  }

  let unzipped: Record<string, Uint8Array>
  let declaredExpandedBytes = 0
  let declaredEntries = 0
  const seen = new Map<string, string>()
  try {
    unzipped = unzipSync(bytes, {
      filter(entry) {
        declaredEntries += 1
        if (declaredEntries > MAX_ARCHIVE_FILES) {
          throw new Error(`Skill archive has too many entries (max ${MAX_ARCHIVE_FILES}).`)
        }
        const posix = entry.name.replace(/\\/g, '/')
        if (posix.endsWith('/')) return false
        const unsafe = inspectRelativePath(posix)
        if (unsafe) throw new Error(`Rejected ${zipName} entry "${entry.name}": ${unsafe.reason}`)
        const normalized = posix.replace(/^\.\//, '')
        const collisionKey = normalized.toLowerCase()
        if (seen.has(collisionKey)) {
          throw new Error(`Skill archive contains duplicate or case-colliding path "${normalized}".`)
        }
        seen.set(collisionKey, normalized)
        if (entry.originalSize > MAX_SKILL_FILE_BYTES) {
          throw new Error(`Skill archive file "${entry.name}" exceeds per-file size limit.`)
        }
        declaredExpandedBytes += entry.originalSize
        if (declaredExpandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
          throw new Error(`Skill archive exceeds expanded size limit (${MAX_ARCHIVE_EXPANDED_BYTES} bytes).`)
        }
        return true
      }
    })
  } catch (err) {
    throw new Error(`Skill archive could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }

  const entries = Object.entries(unzipped)
  if (entries.length > MAX_ARCHIVE_FILES) {
    throw new Error(`Skill archive has too many files (max ${MAX_ARCHIVE_FILES}).`)
  }

  let expandedBytes = 0
  const files: ImportedSkillFile[] = []
  for (const [rawPath, content] of entries) {
    const posix = rawPath.replace(/\\/g, '/')
    if (posix.endsWith('/')) continue
    const unsafe = inspectRelativePath(posix)
    if (unsafe) {
      throw new Error(`Rejected ${zipName} entry "${rawPath}": ${unsafe.reason}`)
    }
    expandedBytes += content.byteLength
    if (content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill archive file "${rawPath}" exceeds per-file size limit.`)
    }
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`Skill archive exceeds expanded size limit (${MAX_ARCHIVE_EXPANDED_BYTES} bytes).`)
    }
    files.push({
      relativePath: posix.replace(/^\.\//, ''),
      bytes: content,
      executable: isExecutableName(posix)
    })
  }

  return finishPackage(files, expandedBytes)
}

export async function importSkillPath(sourcePath: string): Promise<ImportedSkillPackage> {
  const sourceStat = await stat(sourcePath)
  if (lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error('Symbolic links cannot be imported.')
  }

  if (sourceStat.isFile()) {
    const fileName = basename(sourcePath)
    if (fileName !== 'SKILL.md' && !fileName.toLowerCase().endsWith('.md')) {
      throw new Error('Single-file skill import requires a SKILL.md or markdown file.')
    }
    const bytes = await readFile(sourcePath)
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error('SKILL.md exceeds per-file size limit.')
    }
    return finishPackage(
      [{ relativePath: 'SKILL.md', bytes, executable: false }],
      bytes.byteLength
    )
  }

  if (!sourceStat.isDirectory()) {
    throw new Error('Skill import source must be a directory or SKILL.md file.')
  }

  const files: ImportedSkillFile[] = []
  let expandedBytes = 0
  await walkDir(sourcePath, sourcePath, files, () => {
    expandedBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
    if (files.length > MAX_ARCHIVE_FILES) {
      throw new Error(`Skill package has too many files (max ${MAX_ARCHIVE_FILES}).`)
    }
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`Skill package exceeds expanded size limit (${MAX_ARCHIVE_EXPANDED_BYTES} bytes).`)
    }
  })
  return finishPackage(files, expandedBytes)
}

async function walkDir(
  root: string,
  current: string,
  files: ImportedSkillFile[],
  onProgress: () => void
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(current, entry.name)
    if (entry.isSymbolicLink() || lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`Rejected symbolic link: ${toPosixRelative(relative(root, entryPath))}`)
    }
    const relativePath = toPosixRelative(relative(root, entryPath))
    const unsafe = inspectRelativePath(relativePath)
    if (unsafe) throw new Error(`Rejected path "${relativePath}": ${unsafe.reason}`)
    if (entry.isDirectory()) {
      await walkDir(root, entryPath, files, onProgress)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Rejected special file: ${relativePath}`)
    }
    const bytes = readFileSync(entryPath)
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill file "${relativePath}" exceeds per-file size limit.`)
    }
    files.push({
      relativePath,
      bytes,
      executable: isExecutableName(relativePath)
    })
    onProgress()
  }
}

function finishPackage(files: ImportedSkillFile[], expandedBytes: number): ImportedSkillPackage {
  const skillEntry = findSkillMarkdown(files)
  if (!skillEntry) {
    throw new Error('Imported package does not contain SKILL.md.')
  }
  const prefix = dirname(skillEntry.relativePath)
  const normalized =
    prefix === '.'
      ? files
      : files.map((file) => ({
          ...file,
          relativePath:
            file.relativePath === skillEntry.relativePath
              ? 'SKILL.md'
              : toPosixRelative(relative(prefix, file.relativePath))
        }))
  return {
    files: normalized.filter((file) => file.relativePath && !file.relativePath.startsWith('..')),
    skillMarkdown: new TextDecoder().decode(skillEntry.bytes),
    skillRelativePath: 'SKILL.md',
    expandedBytes
  }
}

function findSkillMarkdown(files: ImportedSkillFile[]): ImportedSkillFile | undefined {
  const exact = files.find((file) => file.relativePath === 'SKILL.md')
  if (exact) return exact
  const nested = files.filter((file) => basename(file.relativePath) === 'SKILL.md')
  if (nested.length === 1) return nested[0]
  return undefined
}

function isExecutableName(path: string): boolean {
  const lower = path.toLowerCase()
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return /(^|\/)scripts\//.test(toPosixRelative(path))
}

export function packageHasExecutableAssets(files: ImportedSkillFile[]): boolean {
  return files.some((file) => file.executable)
}
