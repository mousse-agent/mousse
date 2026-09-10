export type MarkdownPreviewImageDecision = 'allow' | 'block'

const DATA_IMAGE_PATTERN = /^data:image\/[a-z0-9.+-]+(;|,)/i

/** True when a URL would trigger a network, protocol, or renderer-origin fetch. */
export function isExternalOrUnsafePreviewUrl(src: string | undefined | null): boolean {
  if (src == null) return true
  const trimmed = src.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('#')) return false
  if (DATA_IMAGE_PATTERN.test(trimmed)) return false
  if (/^data:/i.test(trimmed)) return true
  if (/^blob:/i.test(trimmed)) return true
  if (/^javascript:/i.test(trimmed)) return true
  if (/^vbscript:/i.test(trimmed)) return true
  if (/^file:/i.test(trimmed)) return true
  if (/^https?:/i.test(trimmed)) return true
  if (trimmed.startsWith('//')) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true
  return false
}

export function isSafePreviewHref(href: string | undefined | null): boolean {
  if (href == null) return false
  const trimmed = href.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#')) return true
  if (/^javascript:/i.test(trimmed)) return false
  if (/^vbscript:/i.test(trimmed)) return false
  if (/^data:/i.test(trimmed)) return false
  if (/^blob:/i.test(trimmed)) return false
  if (/^file:/i.test(trimmed)) return false
  if (/^https?:/i.test(trimmed)) return true
  if (trimmed.startsWith('//')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false
  return !trimmed.includes('://')
}

/**
 * Default preview policy: never load remote/file/blob images.
 * Relative markdown image paths are blocked unless a consumer supplies a resolver,
 * so FilesPanel preview cannot fetch from the renderer origin as a side effect.
 */
export function resolvePreviewImageSrc(
  src: string | undefined | null,
  allowRelative = false
): string | null {
  if (src == null) return null
  const trimmed = src.trim()
  if (!trimmed) return null
  if (DATA_IMAGE_PATTERN.test(trimmed)) return trimmed
  if (isExternalOrUnsafePreviewUrl(trimmed)) return null
  if (allowRelative && !trimmed.includes('://')) return trimmed
  return null
}

export function previewImageDecision(src: string | undefined | null): MarkdownPreviewImageDecision {
  return resolvePreviewImageSrc(src) ? 'allow' : 'block'
}

/** Exact source identity: view-mode switches must not rewrite document bytes. */
export function preserveMarkdownSource(value: string): string {
  return value
}
