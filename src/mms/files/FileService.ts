import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { join, relative } from 'path'
import type { FileEntry, FileStat } from '../../shared/types'
import { countLineEdits } from '../../shared/lineEditStats'
import { resolveWithinRoot, SKIP_DIR_NAMES } from './pathGuard'

const MAX_READ_BYTES = 512 * 1024

export class FileService {
  async listDir(root: string, dirPath = ''): Promise<FileEntry[]> {
    const absDir = resolveWithinRoot(root, dirPath)
    const entries = await readdir(absDir, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue
      const rel = relative(root, join(absDir, entry.name)).replace(/\\/g, '/')
      result.push({
        name: entry.name,
        path: rel,
        kind: entry.isDirectory() ? 'directory' : 'file'
      })
    }

    result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return result
  }

  async readFile(root: string, filePath: string): Promise<string> {
    const absPath = resolveWithinRoot(root, filePath)
    const info = await stat(absPath)
    if (!info.isFile()) throw new Error('Not a file')
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`File exceeds ${MAX_READ_BYTES / 1024}KB limit`)
    }
    return readFile(absPath, 'utf8')
  }

  async writeFile(root: string, filePath: string, content: string): Promise<number> {
    const absPath = resolveWithinRoot(root, filePath)
    let oldContent = ''
    try {
      const info = await stat(absPath)
      if (info.isFile()) {
        oldContent = await readFile(absPath, 'utf8')
      }
    } catch {
      // new file
    }
    await writeFile(absPath, content, 'utf8')
    return countLineEdits(oldContent, content)
  }

  async stat(root: string, targetPath: string): Promise<FileStat> {
    const absPath = resolveWithinRoot(root, targetPath)
    const info = await stat(absPath)
    return {
      path: relative(root, absPath).replace(/\\/g, '/'),
      kind: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    }
  }
}
