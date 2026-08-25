import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { join, relative } from 'path'
import type { FileAsset, FileEntry, FileStat } from '../../shared/types'
import { countLineEdits } from '../../shared/lineEditStats'
import { resolveWithinRoot, SKIP_DIR_NAMES } from './pathGuard'

const MAX_READ_BYTES = 512 * 1024
const MAX_ASSET_BYTES = 100 * 1024 * 1024

const ASSET_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', m4v: 'video/x-m4v'
}

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

  async readAsset(root: string, filePath: string): Promise<FileAsset> {
    const absPath = resolveWithinRoot(root, filePath)
    const info = await stat(absPath)
    if (!info.isFile()) throw new Error('Not a file')
    if (info.size > MAX_ASSET_BYTES) {
      throw new Error(`Preview exceeds ${MAX_ASSET_BYTES / 1024 / 1024}MB limit`)
    }
    const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = ASSET_MIME_TYPES[extension]
    if (!mimeType) throw new Error('This file type does not support binary preview')
    const data = await readFile(absPath)
    return { data: new Uint8Array(data), mimeType, size: info.size }
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
