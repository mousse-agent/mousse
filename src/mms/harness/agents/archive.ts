/**
 * Unpacks a downloaded agent archive into a staging folder, refusing anything that could write
 * outside it or that is not a plain file or folder: symlinks, hardlinks, devices, FIFOs, and
 * absolute, drive, UNC or `..` names (read with `\` as `/`). Entry count and expanded size are
 * counted while streaming, never taken from the archive's own headers.
 */
import { randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, createReadStream, createWriteStream, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { Parser, type ReadEntry } from 'tar'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { unsafeSegment, type ArchiveFormat } from './registry'

export const MAX_ARCHIVE_ENTRIES = 20_000
export const MAX_EXPANDED_BYTES = 4 * 1024 ** 3

export interface ExtractOptions {
  format: ArchiveFormat
  signal?: AbortSignal
  /** A folder every entry sits in, dropped from the names (npm tarballs: `package/`). */
  stripPrefix?: string
  maxEntries?: number
  maxBytes?: number
}

export interface ExtractResult {
  files: number
  bytes: number
}

export class ArchiveError extends Error {}

/**
 * An entry name as path segments under the destination, or `null` for the archive root (or the
 * stripped prefix itself). Throws for any name that could leave the destination.
 */
export function entrySegments(name: string, stripPrefix?: string): string[] | null {
  let normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0'))
    throw new ArchiveError(`The archive has an entry outside its folder: ${name}`)
  normalized = normalized.replace(/^(\.\/)+/, '')
  if (stripPrefix) {
    const prefix = stripPrefix.replace(/\\/g, '/').replace(/\/?$/, '/')
    if (normalized === prefix || normalized === prefix.slice(0, -1)) return null
    if (!normalized.startsWith(prefix)) throw new ArchiveError(`The archive has an entry outside ${prefix}: ${name}`)
    normalized = normalized.slice(prefix.length)
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) throw new ArchiveError(`The archive has an entry outside its folder: ${name}`)
  if (segments.some(unsafeSegment)) throw new ArchiveError(`The archive has a name Windows cannot hold safely: ${name}`)
  return segments.length ? segments : null
}

/** The absolute path of `segments` under `root`, checked to stay inside it. */
function inside(root: string, segments: string[]): string {
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) throw new ArchiveError(`The archive has an entry outside its folder: ${segments.join('/')}`)
  return target
}

class Budget {
  entries = 0
  bytes = 0
  files = 0
  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  entry(): void {
    this.entries += 1
    if (this.entries > this.maxEntries) throw new ArchiveError(`The archive has more than ${this.maxEntries} entries.`)
  }

  /** Counts the bytes actually written, whatever the headers say. */
  counter(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        this.bytes += chunk.byteLength
        if (this.bytes > this.maxBytes) done(new ArchiveError(`The archive expands to more than ${size(this.maxBytes)}.`))
        else done(null, chunk)
      }
    })
  }
}

/**
 * Streams one entry to a new file. Settles once the file is closed: on success, or on the first
 * error from any side (or `signal`). It never waits for the source to close, since a destroyed
 * zip entry stream may never do so.
 */
function writeEntry(source: Readable, target: string, mode: number | undefined, budget: Budget, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const writer = createWriteStream(target, { flags: 'wx', mode: 0o600 })
    const counter = budget.counter()
    let settled = false
    const settle = (error?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) {
        budget.files += 1
        // Permissions from the archive, never beyond rwxr-xr-x.
        try {
          if (process.platform !== 'win32') chmodSync(target, (mode ?? 0o644) & 0o755)
        } catch (chmodError) {
          reject(chmodError)
          return
        }
        resolveWrite()
        return
      }
      source.unpipe(counter)
      source.destroy()
      counter.destroy()
      // The file handle is closed before the caller deletes the folder (Windows refuses otherwise).
      if (writer.closed) reject(error)
      else {
        writer.once('close', () => reject(error))
        writer.destroy()
      }
    }
    const onAbort = () => settle(signal?.reason ?? new Error('cancelled'))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    source.once('error', settle)
    counter.once('error', settle)
    writer.once('error', settle)
    writer.once('close', () => {
      if (writer.writableFinished) settle()
    })
    source.pipe(counter).pipe(writer)
  })
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GiB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MiB` : `${bytes} bytes`
}

async function extractTar(archive: string, destination: string, options: ExtractOptions, budget: Budget): Promise<void> {
  // Ends every file still being written when the extraction fails, so none is left open.
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  await new Promise<void>((resolveAll, reject) => {
    const writes: Array<Promise<void>> = []
    let failed = false
    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      options.signal?.removeEventListener('abort', abort)
      input.destroy()
      stop.abort(error)
      void Promise.allSettled(writes).then(() => reject(error))
    }
    const parser = new Parser({ strict: true })
    parser.on('entry', (entry: ReadEntry) => {
      if (failed) return void entry.resume()
      try {
        budget.entry()
        const segments = entrySegments(entry.path, options.stripPrefix)
        const type = entry.type
        if (type === 'Directory') {
          if (segments) mkdirSync(inside(destination, segments), { recursive: true })
          entry.resume()
          return
        }
        if (type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile')
          throw new ArchiveError(`The archive has a ${type === 'SymbolicLink' ? 'symbolic link' : type === 'Link' ? 'hard link' : 'special file'} (${entry.path}), which Mousse does not install.`)
        if (!segments) throw new ArchiveError(`The archive has a file without a name.`)
        const target = inside(destination, segments)
        mkdirSync(resolve(target, '..'), { recursive: true })
        writes.push(writeEntry(entry as unknown as Readable, target, entry.mode, budget, signal).catch((error) => {
          fail(error)
        }))
      } catch (error) {
        entry.resume()
        fail(error)
      }
    })
    parser.on('error', fail)
    parser.on('end', () => {
      void Promise.all(writes).then(() => {
        if (failed) return
        options.signal?.removeEventListener('abort', abort)
        resolveAll()
      })
    })
    const input = createReadStream(archive)
    const abort = () => fail(options.signal?.reason ?? new Error('cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    input.on('error', fail)
    input.on('data', (chunk) => {
      if (!parser.write(chunk as Buffer)) {
        input.pause()
        parser.once('drain', () => input.resume())
      }
    })
    input.on('end', () => parser.end())
  })
}

function zipOpen(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => openZip(path, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (error, zip) => (error || !zip ? reject(error ?? new ArchiveError('The archive cannot be read.')) : resolveZip(zip))))
}

function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => (error || !stream ? reject(error ?? new ArchiveError('An archive entry cannot be read.')) : resolveStream(stream))))
}

/** A zip entry's Unix mode (from the external attributes), when it has one. */
function zipMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

async function extractZip(archive: string, destination: string, options: ExtractOptions, budget: Budget): Promise<void> {
  const zip = await zipOpen(archive)
  try {
    let writing: Promise<void> | undefined
    await new Promise<void>((resolveAll, reject) => {
      // A cancel waits for the file being written to close (it ends on the same signal).
      const abort = () => void (writing ?? Promise.resolve()).catch(() => undefined).then(() => reject(options.signal?.reason ?? new Error('cancelled')))
      options.signal?.addEventListener('abort', abort, { once: true })
      const done = (error?: unknown) => {
        options.signal?.removeEventListener('abort', abort)
        if (error === undefined) resolveAll()
        else reject(error)
      }
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          options.signal?.throwIfAborted()
          budget.entry()
          const segments = entrySegments(entry.fileName, options.stripPrefix)
          const mode = zipMode(entry)
          const kind = mode & 0o170000
          const directory = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\') || kind === 0o040000
          if (directory) {
            if (segments) mkdirSync(inside(destination, segments), { recursive: true })
          } else {
            if (kind !== 0 && kind !== 0o100000)
              throw new ArchiveError(`The archive has a ${kind === 0o120000 ? 'symbolic link' : 'special file'} (${entry.fileName}), which Mousse does not install.`)
            if (!segments) throw new ArchiveError('The archive has a file without a name.')
            const target = inside(destination, segments)
            mkdirSync(resolve(target, '..'), { recursive: true })
            writing = writeEntry(await entryStream(zip, entry), target, mode & 0o777 ? mode & 0o777 : undefined, budget, options.signal)
            await writing
            writing = undefined
          }
          zip.readEntry()
        })().catch(done)
      })
      zip.once('end', () => done())
      zip.once('error', done)
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

/** Extracts `archive` into the empty folder `destination`. */
export async function extractArchive(archive: string, destination: string, options: ExtractOptions): Promise<ExtractResult> {
  mkdirSync(destination, { recursive: true })
  const root = realpathSync(destination)
  const budget = new Budget(options.maxEntries ?? MAX_ARCHIVE_ENTRIES, options.maxBytes ?? MAX_EXPANDED_BYTES)
  options.signal?.throwIfAborted()
  if (options.format === 'zip') await extractZip(archive, root, options, budget)
  else await extractTar(archive, root, options, budget)
  return { files: budget.files, bytes: budget.bytes }
}

/** `<agentDir>/.staging-<random>`, created empty, with the owning process recorded in it. */
export function createStaging(agentDir: string): string {
  mkdirSync(agentDir, { recursive: true })
  const staging = join(agentDir, `.staging-${randomBytes(6).toString('hex')}`)
  mkdirSync(staging)
  return staging
}

/**
 * Extracts into `<staging>/dist` of a new staging folder and returns the staging folder. On any
 * failure or cancel the staging folder is gone before the error reaches the caller.
 */
export async function stageArchive(archive: string, agentDir: string, options: ExtractOptions): Promise<{ staging: string } & ExtractResult> {
  const staging = createStaging(agentDir)
  try {
    return { staging, ...(await extractArchive(archive, join(staging, 'dist'), options)) }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * The launch target `segments` under `root`: a regular file whose real path stays inside the root,
 * executable on POSIX. Throws a message the card can show otherwise.
 */
export function containedFile(root: string, segments: readonly string[], options: { executable?: boolean } = {}): string {
  const realRoot = realpathSync(root)
  const target = resolve(realRoot, ...segments)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new ArchiveError(`The download has no ${segments.join('/')}.`)
  }
  const rel = relative(realRoot, real)
  if (!rel || rel.startsWith('..') || resolve(realRoot, rel) !== real) throw new ArchiveError(`${segments.join('/')} is outside the install folder.`)
  if (!lstatSync(real).isFile()) throw new ArchiveError(`${segments.join('/')} is not a file.`)
  if (options.executable && process.platform !== 'win32') {
    try {
      accessSync(real, constants.X_OK)
    } catch {
      throw new ArchiveError(`${segments.join('/')} is not executable.`)
    }
  }
  return real
}
