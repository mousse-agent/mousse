import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, readFile, writeFile, stat, lstat, rename, unlink, type FileHandle } from 'fs/promises'
import { basename, dirname, join, posix } from 'path'
import type { FileAsset, FileEntry, FileStat } from '../../shared/types'
import { countLineEdits } from '../../shared/lineEditStats'
import { SKIP_DIR_NAMES, lexicalGuard, type GuardedPath, type PathGuard } from './pathGuard'
import { OTHER_NAMES, PathContainmentError } from './routedGuard'

const MAX_READ_BYTES = 512 * 1024
const MAX_ASSET_BYTES = 100 * 1024 * 1024
/**
 * Lines changed are counted exactly (line by line) when both versions are this large or smaller. A larger save
 * (up to 25 MiB from another computer) counts only the difference in the number of lines, by scanning bytes, so a
 * save never holds the old file, the new one and a line list of each at once.
 */
const EXACT_COUNT_BYTES = 2 * 1024 * 1024
const SCAN_CHUNK_BYTES = 1024 * 1024

function countNewlines(bytes: Uint8Array): number {
  let count = 0
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count += 1
  return count
}

/** The lines `content` changes in the open file, counted as `countLineEdits` does, or approximately above `EXACT_COUNT_BYTES`. */
async function countedLineEdits(handle: FileHandle, size: number, bytes: Buffer, content: string): Promise<number> {
  if (size <= EXACT_COUNT_BYTES && bytes.length <= EXACT_COUNT_BYTES) {
    return countLineEdits(size ? await handle.readFile({ encoding: 'utf8' }) : '', content)
  }
  let oldNewlines = 0
  const chunk = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, Math.max(size, 1)))
  for (let at = 0; at < size;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, at)
    if (bytesRead === 0) break
    oldNewlines += countNewlines(chunk.subarray(0, bytesRead))
    at += bytesRead
  }
  return Math.abs(oldNewlines - countNewlines(bytes))
}

const ASSET_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', m4v: 'video/x-m4v'
}

/** Writes every byte of `bytes` at the start of the file. */
async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  for (let written = 0; written < bytes.length;) {
    written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten
  }
}

/**
 * Every call takes the guard of its caller (the default is a window of this computer): the guard
 * says which file a path names and whether this caller may read or change it.
 */
export class FileService {
  async listDir(root: string, dirPath = '', guard: PathGuard = lexicalGuard): Promise<FileEntry[]> {
    const dir = guard.resolve(root, dirPath, 'read')
    const entries = await readdir(dir.absolute, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue
      result.push({
        name: entry.name,
        path: posix.join(dir.relative, entry.name),
        kind: entry.isDirectory() ? 'directory' : 'file'
      })
    }

    result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return result
  }

  async readFile(root: string, filePath: string, guard: PathGuard = lexicalGuard): Promise<string> {
    const { absolute } = guard.resolve(root, filePath, 'read')
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error('Not a file')
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`File exceeds ${MAX_READ_BYTES / 1024}KB limit`)
    }
    return readFile(absolute, 'utf8')
  }

  /** The asset's file, once the root guard, the size limit and the preview types have passed. */
  private async assetFile(root: string, filePath: string, guard: PathGuard): Promise<{ absPath: string; mimeType: string; size: number }> {
    const { absolute: absPath } = guard.resolve(root, filePath, 'read')
    const info = await stat(absPath)
    if (!info.isFile()) throw new Error('Not a file')
    if (info.size > MAX_ASSET_BYTES) {
      throw new Error(`Preview exceeds ${MAX_ASSET_BYTES / 1024 / 1024}MB limit`)
    }
    const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = ASSET_MIME_TYPES[extension]
    if (!mimeType) throw new Error('This file type does not support binary preview')
    return { absPath, mimeType, size: info.size }
  }

  async readAsset(root: string, filePath: string, guard: PathGuard = lexicalGuard): Promise<FileAsset> {
    const { absPath, mimeType, size } = await this.assetFile(root, filePath, guard)
    const data = await readFile(absPath)
    return { data: new Uint8Array(data), mimeType, size }
  }

  /**
   * `length` bytes of the asset from `offset`, so a preview of any size travels in pieces that fit a
   * daemon message. `size` is the whole file's; a piece past its end is empty.
   */
  async readAssetRange(root: string, filePath: string, offset: number, length: number, guard: PathGuard = lexicalGuard): Promise<FileAsset> {
    const { absPath, mimeType, size } = await this.assetFile(root, filePath, guard)
    const wanted = Math.max(0, Math.min(length, size - offset))
    const buffer = Buffer.alloc(wanted)
    const handle = await open(absPath, 'r')
    try {
      const { bytesRead } = wanted > 0 ? await handle.read(buffer, 0, wanted, offset) : { bytesRead: 0 }
      return { data: new Uint8Array(buffer.subarray(0, bytesRead)), mimeType, size }
    } finally {
      await handle.close()
    }
  }

  /** `resolved` is the guard's answer for this path when the caller already asked it (a routed save asks once, before it records anything). */
  async writeFile(root: string, filePath: string, content: string, guard: PathGuard = lexicalGuard, resolved?: GuardedPath): Promise<number> {
    const guarded = resolved ?? guard.resolve(root, filePath, 'write')
    if (guard.contained) return this.writeContained(guarded, content)
    const absPath = guarded.absolute
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

  /**
   * A change from another computer. The file is opened first and then checked to be the file the guard
   * resolved (not a link put there since), with a name of its own, before a byte of it is changed. A new
   * file is written beside its name and renamed onto it: a rename replaces a link at the name instead of
   * following it, which creating the file at that name would do on Windows.
   */
  private async writeContained(guarded: GuardedPath, content: string): Promise<number> {
    const { absolute } = guarded
    const changed = (): PathContainmentError =>
      new PathContainmentError('path_outside_folder', 'That path changed while it was being saved, so nothing was written.')
    let handle: FileHandle
    try {
      handle = await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A link at the name is refused by the open itself (`O_NOFOLLOW`) where the system has it.
      if (code === 'ELOOP') throw changed()
      if (code !== 'ENOENT') throw error
      return this.createContained(absolute, content, changed)
    }
    try {
      const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(absolute, { bigint: true })])
      if (!named.isFile() || named.ino !== opened.ino || named.dev !== opened.dev) throw changed()
      if (opened.nlink > 1n) throw new PathContainmentError('path_protected', OTHER_NAMES)
      const bytes = Buffer.from(content, 'utf8')
      // Counted from the old file before it is replaced.
      const lineEdits = await countedLineEdits(handle, Number(opened.size), bytes, content)
      await handle.truncate(0)
      await writeAll(handle, bytes)
      return lineEdits
    } finally {
      await handle.close()
    }
  }

  private async createContained(absolute: string, content: string, changed: () => PathContainmentError): Promise<number> {
    // A name that exists by now (a link to nowhere, or a file made since) is not the new file the guard saw.
    const exists = (): Promise<boolean> => lstat(absolute).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (await exists()) throw changed()
    const beside = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`)
    const handle = await open(beside, 'wx')
    const bytes = Buffer.from(content, 'utf8')
    try {
      try {
        await writeAll(handle, bytes)
      } finally {
        await handle.close()
      }
      if (await exists()) throw changed()
      await rename(beside, absolute)
    } catch (error) {
      await unlink(beside).catch(() => undefined)
      throw error
    }
    return bytes.length <= EXACT_COUNT_BYTES ? countLineEdits('', content) : countNewlines(bytes)
  }

  async stat(root: string, targetPath: string, guard: PathGuard = lexicalGuard): Promise<FileStat> {
    const { absolute, relative: name } = guard.resolve(root, targetPath, 'read')
    const info = await stat(absolute)
    return {
      path: name,
      kind: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    }
  }
}
