import { lstat, mkdir } from 'node:fs/promises'
import { chmodSync, closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'

export interface SafeExtractLimits { maxEntries: number; maxExtractedBytes: number; signal?: AbortSignal }
interface ZipEntry { name: string; directory: boolean; compressedSize: number; uncompressedSize: number; externalAttributes: number }
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const ZIP64_SENTINEL = 0xffffffff
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

export async function extractChromeZip(archive: Uint8Array, destination: string, limits: SafeExtractLimits): Promise<{ entries: number; extractedBytes: number }> {
  const entries = inspectZip(archive, limits)
  const destinationRoot = resolve(destination)
  await ensureDirectory(destinationRoot, destinationRoot)
  for (const entry of entries) {
    assertNotAborted(limits.signal)
    const target = resolve(destinationRoot, entry.name)
    const rel = relative(destinationRoot, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Archive entry escapes extraction root: ${entry.name}`)
    if (entry.directory) { await ensureDirectory(target, destinationRoot); continue }
    await ensureDirectory(resolve(target, '..'), destinationRoot)
  }
  const extractedBytes = inflateZipToDisk(archive, entries, destinationRoot, limits)
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
    let handle = entry.directory ? undefined : openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o755)
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
        if (final) {
          if (entryBytes !== entry.uncompressedSize) throw new Error(`Archive entry size changed while inflating: ${name}`)
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
    const key = name.toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new Error(`Archive contains duplicate or case-colliding entry: ${name}`)
    seen.add(key)
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`Archive contains a symlink entry: ${name}`)
    if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Invalid Chrome archive local entry: ${name}`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    if (localOffset + 30 + localNameLength + localExtraLength + compressedSize > archive.byteLength) throw new Error(`Invalid Chrome archive data range: ${name}`)
    totalInflated += uncompressedSize
    if (totalInflated > limits.maxExtractedBytes) throw new Error('Archive declared size exceeds the configured limit.')
    if (flags & 0x0001) throw new Error(`Encrypted Chrome archive entries are not supported: ${name}`)
    entries.push({ name, directory: name.endsWith('/'), compressedSize, uncompressedSize, externalAttributes })
    cursor = nameEnd + extraLength + commentLength
  }
  return entries
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
