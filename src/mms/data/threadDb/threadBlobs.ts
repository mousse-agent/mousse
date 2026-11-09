/**
 * Images and large outputs, kept outside the rows of `thread.db`: one file per content hash in the thread's
 * `blobs/` folder, so deleting the thread's folder frees them and two rows with the same image share one file.
 *
 * A row that refers to blobs lists them in its `blob_paths` column: for each, the exact place in the row's JSON
 * (a path of keys), the hash, the size and how it is stored. That list is the only thing that says a value is a
 * blob; the payload holds an empty string there, so an ordinary value can never be mistaken for a reference.
 *
 * Runs in the thread database workers (writing, reading, collecting) and in the daemon (deciding what goes out
 * of a row while it is serialized).
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Skeleton } from './jsonSkeleton'

/** A text value longer than this (in UTF-16 units) is stored as a blob. */
export const BLOB_TEXT_THRESHOLD = 64 * 1024
/** Base64 image data at least this long is stored as a blob. */
export const BLOB_IMAGE_THRESHOLD = 1024
/**
 * What a value whose blob could not be read shows instead. It names the blob, so a later save that still holds it
 * (wherever the value moved to) writes the reference back instead of the placeholder; nobody types this by chance.
 */
export function missingPlaceholder(kind: 'base64' | 'text', hash: string): string {
  return `[attachment unavailable: blob ${kind}:${hash}]`
}

const MISSING_PATTERN = /^\[attachment unavailable: blob (base64|text):([a-f0-9]{64})\]$/

/** True for the placeholder of a missing blob (what an image's data holds when its bytes are gone). */
export function isMissingPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && MISSING_PATTERN.test(value)
}

export type BlobKey = string | number
export interface BlobPath { v: 1; path: BlobKey[]; sha256: string; bytes: number; kind: 'base64' | 'text' }
export interface BlobData { sha256: string; kind: 'base64' | 'text'; data: string }
export interface EncodedRow { payload: string; paths: BlobPath[] | null; blobs: BlobData[] }

export const BLOBS_DIR = 'blobs'

function isObject(value: unknown): value is Record<string, Skeleton> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** False when the text holds a lone surrogate, which UTF-8 cannot store (it would come back as U+FFFD). */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The bytes a blob is stored as: decoded base64 for image data that round-trips exactly, UTF-8 otherwise. */
function blobBytes(kind: 'base64' | 'text', data: string): Buffer {
  return kind === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8')
}

/** A copy of `root` with the value at `path` replaced; only the containers along the path are copied. */
function withValueAt(root: Skeleton, path: BlobKey[], value: Skeleton): Skeleton {
  if (!path.length) return value
  const [key, ...rest] = path
  if (Array.isArray(root)) {
    const copy = root.slice()
    copy[key as number] = withValueAt(root[key as number], rest, value)
    return copy
  }
  const copy = { ...(root as Record<string, Skeleton>) }
  copy[key as string] = withValueAt((root as Record<string, Skeleton>)[key as string], rest, value)
  return copy
}

/**
 * Serializes a row (given as its skeleton, which is exactly what JSON keeps), moving image data and long text into
 * blobs. Text is moved only when UTF-8 holds it exactly (no lone surrogates); otherwise it stays in the row.
 * `lost` are references the row had whose blob could not be read: a value still showing that blob's placeholder
 * (`missingPlaceholder`), wherever it is now, is written back as the reference.
 */
export function encodeRow(skeleton: Skeleton, lost: BlobPath[] = []): EncodedRow {
  const lostByKey = new Map(lost.map((ref) => [`${ref.kind}:${ref.sha256}`, ref]))
  const found: Array<{ path: BlobKey[]; kind: 'base64' | 'text'; data: string }> = []
  const kept: BlobPath[] = []
  const walk = (node: Skeleton, path: BlobKey[], imageData: boolean): void => {
    if (typeof node === 'string') {
      const missing = MISSING_PATTERN.exec(node)
      const ref = missing ? lostByKey.get(`${missing[1]}:${missing[2]}`) : undefined
      if (ref) kept.push({ ...ref, path })
      else if (imageData && Buffer.from(node, 'base64').toString('base64') === node) found.push({ path, kind: 'base64', data: node })
      // Other text (image data that is not exact base64 included) only when UTF-8 holds it exactly.
      else if ((imageData || node.length > BLOB_TEXT_THRESHOLD) && wellFormed(node)) found.push({ path, kind: 'text', data: node })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index], false))
      return
    }
    if (!isObject(node)) return
    const holdsImage = typeof node.mimeType === 'string' && typeof node.data === 'string' && node.data.length >= BLOB_IMAGE_THRESHOLD
    for (const key of Object.keys(node)) walk(node[key]!, [...path, key], holdsImage && key === 'data')
  }
  walk(skeleton, [], false)
  if (!found.length && !kept.length) return { payload: JSON.stringify(skeleton), paths: null, blobs: [] }
  let stored = skeleton
  const paths: BlobPath[] = [...kept]
  const blobs: BlobData[] = []
  for (const entry of found) {
    const bytes = blobBytes(entry.kind, entry.data)
    const hash = sha256(bytes)
    paths.push({ v: 1, path: entry.path, sha256: hash, bytes: bytes.length, kind: entry.kind })
    if (!blobs.some((blob) => blob.sha256 === hash)) blobs.push({ sha256: hash, kind: entry.kind, data: entry.data })
  }
  for (const ref of paths) stored = withValueAt(stored, ref.path, '')
  return { payload: JSON.stringify(stored), paths, blobs }
}

export function blobPath(dir: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob hash')
  return join(dir, BLOBS_DIR, hash.slice(0, 2), hash)
}

/** Flushes a file. Opened for writing: Windows flushes only a handle that may write. */
function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Flushes a folder's entries. Windows cannot open a folder to flush it; NTFS journals folder entries itself. */
function fsyncDir(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * Writes a blob unless an intact copy is already there, and returns whether it wrote one. A damaged copy is
 * replaced. Either way the blob, its folder and the folders above it are fsynced before this returns: a copy
 * another writer has just put there is made durable here too, before a row that refers to it commits.
 */
export function writeBlob(dir: string, blob: BlobData): boolean {
  const target = blobPath(dir, blob.sha256)
  const bytes = blobBytes(blob.kind, blob.data)
  if (sha256(bytes) !== blob.sha256) throw new Error('Blob content does not match its hash')
  const root = join(dir, BLOBS_DIR)
  const folder = join(root, blob.sha256.slice(0, 2))
  mkdirSync(folder, { recursive: true })
  let intact = false
  try { intact = sha256(readFileSync(target)) === blob.sha256 } catch { /* absent */ }
  if (intact) {
    fsyncFile(target)
    fsyncDir(folder)
    fsyncDir(root)
    fsyncDir(dir)
    return false
  }
  const tmp = join(folder, `.${blob.sha256}.${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
  fsyncDir(folder)
  fsyncDir(root)
  fsyncDir(dir)
  return true
}

/** Reads a blob back as the string it was, or `undefined` when it is missing or does not match its hash. */
export function readBlob(dir: string, ref: BlobPath): string | undefined {
  try {
    const bytes = readFileSync(blobPath(dir, ref.sha256))
    if (sha256(bytes) !== ref.sha256) return undefined
    return ref.kind === 'base64' ? bytes.toString('base64') : bytes.toString('utf8')
  } catch {
    return undefined
  }
}

export function parseBlobPaths(value: string | null | undefined): BlobPath[] {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('blob_paths must be an array')
  return parsed.filter((entry): entry is BlobPath => isObject(entry as Skeleton) && (entry as BlobPath).v === 1 && Array.isArray((entry as BlobPath).path) && typeof (entry as BlobPath).sha256 === 'string')
}

/**
 * A row's payload with its blobs put back. A blob that is missing or damaged becomes its placeholder
 * (`missingPlaceholder`) and is reported, so the thread still opens.
 */
export function hydratePayload(dir: string, payload: string, blobPathsJson: string | null, options: { images?: boolean } = {}): { payload: string; missing: BlobPath[] } {
  const paths = parseBlobPaths(blobPathsJson)
  if (!paths.length) return { payload, missing: [] }
  let value = JSON.parse(payload) as Skeleton
  const missing: BlobPath[] = []
  for (const ref of paths) {
    // Image data stays out when not asked for (a page, a search); the empty value stays.
    if (options.images === false && ref.kind === 'base64') continue
    const data = readBlob(dir, ref)
    if (data === undefined) missing.push(ref)
    value = withValueAt(value, ref.path, data ?? missingPlaceholder(ref.kind, ref.sha256))
  }
  return { payload: JSON.stringify(value), missing }
}

/**
 * Removes blob files no row refers to and leftover temporary files, both only once older than `minAgeMs`. The
 * caller holds the thread's lock, under which every save publishes its blobs and commits its rows.
 */
export function collectBlobs(dir: string, referenced: Set<string>, minAgeMs: number): number {
  const root = join(dir, BLOBS_DIR)
  if (!existsSync(root)) return 0
  const cutoff = Date.now() - minAgeMs
  let removed = 0
  for (const prefix of readdirSync(root)) {
    const folder = join(root, prefix)
    let names: string[]
    try { names = readdirSync(folder) } catch { continue }
    for (const name of names) {
      const path = join(folder, name)
      const unused = name.startsWith('.') ? name.endsWith('.tmp') : !referenced.has(name)
      if (!unused) continue
      try {
        if (statSync(path).mtimeMs > cutoff) continue
        rmSync(path, { force: true })
        removed += 1
      } catch {
        // Gone already.
      }
    }
    // Never recursive: a blob another process just wrote there must stay. A folder that is not empty stays too.
    try { rmdirSync(folder) } catch { /* not empty, or gone */ }
  }
  return removed
}

/**
 * Moves the blobs an import staged (`<stage>/blobs/<aa>/<hash>`) into the thread's `blobs/`, keeping an intact copy
 * that is already there (a damaged one is replaced), then removes the staging folder. Each new file and folder is fsynced into its parent. The caller
 * holds the thread's lock and publishes the database only after this returns.
 */
export function publishStagedBlobs(dir: string, stage: string): number {
  const staged = join(stage, BLOBS_DIR)
  let moved = 0
  if (existsSync(staged)) {
    for (const prefix of readdirSync(staged)) {
      for (const name of readdirSync(join(staged, prefix))) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue
        const target = blobPath(dir, name)
        const root = join(dir, BLOBS_DIR)
        const folder = join(root, prefix)
        mkdirSync(folder, { recursive: true })
        // A copy already there is kept only when it is intact; a damaged one is replaced by the staged bytes.
        let intact = false
        try { intact = sha256(readFileSync(target)) === name } catch { /* absent */ }
        if (intact) {
          fsyncFile(target)
        } else {
          renameSync(join(staged, prefix, name), target)
          moved += 1
        }
        fsyncDir(folder)
        fsyncDir(root)
      }
    }
    fsyncDir(dir)
  }
  rmSync(stage, { recursive: true, force: true })
  return moved
}
