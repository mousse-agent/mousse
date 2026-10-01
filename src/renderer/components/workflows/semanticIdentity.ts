import { canonicalizeJson, stableStringify, type WorkflowBundle, type WorkflowManifest } from '../../../shared/workflows'

const VISUAL_CONFIG_KEYS = new Set(['ui', 'position', 'canvas', 'editor'])

/** Strip canvas-only keys so layout/orb colors cannot change execution identity. */
export function stripVisualManifestFields(manifest: WorkflowManifest): WorkflowManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) => {
      const config = { ...node.config }
      for (const key of VISUAL_CONFIG_KEYS) delete config[key]
      return { ...node, config }
    })
  }
}

export function semanticIdentity(manifest: WorkflowManifest, assets?: WorkflowBundle['assets']): string {
  const payload = {
    manifest: canonicalizeJson(stripVisualManifestFields(manifest)),
    assets: [...(assets ?? [])]
      .map((asset) => ({
        relativePath: asset.relativePath.replace(/\\/g, '/'),
        bytes: typeof asset.bytes === 'string' ? asset.bytes : bytesToText(asset.bytes)
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }
  return stableStringify(payload)
}

export function visualIdentity(editor: WorkflowBundle['editor']): string {
  return stableStringify(canonicalizeJson(editor ?? { schemaVersion: 1 }))
}

export function isVisualOnlyChange(previous: WorkflowBundle, next: WorkflowBundle): boolean {
  const sameSemantic = semanticIdentity(previous.manifest, previous.assets) === semanticIdentity(next.manifest, next.assets)
  const sameVisual = visualIdentity(previous.editor) === visualIdentity(next.editor)
  return sameSemantic && !sameVisual
}

function bytesToText(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return Array.from(bytes).join(',')
  }
}
