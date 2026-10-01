import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../data/AtomicFs'
import type { ArtifactReference } from '../../shared/execution/types'
import type { ArtifactStoreAdapter } from '../../shared/workflows'

export const ARTIFACT_MAX_BYTES = 100 * 1024 * 1024
export const ARTIFACT_METADATA_MAX_BYTES = 64 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

interface RetainedDirectory {
  path: string
  real: string
  dev: number
  ino: number
}

export interface ArtifactReadOptions {
  /** When options are supplied, run ownership is exact; omitted runId means an unowned artifact. */
  runId?: string
  maxBytes?: number
}

function samePath(left: string, right: string): boolean {
  const fold = process.platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value
  return fold(normalize(left)) === fold(normalize(right))
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function retainDirectory(path: string, label: string): RetainedDirectory {
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a regular directory`)
  return { path, real: realpathSync.native(path), dev: details.dev, ino: details.ino }
}

function assertRetainedDirectory(directory: RetainedDirectory, label: string): void {
  const details = lstatSync(directory.path)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} is not a regular directory`)
  if (details.dev !== directory.dev || details.ino !== directory.ino || !samePath(realpathSync.native(directory.path), directory.real)) {
    throw new Error(`${label} changed after initialization`)
  }
}

function assertDirectDirectory(path: string, root: RetainedDirectory, label: string): void {
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a regular directory`)
  const real = realpathSync.native(path)
  if (!isInside(root.real, real)) throw new Error(`${label} escapes the artifact root`)
}

function assertDirectFile(path: string, root: RetainedDirectory, label: string): void {
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular file`)
  const real = realpathSync.native(path)
  if (!isInside(root.real, real)) throw new Error(`${label} escapes the artifact root`)
}

function boundedFileRead(path: string, root: RetainedDirectory, label: string, maxBytes: number): Uint8Array {
  assertDirectFile(path, root, label)
  const before = statSync(path)
  if (!before.isFile()) throw new Error(`${label} must be a regular file`)
  if (!Number.isSafeInteger(before.size) || before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  const fd = openSync(path, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed while opening`)
    if (!Number.isSafeInteger(opened.size) || opened.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset)
      if (count === 0) throw new Error(`${label} changed while reading`)
      offset += count
    }
    const after = fstatSync(fd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`${label} changed while reading`)
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function boundedString(value: unknown, label: string, maxBytes: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Invalid artifact ${label}`)
  }
  return value
}

function parseReference(raw: Uint8Array, id: string): ArtifactReference {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    throw new Error('Invalid artifact metadata')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid artifact metadata')
  const item = value as Record<string, unknown>
  const refId = boundedString(item.id, 'id', 36)
  const profileId = boundedString(item.profileId, 'profileId', 256)
  const runId = boundedString(item.runId, 'runId', 512, true)
  const mediaType = boundedString(item.mediaType, 'mediaType', 256)
  const displayName = boundedString(item.displayName, 'displayName', 1024)
  const createdAt = boundedString(item.createdAt, 'createdAt', 64)
  if (refId !== id || !UUID.test(refId)) throw new Error('Artifact identity mismatch')
  if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0 || (item.byteLength as number) > ARTIFACT_MAX_BYTES) {
    throw new Error('Invalid artifact byteLength')
  }
  if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) throw new Error('Invalid artifact sha256')
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid artifact createdAt')
  return {
    id: refId,
    profileId: profileId!,
    ...(runId === undefined ? {} : { runId }),
    mediaType: mediaType!,
    byteLength: item.byteLength as number,
    sha256: item.sha256,
    displayName: displayName!,
    createdAt
  }
}

function readLimit(value: number | undefined): number {
  if (value === undefined) return ARTIFACT_MAX_BYTES
  if (!Number.isSafeInteger(value) || value < 0 || value > ARTIFACT_MAX_BYTES) {
    throw new Error(`Invalid artifact read limit; expected 0..${ARTIFACT_MAX_BYTES}`)
  }
  return value
}

export class FileArtifactStore implements ArtifactStoreAdapter {
  private readonly profileRoot: RetainedDirectory
  private readonly root: RetainedDirectory
  private readonly profileId: string

  constructor(options: { profileId: string; profileRoot: string }) {
    if (!options.profileId) throw new Error('FileArtifactStore requires profileId')
    boundedString(options.profileId, 'profileId', 256)
    if (!options.profileRoot || !isAbsolute(options.profileRoot)) throw new Error('FileArtifactStore requires an absolute profileRoot')
    this.profileId = options.profileId
    const profilePath = resolve(options.profileRoot)
    mkdirSync(profilePath, { recursive: true })
    this.profileRoot = retainDirectory(profilePath, 'Artifact profile root')
    const artifactPath = join(profilePath, 'artifacts')
    mkdirSync(artifactPath, { recursive: true })
    this.root = retainDirectory(artifactPath, 'Artifact root')
    if (!isInside(this.profileRoot.real, this.root.real)) throw new Error('Artifact root escapes the profile root')
  }

  async put(input: {
    profileId: string
    runId?: string
    bytes: Uint8Array
    mediaType: string
    displayName: string
  }): Promise<ArtifactReference> {
    if (input.profileId !== this.profileId) throw new Error('Artifact profile mismatch')
    if (!(input.bytes instanceof Uint8Array)) throw new Error('Artifact bytes must be a Uint8Array')
    if (input.bytes.byteLength > ARTIFACT_MAX_BYTES) throw new Error(`Artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`)
    const runId = boundedString(input.runId, 'runId', 512, true)
    const mediaType = boundedString(input.mediaType, 'mediaType', 256)!
    const displayName = boundedString(input.displayName, 'displayName', 1024)!
    this.assertRoots()
    const id = randomUUID()
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const dir = join(this.root.path, id)
    mkdirSync(dir)
    assertDirectDirectory(dir, this.root, 'Artifact record directory')
    atomicWriteFileSync(join(dir, 'blob'), input.bytes)
    const ref: ArtifactReference = {
      id,
      profileId: input.profileId,
      ...(runId === undefined ? {} : { runId }),
      mediaType,
      byteLength: input.bytes.byteLength,
      sha256,
      displayName,
      createdAt: new Date().toISOString()
    }
    atomicWriteFileSync(join(dir, 'meta.json'), `${JSON.stringify(ref, null, 2)}\n`)
    this.assertRoots()
    assertDirectDirectory(dir, this.root, 'Artifact record directory')
    assertDirectFile(join(dir, 'blob'), this.root, 'Artifact blob')
    assertDirectFile(join(dir, 'meta.json'), this.root, 'Artifact metadata')
    return ref
  }

  async get(
    id: string,
    profileId: string,
    options?: ArtifactReadOptions
  ): Promise<{ bytes: Uint8Array; ref: ArtifactReference }> {
    if (!UUID.test(id)) throw new Error('Invalid artifact id')
    if (arguments.length >= 3 && (options === null || typeof options !== 'object' || Array.isArray(options))) {
      throw new Error('Invalid artifact read options')
    }
    const maxBytes = readLimit(options?.maxBytes)
    this.assertRoots()
    const dir = join(this.root.path, id)
    try {
      assertDirectDirectory(dir, this.root, 'Artifact record directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Artifact ${id} not found`)
      throw error
    }
    const ref = parseReference(
      boundedFileRead(join(dir, 'meta.json'), this.root, 'Artifact metadata', ARTIFACT_METADATA_MAX_BYTES),
      id
    )
    if (profileId !== this.profileId || ref.profileId !== profileId) throw new Error('Artifact profile mismatch')
    if (arguments.length >= 3 && ref.runId !== options?.runId) throw new Error('Artifact run mismatch')
    if (ref.byteLength > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`)
    const blobPath = join(dir, 'blob')
    const blobDetails = lstatSync(blobPath)
    if (blobDetails.isSymbolicLink() || !blobDetails.isFile()) throw new Error('Artifact blob must be a regular file')
    if (blobDetails.size !== ref.byteLength) throw new Error('Artifact integrity mismatch')
    const bytes = boundedFileRead(blobPath, this.root, 'Artifact blob', maxBytes)
    if (bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new Error('Artifact integrity mismatch')
    }
    return { bytes, ref }
  }

  private assertRoots(): void {
    assertRetainedDirectory(this.profileRoot, 'Artifact profile root')
    assertRetainedDirectory(this.root, 'Artifact root')
    if (!isInside(this.profileRoot.real, this.root.real)) throw new Error('Artifact root escapes the profile root')
  }
}
