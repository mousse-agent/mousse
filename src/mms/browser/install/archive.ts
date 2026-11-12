import { lstat, mkdir } from 'node:fs/promises'
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
// macOS follows at most 32 links in one lookup (MAXSYMLINKS; Linux allows 40),
// counting links in the install path itself, such as /var -> /private/var. 16
// hops leaves room for those; the real framework links need one.
const MAX_LINK_HOPS = 16
// The real macOS archive has 5 links; the cap bounds the work of following them.
const MAX_LINK_ENTRIES = 256
// Names and link targets must be printable ASCII. For ASCII, the only names a
// case-insensitive, normalising filesystem (APFS, NTFS) merges are those that
// differ in A-Z case, so ASCII lowercasing compares names exactly as the disk
// does. Real Chrome for Testing archives use only ASCII names.
const PLAIN_NAME = /^[\x20-\x7e]+$/

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
  const emitted = new Set<string>()
  let inflated = 0
  const unzip = new Unzip((file) => {
    const name = file.name.replaceAll('\\', '/')
    const entry = expected.get(name)
    if (!entry || emitted.has(name)) throw new Error(`Archive emitted an unexpected entry: ${name}`)
    emitted.add(name)
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
  for (const name of expected.keys()) if (!emitted.has(name)) throw new Error(`Archive entry is missing from the archive data: ${name}`)
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
      if (isSameOrAncestor(resolvedPath, realpathSync.native(dirname(path)))) throw new Error(`Archive symlink points at its own folder or a folder above it: ${relative(destinationRoot, path)}`)
    }
  } catch (error) {
    // Unlink (never follow) what was created so the staging tree holds no links.
    for (const path of created) {
      try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path) } catch { /* staging cleanup owns the rest */ }
    }
    throw error
  }
}

/** True when `candidate` is `directory` itself or one of its ancestors. */
function isSameOrAncestor(candidate: string, directory: string): boolean {
  const rel = relative(candidate, directory)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
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
  let linkCount = 0
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
    if (isSymlink && ++linkCount > MAX_LINK_ENTRIES) throw new Error(`Archive contains too many symlink entries (more than ${MAX_LINK_ENTRIES}).`)
    // Device nodes, FIFOs and sockets have no place in a browser archive.
    if (!isSymlink && UNIX_HOSTS.has(madeByHost) && modeType !== 0 && modeType !== MODE_REGULAR && modeType !== MODE_DIRECTORY) {
      throw new Error(`Archive contains an unsupported file type: ${name}`)
    }
    // The trailing slash alone decides whether an entry becomes a directory, so
    // it must agree with the entry's mode and size.
    if (!isSymlink && name.endsWith('/') && (uncompressedSize !== 0 || (UNIX_HOSTS.has(madeByHost) && modeType === MODE_REGULAR))) throw new Error(`Archive file entry is named as a directory: ${name}`)
    if (!name.endsWith('/') && UNIX_HOSTS.has(madeByHost) && modeType === MODE_DIRECTORY) throw new Error(`Archive directory entry is named as a file: ${name}`)
    if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`Invalid Chrome archive local entry: ${name}`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > archive.byteLength) throw new Error(`Invalid Chrome archive data range: ${name}`)
    // The extractor streams local headers, so they must say what the central
    // directory says.
    const centralName = archive.subarray(nameStart, nameEnd)
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    if (localNameLength !== nameLength || !localName.every((byte, offset) => byte === centralName[offset]) || view.getUint16(localOffset + 8, true) !== view.getUint16(cursor + 10, true)) {
      throw new Error(`Archive central and local headers disagree: ${name}`)
    }
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
  assertConsistentTree(entries)
  return entries
}

function entryKey(name: string): string {
  // Names are plain ASCII (validateEntryName), so ASCII lowercasing merges
  // exactly the names a case-insensitive filesystem merges.
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()).replace(/\/$/, '')
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
  // Plain targets only: no empty or `.` segments and no trailing slash, so the
  // archive model below resolves them exactly as the filesystem will.
  if (!PLAIN_NAME.test(target) || target.split('/').some((segment) => segment === '' || segment === '.')) {
    throw new Error(`Archive symlink target is not a plain relative path: ${name}`)
  }
  return target
}

interface TreeNode { path: string; kind: EntryKind; linkTarget?: string }

/**
 * Builds the tree the archive will produce and checks it is unambiguous: every
 * path has one spelling and one kind, nothing sits below a file or a link, and
 * every link resolves, following the archive's other links the way the
 * filesystem will, to an existing entry inside the tree that is not the
 * link's own folder or a folder above it, and not a folder holding links (so
 * links can never form a directory cycle).
 */
function assertConsistentTree(entries: ZipEntry[]): void {
  const nodes = new Map<string, TreeNode>()
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean)
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const path = parts.slice(0, depth).join('/')
      const kind: EntryKind = depth < parts.length ? 'directory' : entry.kind
      const key = entryKey(path)
      const existing = nodes.get(key)
      if (!existing) { nodes.set(key, { path, kind, linkTarget: kind === 'symlink' ? entry.linkTarget : undefined }); continue }
      if (existing.path !== path) throw new Error(`Archive contains duplicate or case-colliding entry: ${entry.name}`)
      if (existing.kind !== kind) {
        if (existing.kind === 'symlink' || kind === 'symlink') throw new Error(`Archive entry is written through a symlink entry: ${entry.name}`)
        throw new Error(`Archive entry uses a file as a directory: ${entry.name}`)
      }
    }
  }
  const links = entries.filter((entry) => entry.kind === 'symlink')
  if (!links.length) return
  const foldersHoldingLinks = new Set<string>()
  for (const link of links) {
    const parts = link.name.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) foldersHoldingLinks.add(entryKey(parts.slice(0, depth).join('/')))
  }
  for (const link of links) {
    const ownFolder = link.name.split('/').slice(0, -1)
    const resolved = [...ownFolder]
    const pending = link.linkTarget!.split('/')
    let hops = 0
    let node: TreeNode | undefined
    while (pending.length) {
      const part = pending.shift()!
      if (node?.kind === 'file') throw new Error(`Archive symlink goes through a file: ${link.name}`)
      if (part === '..') {
        if (!resolved.length) throw new Error(`Archive symlink points outside the extraction root: ${link.name}`)
        resolved.pop()
        node = resolved.length ? nodes.get(entryKey(resolved.join('/'))) : undefined
        continue
      }
      resolved.push(part)
      node = nodes.get(entryKey(resolved.join('/')))
      if (!node) throw new Error(`Archive symlink target is missing from the archive: ${link.name}`)
      if (node.path !== resolved.join('/')) throw new Error(`Archive symlink target differs in case from the archive entry: ${link.name}`)
      if (node.kind !== 'symlink') continue
      if (++hops > MAX_LINK_HOPS) throw new Error(`Archive symlink chain is too long or loops: ${link.name}`)
      resolved.pop()
      pending.unshift(...node.linkTarget!.split('/'))
      node = resolved.length ? nodes.get(entryKey(resolved.join('/'))) : undefined
    }
    if (!resolved.length) throw new Error(`Archive symlink points at the extraction root: ${link.name}`)
    if (resolved.length <= ownFolder.length && resolved.every((part, index) => part === ownFolder[index])) {
      throw new Error(`Archive symlink points at its own folder or a folder above it: ${link.name}`)
    }
    if (foldersHoldingLinks.has(entryKey(resolved.join('/')))) throw new Error(`Archive symlink points at a folder that holds links: ${link.name}`)
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
  // Plain names only, so every name means one path both here and on disk: no
  // empty or `.` segment, and a trailing slash only as a directory marker.
  if (!PLAIN_NAME.test(name)) throw new Error(`Archive entry name is not plain ASCII: ${name}`)
  const segments = name.replace(/\/$/, '').split('/')
  if (segments.some((segment) => segment === '' || segment === '.')) throw new Error(`Archive entry name has an empty or "." segment: ${name}`)
  for (const segment of segments) {
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
