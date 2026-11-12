import { lstat, mkdir } from 'node:fs/promises'
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Unzip, UnzipInflate, inflateSync } from 'fflate'

export interface SafeExtractLimits {
  maxEntries: number
  maxExtractedBytes: number
  signal?: AbortSignal
  /**
   * Allow symlink entries whose target stays inside the extracted tree. Only
   * the macOS Chrome app bundle needs this (its framework uses the standard
   * `Versions/Current` links); every other platform keeps refusing symlinks.
   */
  allowContainedSymlinks?: boolean
}
type EntryKind = 'file' | 'directory' | 'symlink'
interface ZipEntry { name: string; kind: EntryKind; compressedSize: number; uncompressedSize: number; externalAttributes: number; linkTarget?: string }
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const END_SIGNATURE = 0x06054b50
const ZIP64_SENTINEL = 0xffffffff
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i
const UNIX_HOSTS = new Set([3, 19])
const MODE_TYPE_MASK = 0xf000
const MODE_REGULAR = 0x8000
const MODE_DIRECTORY = 0x4000
const MODE_SYMLINK = 0xa000
const MAX_LINK_TARGET_BYTES = 1024
const MAX_LINK_HOPS = 40

export async function extractChromeZip(archive: Uint8Array, destination: string, limits: SafeExtractLimits): Promise<{ entries: number; extractedBytes: number }> {
  const entries = inspectZip(archive, limits)
  const destinationRoot = resolve(destination)
  await ensureDirectory(destinationRoot, destinationRoot)
  for (const entry of entries) {
    assertNotAborted(limits.signal)
    const target = resolve(destinationRoot, entry.name)
    const rel = relative(destinationRoot, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Archive entry escapes extraction root: ${entry.name}`)
    if (entry.kind === 'directory') { await ensureDirectory(target, destinationRoot); continue }
    await ensureDirectory(resolve(target, '..'), destinationRoot)
  }
  const extractedBytes = inflateZipToDisk(archive, entries, destinationRoot, limits)
  // Links are created only after every file and directory is on disk, so no
  // archive entry can ever be written through one.
  createContainedSymlinks(entries, destinationRoot, limits.signal)
  return { entries: entries.length, extractedBytes }
}

function inflateZipToDisk(archive: Uint8Array, entries: ZipEntry[], destinationRoot: string, limits: SafeExtractLimits): number {
  const expected = new Map(entries.map((entry) => [entry.name, entry]))
  let inflated = 0
  const unzip = new Unzip((file) => {
    const name = file.name.replaceAll('\\', '/')
    const entry = expected.get(name)
    if (!entry) throw new Error(`Archive emitted an unexpected entry: ${name}`)
    const target = resolve(destinationRoot, name)
    let handle = entry.kind === 'file' ? openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o755) : undefined
    const linkBytes: Uint8Array[] = []
    let entryBytes = 0
    file.ondata = (error, data, final) => {
      try {
        assertNotAborted(limits.signal)
        if (error) throw new Error(`Archive entry could not be inflated: ${name}`)
        entryBytes += data.byteLength
        inflated += data.byteLength
        if (entryBytes > entry.uncompressedSize) throw new Error(`Archive entry size changed while inflating: ${name}`)
        if (inflated > limits.maxExtractedBytes) throw new Error('Archive extracted size exceeds the configured limit.')
        if (data.byteLength && handle !== undefined) writeAllSync(handle, data)
        if (data.byteLength && entry.kind === 'symlink') linkBytes.push(data.slice())
        if (final) {
          if (entryBytes !== entry.uncompressedSize) throw new Error(`Archive entry size changed while inflating: ${name}`)
          if (entry.kind === 'symlink' && decodeLinkTarget(concatBytes(linkBytes), name) !== entry.linkTarget) {
            throw new Error(`Archive symlink target changed while inflating: ${name}`)
          }
          if (handle !== undefined) {
            fsyncSync(handle)
            closeSync(handle)
            handle = undefined
            if (process.platform !== 'win32') chmodSync(target, 0o755)
          }
        }
      } catch (caught) {
        if (handle !== undefined) {
          try { closeSync(handle) } catch { /* extraction cleanup owns the partial file */ }
          handle = undefined
        }
        throw caught
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try { unzip.push(archive, true) } catch (error) { throw error instanceof Error ? error : new Error(String(error)) }
  return inflated
}

function createContainedSymlinks(entries: ZipEntry[], destinationRoot: string, signal?: AbortSignal): void {
  const links = entries.filter((entry) => entry.kind === 'symlink')
  if (!links.length) return
  const created: string[] = []
  try {
    for (const entry of links) {
      assertNotAborted(signal)
      const path = resolve(destinationRoot, entry.name)
      symlinkSync(entry.linkTarget!, path)
      created.push(path)
    }
    // Defense in depth: the in-memory check in inspectZip already proved every
    // target stays inside the tree; confirm it against the real filesystem.
    const canonicalRoot = realpathSync.native(destinationRoot)
    for (const path of created) {
      let resolvedPath: string
      try { resolvedPath = realpathSync.native(path) } catch { throw new Error(`Archive symlink does not resolve inside the extraction root: ${relative(destinationRoot, path)}`) }
      const rel = relative(canonicalRoot, resolvedPath)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Archive symlink points outside the extraction root: ${relative(destinationRoot, path)}`)
    }
  } catch (error) {
    // Unlink (never follow) what was created so the staging tree holds no links.
    for (const path of created) {
      try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path) } catch { /* staging cleanup owns the rest */ }
    }
    throw error
  }
}

function writeAllSync(handle: number, data: Uint8Array): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = writeSync(handle, data, offset, data.byteLength - offset)
    if (written === 0) throw new Error('Archive extraction could not make progress while writing a file.')
    offset += written
  }
}

function inspectZip(archive: Uint8Array, limits: SafeExtractLimits): ZipEntry[] {
  if (archive.byteLength < 22) throw new Error('Invalid Chrome archive: missing ZIP end record.')
  const end = findEndRecord(archive)
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralOffset = view.getUint32(end + 16, true)
  if (count === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) throw new Error('ZIP64 Chrome archives are not supported.')
  if (count > limits.maxEntries) throw new Error(`Archive contains too many entries (${count}).`)
  if (centralOffset + centralSize > archive.byteLength) throw new Error('Invalid Chrome archive: central directory is outside the archive.')
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let cursor = centralOffset
  let totalInflated = 0
  for (let index = 0; index < count; index += 1) {
    assertNotAborted(limits.signal)
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error('Invalid Chrome archive: malformed central directory.')
    const madeByHost = view.getUint8(cursor + 5)
    const flags = view.getUint16(cursor + 8, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) throw new Error('ZIP64 Chrome archive entries are not supported.')
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd + extraLength + commentLength > archive.byteLength) throw new Error('Invalid Chrome archive: truncated central directory entry.')
    let name: string
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(nameStart, nameEnd)).replaceAll('\\', '/') } catch { throw new Error('Invalid Chrome archive: entry name is not UTF-8.') }
    validateEntryName(name)
    const key = entryKey(name)
    if (seen.has(key)) throw new Error(`Archive contains duplicate or case-colliding entry: ${name}`)
    seen.add(key)
    const modeType = (externalAttributes >>> 16) & MODE_TYPE_MASK
    const isSymlink = modeType === MODE_SYMLINK
    if (isSymlink && !limits.allowContainedSymlinks) throw new Error(`Archive contains a symlink entry: ${name}`)
    // Device nodes, FIFOs and sockets have no place in a browser archive.
    if (!isSymlink && UNIX_HOSTS.has(madeByHost) && modeType !== 0 && modeType !== MODE_REGULAR && modeType !== MODE_DIRECTORY) {
      throw new Error(`Archive contains an unsupported file type: ${name}`)
    }
    if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`Invalid Chrome archive local entry: ${name}`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > archive.byteLength) throw new Error(`Invalid Chrome archive data range: ${name}`)
    totalInflated += uncompressedSize
    if (totalInflated > limits.maxExtractedBytes) throw new Error('Archive declared size exceeds the configured limit.')
    if (flags & 0x0001) throw new Error(`Encrypted Chrome archive entries are not supported: ${name}`)
    if (isSymlink) {
      if (name.endsWith('/')) throw new Error(`Archive symlink entry is named as a directory: ${name}`)
      const method = view.getUint16(localOffset + 8, true)
      const linkTarget = readLinkTarget(archive.subarray(dataStart, dataStart + compressedSize), method, uncompressedSize, name)
      entries.push({ name, kind: 'symlink', compressedSize, uncompressedSize, externalAttributes, linkTarget })
    } else {
      entries.push({ name, kind: name.endsWith('/') ? 'directory' : 'file', compressedSize, uncompressedSize, externalAttributes })
    }
    cursor = nameEnd + extraLength + commentLength
  }
  assertContainedSymlinks(entries)
  return entries
}

function entryKey(name: string): string {
  // Case and Unicode-normalization insensitive, like the default macOS and
  // Windows filesystems, so colliding names are refused rather than merged.
  return name.normalize('NFC').toLocaleLowerCase('en-US').replace(/\/+$/, '')
}

function readLinkTarget(data: Uint8Array, method: number, uncompressedSize: number, name: string): string {
  if (uncompressedSize === 0 || uncompressedSize > MAX_LINK_TARGET_BYTES) throw new Error(`Archive symlink target has an invalid length: ${name}`)
  let bytes: Uint8Array
  if (method === 0) bytes = data
  else if (method === 8) {
    try { bytes = inflateSync(data, { out: new Uint8Array(uncompressedSize) }) } catch { throw new Error(`Archive symlink target could not be inflated: ${name}`) }
  } else throw new Error(`Archive symlink uses an unsupported compression method: ${name}`)
  if (bytes.byteLength !== uncompressedSize) throw new Error(`Archive symlink target has an invalid length: ${name}`)
  return decodeLinkTarget(bytes, name)
}

function decodeLinkTarget(bytes: Uint8Array, name: string): string {
  let target: string
  try { target = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`Archive symlink target is not UTF-8: ${name}`) }
  if (!target || target.includes('\u0000') || target.includes('\\') || target.includes(':') || target.startsWith('/') || isAbsolute(target)) {
    throw new Error(`Archive symlink target is absolute or not portable: ${name}`)
  }
  return target
}

/**
 * Resolves every symlink target against the archive's own tree, following
 * links inside the archive the way the filesystem will, and refuses any link
 * that would leave the tree, dangle, loop, or sit above another entry.
 */
function assertContainedSymlinks(entries: ZipEntry[]): void {
  const links = new Map<string, string>()
  for (const entry of entries) if (entry.kind === 'symlink') links.set(entryKey(entry.name), entry.linkTarget!)
  if (!links.size) return
  const nodes = new Set<string>()
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean)
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const key = entryKey(parts.slice(0, depth).join('/'))
      // A link may be the last segment of its own entry only; any entry below
      // a link would be written through it.
      if (depth < parts.length && links.has(key)) throw new Error(`Archive entry is written through a symlink entry: ${entry.name}`)
      nodes.add(key)
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'symlink') continue
    const resolved = entry.name.split('/').filter(Boolean)
    resolved.pop()
    const pending = entry.linkTarget!.split('/')
    let hops = 0
    while (pending.length) {
      const part = pending.shift()!
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (!resolved.length) throw new Error(`Archive symlink points outside the extraction root: ${entry.name}`)
        resolved.pop()
        continue
      }
      resolved.push(part)
      const next = links.get(entryKey(resolved.join('/')))
      if (next === undefined) continue
      if (++hops > MAX_LINK_HOPS) throw new Error(`Archive symlink chain is too long or loops: ${entry.name}`)
      resolved.pop()
      pending.unshift(...next.split('/'))
    }
    if (!resolved.length) throw new Error(`Archive symlink points at the extraction root: ${entry.name}`)
    if (!nodes.has(entryKey(resolved.join('/')))) throw new Error(`Archive symlink target is missing from the archive: ${entry.name}`)
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Browser installation was cancelled.', 'AbortError')
}

function findEndRecord(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const start = Math.max(0, archive.byteLength - 65_557)
  for (let offset = archive.byteLength - 22; offset >= start; offset -= 1) if (view.getUint32(offset, true) === END_SIGNATURE) return offset
  throw new Error('Invalid Chrome archive: missing ZIP end record.')
}

function validateEntryName(name: string): void {
  if (!name || name.includes('\u0000') || name.includes('\\') || isAbsolute(name) || name.split('/').includes('..')) throw new Error(`Archive entry escapes extraction root: ${name}`)
  for (const segment of name.split('/').filter(Boolean)) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') throw new Error(`Archive entry uses a reserved runtime name: ${name}`)
    if (segment.includes(':') || segment.endsWith(' ') || segment.endsWith('.')) throw new Error(`Archive entry is not portable: ${name}`)
    if (WINDOWS_RESERVED.test(segment)) throw new Error(`Archive entry uses a reserved device name: ${name}`)
  }
}

async function ensureDirectory(directory: string, root: string): Promise<void> {
  const target = resolve(directory)
  const base = resolve(root)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Archive directory escapes extraction root: ${directory}`)
  await mkdir(base, { recursive: true })
  const baseDetails = await lstat(base)
  if (baseDetails.isSymbolicLink() || !baseDetails.isDirectory()) throw new Error(`Extraction root is not a real directory: ${base}`)
  const parts = rel ? rel.split(/[\\/]/).filter(Boolean) : []
  let current = base
  for (const part of parts) {
    current = join(current, part)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Extraction path is not a real directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}
