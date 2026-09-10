import { createHash } from 'node:crypto'
import {
  canonicalizeJson,
  stableStringify,
  type WorkflowEditorDocument,
  type WorkflowManifest
} from '../../shared/workflows'

export interface AssetDigest {
  relativePath: string
  sha256: string
  bytes: number
}

const VISUAL_MANIFEST_KEYS = new Set(['ui', 'position', 'canvas', 'editor'])

/** Semantic hash covers canonical manifest bytes plus executable/instruction/schema assets. */
export function computeSemanticHash(
  manifest: WorkflowManifest,
  assets: readonly AssetDigest[]
): string {
  const semanticManifest = stripVisualManifestFields(manifest)
  const payload = {
    manifest: canonicalizeJson(semanticManifest),
    assets: [...assets]
      .map((asset) => ({
        relativePath: asset.relativePath.replace(/\\/g, '/'),
        sha256: asset.sha256
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }
  return sha256Utf8(stableStringify(payload))
}

export function computeVisualHash(editor: WorkflowEditorDocument | undefined): string {
  if (!editor) return sha256Utf8('{"schemaVersion":1}')
  return sha256Utf8(stableStringify(editor))
}

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  const hash = createHash('sha256')
  hash.update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
  return hash.digest('hex')
}

export function stripVisualManifestFields(manifest: WorkflowManifest): WorkflowManifest {
  const { nodes, ...rest } = manifest
  return {
    ...rest,
    nodes: nodes.map((node) => {
      const config = { ...node.config }
      for (const key of VISUAL_MANIFEST_KEYS) {
        delete config[key]
      }
      return { ...node, config }
    })
  }
}

export function digestAsset(relativePath: string, bytes: Uint8Array | string): AssetDigest {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  return {
    relativePath: relativePath.replace(/\\/g, '/'),
    sha256: sha256Bytes(buffer),
    bytes: buffer.byteLength
  }
}
