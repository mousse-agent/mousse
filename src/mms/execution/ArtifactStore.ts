import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteFileSync } from '../data/AtomicFs'
import type { ArtifactReference } from '../../shared/execution/types'
import type { ArtifactStoreAdapter } from '../../shared/workflows'

export class FileArtifactStore implements ArtifactStoreAdapter {
  private readonly root: string
  private readonly profileId: string

  constructor(options: { profileId: string; profileRoot: string }) {
    if (!options.profileId) throw new Error('FileArtifactStore requires profileId')
    this.profileId = options.profileId
    this.root = join(options.profileRoot, 'artifacts')
    mkdirSync(this.root, { recursive: true })
  }

  async put(input: {
    profileId: string
    runId: string
    bytes: Uint8Array
    mediaType: string
    displayName: string
  }): Promise<ArtifactReference> {
    if (input.profileId !== this.profileId) throw new Error('Artifact profile mismatch')
    const id = randomUUID()
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const dir = join(this.root, id)
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(join(dir, 'blob'), input.bytes)
    const ref: ArtifactReference = {
      id,
      profileId: input.profileId,
      runId: input.runId,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      sha256,
      displayName: input.displayName,
      createdAt: new Date().toISOString()
    }
    atomicWriteFileSync(join(dir, 'meta.json'), `${JSON.stringify(ref, null, 2)}\n`)
    return ref
  }

  async get(id: string, profileId: string): Promise<{ bytes: Uint8Array; ref: ArtifactReference }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('Invalid artifact id')
    }
    const dir = join(this.root, id)
    if (!existsSync(join(dir, 'meta.json'))) throw new Error(`Artifact ${id} not found`)
    const ref = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ArtifactReference
    if (ref.id !== id) throw new Error('Artifact identity mismatch')
    if (profileId !== this.profileId || ref.profileId !== profileId) throw new Error('Artifact profile mismatch')
    const bytes = new Uint8Array(readFileSync(join(dir, 'blob')))
    if (bytes.byteLength !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new Error('Artifact integrity mismatch')
    }
    return { bytes, ref }
  }
}
