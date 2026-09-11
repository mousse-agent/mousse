import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactDir } from './lifecycle/paths'
import { requiredId } from './util'

export interface WrittenArtifact {
  artifactId: string
  byteLength: number
  sha256: string
  mediaType: string
}

export class ScopedArtifactWriter {
  constructor(private readonly artifactRoot: string) {}

  write(profileId: string, sessionId: string, bytes: Uint8Array, mediaType: string, extension: string): WrittenArtifact {
    const dir = artifactDir(this.artifactRoot, requiredId(profileId), requiredId(sessionId))
    mkdirSync(dir, { recursive: true })
    const artifactId = 'art_' + randomUUID()
    const file = join(dir, `${artifactId}.${extension}`)
    writeFileSync(file, bytes)
    return {
      artifactId,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType
    }
  }

  writeFile(profileId: string, sessionId: string, sourcePath: string, mediaType: string, displayName: string): WrittenArtifact {
    const bytes = readFileSync(sourcePath)
    const extension = displayName.includes('.') ? displayName.slice(displayName.lastIndexOf('.') + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'bin' : 'bin'
    return this.write(profileId, sessionId, bytes, mediaType, extension)
  }
}
