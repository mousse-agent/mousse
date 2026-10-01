import type { WorkflowBundleAsset } from '../../../shared/workflows'

export function normalizeAssetPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function assetText(assets: readonly WorkflowBundleAsset[], relativePath: string): string {
  const path = normalizeAssetPath(relativePath)
  const asset = assets.find((item) => normalizeAssetPath(item.relativePath) === path)
  if (!asset) return ''
  if (typeof asset.bytes === 'string') return asset.bytes
  try {
    return new TextDecoder().decode(asset.bytes)
  } catch {
    return ''
  }
}

export function upsertAsset(
  assets: readonly WorkflowBundleAsset[],
  relativePath: string,
  text: string
): WorkflowBundleAsset[] {
  const path = normalizeAssetPath(relativePath)
  const next = assets.filter((item) => normalizeAssetPath(item.relativePath) !== path)
  next.push({ relativePath: path, bytes: text })
  next.sort((a, b) => normalizeAssetPath(a.relativePath).localeCompare(normalizeAssetPath(b.relativePath)))
  return next
}

export function removeAsset(assets: readonly WorkflowBundleAsset[], relativePath: string): WorkflowBundleAsset[] {
  const path = normalizeAssetPath(relativePath)
  return assets.filter((item) => normalizeAssetPath(item.relativePath) !== path)
}

export function cloneAssets(assets: readonly WorkflowBundleAsset[]): WorkflowBundleAsset[] {
  return assets.map((asset) => ({
    relativePath: asset.relativePath,
    bytes: asset.bytes,
    sha256: asset.sha256
  }))
}
